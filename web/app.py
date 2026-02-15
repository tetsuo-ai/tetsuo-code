"""tetsuocode Web - AI coding assistant powered by Grok"""
import json
import os
import re
import time
import difflib
import hashlib
import subprocess
import mimetypes
import requests
from flask import Flask, render_template, request, Response, stream_with_context, jsonify, redirect

app = Flask(__name__)

# ── Config ──────────────────────────────────────

API_KEY = os.environ.get("XAI_API_KEY", "")
AUTH_PASSWORD = os.environ.get("TETSUO_PASSWORD", "")
WORKSPACE = os.path.abspath(os.environ.get("TETSUO_WORKSPACE", os.getcwd()))

FILE_EDIT_HISTORY = []  # [{path, old_content, new_content, tool, timestamp}]
MAX_UNDO_HISTORY = 50


def estimate_tokens(text):
    """Rough token estimate: ~4 chars per token."""
    return len(text) // 4


def _get_workspace_tree(max_files=200):
    """Return compact workspace file listing with sizes."""
    skip_dirs = {".git", "node_modules", "__pycache__", "dist", "build", ".next", "venv", ".venv", ".tox", "egg-info"}
    skip_ext = {".pyc", ".pyo", ".exe", ".dll", ".so", ".o", ".class", ".png", ".jpg", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".map"}
    files = []
    for root, dirs, filenames in os.walk(WORKSPACE):
        dirs[:] = sorted([d for d in dirs if d not in skip_dirs and not d.startswith(".")])
        for fn in sorted(filenames):
            ext = os.path.splitext(fn)[1].lower()
            if ext in skip_ext:
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, WORKSPACE).replace("\\", "/")
            try:
                size = os.path.getsize(full)
            except Exception:
                size = 0
            files.append({"path": rel, "size": size, "tokens": size // 4})
            if len(files) >= max_files:
                break
        if len(files) >= max_files:
            break
    return files


def _build_file_skeleton(path, content):
    """Build a skeleton summary of a file: imports + function/class signatures."""
    ext = os.path.splitext(path)[1].lower()
    lines = content.split("\n")
    parts = []

    # Imports
    import_lines = []
    for line in lines[:100]:
        stripped = line.strip()
        if (stripped.startswith("import ") or stripped.startswith("from ") or
            (stripped.startswith(("const ", "let ", "var ")) and "require" in stripped) or
            stripped.startswith("use ") or stripped.startswith("#include")):
            import_lines.append(line.rstrip())
    if import_lines:
        parts.append("\n".join(import_lines))

    # Symbols
    patterns = SYMBOL_PATTERNS.get(ext, SYMBOL_PATTERNS.get(".js", []))
    if ext in (".tsx", ".jsx", ".mjs"):
        patterns = SYMBOL_PATTERNS.get(".js", [])

    for i, line in enumerate(lines, 1):
        for pat, kind, group in patterns:
            m = re.match(pat, line)
            if m:
                try:
                    m.group(group)
                except IndexError:
                    continue
                parts.append(f"L{i}: [{kind}] {line.rstrip()}")

    return "\n".join(parts) if parts else "\n".join(lines[:30]) + "\n// ..."


# ── Security & Approval ──────────────────────────

PENDING_EDITS = {}  # {id: {path, old_content, new_content, diff, tool, timestamp}}
REQUIRE_APPROVAL = False
MCP_SERVERS = []  # [{name, url, tools}]
FILE_MTIMES = {}  # {path: mtime} for file watcher

DANGEROUS_PATTERNS = [
    "rm -rf /", "rm -rf ~", "rm -rf .", "mkfs.", "dd if=/dev", ":(){",
    "chmod -R 777 /", "git push --force", "git reset --hard",
    "DROP TABLE", "DROP DATABASE", "format c:", "> /dev/sda",
    "shutdown -h", "reboot", "init 0",
]


def _resolve_path(path):
    """Resolve path to absolute, ensure within workspace."""
    if not path:
        return None
    if not os.path.isabs(path):
        path = os.path.join(WORKSPACE, path)
    abs_path = os.path.abspath(path)
    if not abs_path.startswith(os.path.abspath(WORKSPACE)):
        return None
    return abs_path


def _is_dangerous(command):
    """Check for dangerous command patterns. Returns matched pattern or None."""
    cl = command.lower().strip()
    for p in DANGEROUS_PATTERNS:
        if p.lower() in cl:
            return p
    return None


def _convert_images_for_anthropic(content):
    """Convert OpenAI-format image content blocks to Anthropic format."""
    if isinstance(content, str):
        return content
    result = []
    for block in content:
        if block.get("type") == "text":
            result.append(block)
        elif block.get("type") == "image_url":
            url = block["image_url"]["url"]
            if url.startswith("data:"):
                parts = url.split(",", 1)
                header = parts[0]
                data = parts[1] if len(parts) > 1 else ""
                media_type = header.split(":")[1].split(";")[0]
                result.append({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}})
        else:
            result.append(block)
    return result if result else content


PROVIDERS = {
    "xai": {
        "name": "xAI (Grok)",
        "base_url": "https://api.x.ai/v1",
        "models": ["grok-4-1-fast-reasoning", "grok-3-fast", "grok-3", "grok-3-mini"],
        "env_key": "XAI_API_KEY",
        "format": "openai",
    },
    "openai": {
        "name": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "models": ["gpt-4o", "gpt-4o-mini", "o1", "o1-mini"],
        "env_key": "OPENAI_API_KEY",
        "format": "openai",
    },
    "anthropic": {
        "name": "Anthropic",
        "base_url": "https://api.anthropic.com/v1",
        "models": ["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"],
        "env_key": "ANTHROPIC_API_KEY",
        "format": "anthropic",
    },
    "ollama": {
        "name": "Ollama (Local)",
        "base_url": "http://localhost:11434/v1",
        "models": ["llama3", "codellama", "mistral", "deepseek-coder"],
        "env_key": "",
        "format": "openai",
    },
}

SYSTEM_PROMPT = """You are tetsuocode, an elite AI coding assistant. You are powered by Grok.

When responding:
- Be concise and direct.
- Use markdown for formatting.
- Include code blocks with language tags for syntax highlighting.
- Don't over-explain obvious things."""

TOOL_DEFINITIONS = [
    {"type": "function", "function": {
        "name": "read_file",
        "description": "Read the contents of a file at the given path.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "Path to the file"}
        }, "required": ["path"]},
    }},
    {"type": "function", "function": {
        "name": "write_file",
        "description": "Write content to a file, creating it if needed.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "Path to the file"},
            "content": {"type": "string", "description": "Content to write"},
        }, "required": ["path", "content"]},
    }},
    {"type": "function", "function": {
        "name": "edit_file",
        "description": "Make a surgical text replacement in a file. Finds old_string and replaces it with new_string.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "Path to the file"},
            "old_string": {"type": "string", "description": "Exact string to find"},
            "new_string": {"type": "string", "description": "Replacement string"},
        }, "required": ["path", "old_string", "new_string"]},
    }},
    {"type": "function", "function": {
        "name": "run_command",
        "description": "Execute a shell command and return output.",
        "parameters": {"type": "object", "properties": {
            "command": {"type": "string", "description": "Shell command to run"}
        }, "required": ["command"]},
    }},
    {"type": "function", "function": {
        "name": "list_files",
        "description": "List files in a directory tree.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "Directory path"},
            "max_depth": {"type": "number", "description": "Max depth (default 3)"},
        }},
    }},
    {"type": "function", "function": {
        "name": "grep_files",
        "description": "Search for a pattern across files.",
        "parameters": {"type": "object", "properties": {
            "pattern": {"type": "string", "description": "Regex pattern"},
            "path": {"type": "string", "description": "Directory to search"},
        }, "required": ["pattern"]},
    }},
]


# ── Auth ──────────────────────────────────────

@app.before_request
def check_auth():
    if not AUTH_PASSWORD:
        return
    if request.path in ("/api/auth",) or request.path.startswith("/static/"):
        return
    token = request.cookies.get("tetsuo_auth")
    expected = hashlib.sha256(AUTH_PASSWORD.encode()).hexdigest()
    if token != expected:
        if request.path.startswith("/api/"):
            return jsonify({"error": "unauthorized"}), 401
        # Let index.html load - it handles the login UI
        return


@app.route("/api/auth", methods=["POST"])
def auth():
    pw = request.json.get("password", "")
    expected = hashlib.sha256(AUTH_PASSWORD.encode()).hexdigest()
    given = hashlib.sha256(pw.encode()).hexdigest()
    if given == expected:
        resp = jsonify({"success": True})
        resp.set_cookie("tetsuo_auth", expected, httponly=True, samesite="Strict")
        return resp
    return jsonify({"error": "wrong password"}), 401


@app.route("/api/auth/check")
def auth_check():
    if not AUTH_PASSWORD:
        return jsonify({"required": False})
    token = request.cookies.get("tetsuo_auth")
    expected = hashlib.sha256(AUTH_PASSWORD.encode()).hexdigest()
    return jsonify({"required": True, "authenticated": token == expected})


# ── Diff ──────────────────────────────────────

def compute_diff(old_content, new_content, path):
    old_lines = old_content.splitlines(keepends=True)
    new_lines = new_content.splitlines(keepends=True)
    diff = difflib.unified_diff(old_lines, new_lines, fromfile=f"a/{path}", tofile=f"b/{path}", n=3)
    return "".join(diff)


# ── Tool Execution ──────────────────────────────

def execute_tool(name, args):
    if name == "read_file":
        path = args.get("path", "")
        resolved = _resolve_path(path)
        if resolved is None:
            return json.dumps({"error": "Access denied: path outside workspace"})
        path = resolved
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            if len(content) > 100000:
                content = content[:100000] + f"\n\n... [truncated, {len(content)} bytes]"
            return json.dumps({"content": content, "path": path})
        except Exception as e:
            return json.dumps({"error": str(e)})

    elif name == "write_file":
        path = args.get("path", "")
        content = args.get("content", "")
        resolved = _resolve_path(path)
        if resolved is None:
            return json.dumps({"error": "Access denied: path outside workspace"})
        path = resolved
        try:
            old_content = ""
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    old_content = f.read()
            except FileNotFoundError:
                pass
            diff = compute_diff(old_content, content, path)
            if REQUIRE_APPROVAL:
                edit_id = f"pe_{int(time.time()*1000)}"
                PENDING_EDITS[edit_id] = {"path": path, "old_content": old_content, "new_content": content, "diff": diff, "tool": "write_file", "timestamp": time.time()}
                return json.dumps({"pending": True, "pending_id": edit_id, "path": path, "diff": diff[:3000]})
            FILE_EDIT_HISTORY.append({"path": path, "old_content": old_content, "new_content": content, "tool": "write_file", "timestamp": time.time()})
            if len(FILE_EDIT_HISTORY) > MAX_UNDO_HISTORY:
                FILE_EDIT_HISTORY.pop(0)
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            return json.dumps({"success": True, "path": path, "diff": diff[:3000]})
        except Exception as e:
            return json.dumps({"error": str(e)})

    elif name == "edit_file":
        path = args.get("path", "")
        old_string = args.get("old_string", "")
        new_string = args.get("new_string", "")
        resolved = _resolve_path(path)
        if resolved is None:
            return json.dumps({"error": "Access denied: path outside workspace"})
        path = resolved
        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            count = content.count(old_string)
            if count == 0:
                return json.dumps({"error": "old_string not found in file"})
            if count > 1:
                return json.dumps({"error": f"old_string found {count} times, must be unique"})
            old_content = content
            content = content.replace(old_string, new_string, 1)
            diff = compute_diff(old_content, content, path)
            if REQUIRE_APPROVAL:
                edit_id = f"pe_{int(time.time()*1000)}"
                PENDING_EDITS[edit_id] = {"path": path, "old_content": old_content, "new_content": content, "diff": diff, "tool": "edit_file", "timestamp": time.time()}
                return json.dumps({"pending": True, "pending_id": edit_id, "path": path, "diff": diff[:3000]})
            FILE_EDIT_HISTORY.append({"path": path, "old_content": old_content, "new_content": content, "tool": "edit_file", "timestamp": time.time()})
            if len(FILE_EDIT_HISTORY) > MAX_UNDO_HISTORY:
                FILE_EDIT_HISTORY.pop(0)
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            return json.dumps({"success": True, "path": path, "diff": diff[:3000]})
        except Exception as e:
            return json.dumps({"error": str(e)})

    elif name == "run_command":
        command = args.get("command", "")
        danger = _is_dangerous(command)
        if danger:
            return json.dumps({"error": f"Blocked: dangerous pattern '{danger}' detected. Disable safety in settings to override."})
        try:
            result = subprocess.run(
                command, shell=True, capture_output=True, text=True, timeout=30
            )
            out = result.stdout
            if len(out) > 50000:
                out = out[:50000] + "\n... [truncated]"
            return json.dumps({"stdout": out, "stderr": result.stderr, "exit_code": result.returncode})
        except subprocess.TimeoutExpired:
            return json.dumps({"error": "Command timed out"})
        except Exception as e:
            return json.dumps({"error": str(e)})

    elif name == "list_files":
        path = args.get("path", ".")
        max_depth = int(args.get("max_depth", 3))
        try:
            files = []
            for root, dirs, filenames in os.walk(path):
                depth = root.replace(path, "").count(os.sep)
                if depth >= max_depth:
                    dirs.clear()
                    continue
                dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__")]
                for fn in filenames:
                    files.append(os.path.join(root, fn))
                if len(files) > 500:
                    break
            return json.dumps({"files": files[:500], "count": len(files)})
        except Exception as e:
            return json.dumps({"error": str(e)})

    elif name == "grep_files":
        pattern = args.get("pattern", "")
        path = args.get("path", ".")
        try:
            result = subprocess.run(
                ["rg", "--no-heading", "--line-number", "--max-count", "50", pattern, path],
                capture_output=True, text=True, timeout=10,
            )
            matches = [l for l in result.stdout.splitlines() if l.strip()][:50]
            return json.dumps({"matches": matches, "count": len(matches)})
        except FileNotFoundError:
            try:
                result = subprocess.run(
                    f'grep -rn --max-count=50 "{pattern}" "{path}"',
                    shell=True, capture_output=True, text=True, timeout=10,
                )
                matches = [l for l in result.stdout.splitlines() if l.strip()][:50]
                return json.dumps({"matches": matches, "count": len(matches)})
            except Exception as e:
                return json.dumps({"error": str(e)})
        except Exception as e:
            return json.dumps({"error": str(e)})

    return json.dumps({"error": f"Unknown tool: {name}"})


# ── Anthropic Helpers ──────────────────────────

def convert_tools_for_anthropic(tools):
    return [
        {"name": t["function"]["name"], "description": t["function"]["description"],
         "input_schema": t["function"]["parameters"]}
        for t in tools
    ]


def convert_messages_for_anthropic(messages):
    system = ""
    result = []
    for msg in messages:
        if msg["role"] == "system":
            system = msg["content"]
            continue
        if msg["role"] == "tool":
            block = {"type": "tool_result", "tool_use_id": msg["tool_call_id"], "content": msg["content"]}
            if result and result[-1]["role"] == "user":
                c = result[-1]["content"]
                if isinstance(c, str):
                    result[-1]["content"] = [{"type": "text", "text": c}, block]
                else:
                    c.append(block)
            else:
                result.append({"role": "user", "content": [block]})
            continue
        if msg["role"] == "assistant" and msg.get("tool_calls"):
            content = []
            if msg.get("content"):
                content.append({"type": "text", "text": msg["content"]})
            for tc in msg["tool_calls"]:
                try:
                    inp = json.loads(tc["function"]["arguments"])
                except (json.JSONDecodeError, KeyError):
                    inp = {}
                content.append({"type": "tool_use", "id": tc["id"], "name": tc["function"]["name"], "input": inp})
            result.append({"role": "assistant", "content": content})
            continue
        content = msg["content"]
        if isinstance(content, list):
            content = _convert_images_for_anthropic(content)
        result.append({"role": msg["role"], "content": content})
    return system, result


# ── Chat Endpoint ──────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.json
    messages = data.get("messages", [])
    model = data.get("model", "grok-4-1-fast-reasoning")
    temperature = data.get("temperature", 0.7)
    max_tokens = data.get("max_tokens", 4096)
    custom_system = data.get("system_prompt", "")
    provider_id = data.get("provider", "xai")
    user_api_key = data.get("api_key", "")

    provider = PROVIDERS.get(provider_id, PROVIDERS["xai"])

    # Resolve API key
    api_key = user_api_key or os.environ.get(provider.get("env_key", ""), "") or API_KEY
    if not api_key and provider_id != "ollama":
        pname = provider["name"]
        env_key = provider.get("env_key", "")
        err_msg = f"No API key configured for {pname}. Set {env_key} or enter a key in settings."
        return Response(
            f"data: {json.dumps({'type': 'error', 'content': err_msg})}\n\n",
            mimetype="text/event-stream",
        )

    context_mode = data.get("context_mode", "smart")
    sys_prompt = custom_system if custom_system else SYSTEM_PROMPT

    # Lazy mode: inject workspace file listing so the model uses read_file tool
    if context_mode == "lazy":
        tree_files = _get_workspace_tree(150)
        file_list = "\n".join(f"  {f['path']} (~{f['tokens']} tokens)" for f in tree_files)
        sys_prompt += (
            "\n\nYou have access to this workspace. Use the read_file tool to access any file you need. "
            "Do NOT ask the user to paste file contents — read them yourself.\n\n"
            f"Workspace files:\n{file_list}"
        )

    full_messages = [{"role": "system", "content": sys_prompt}] + messages

    def generate():
        nonlocal full_messages
        iteration = 0
        max_iterations = 10

        try:
          while iteration < max_iterations:
            iteration += 1

            if provider["format"] == "anthropic":
                yield from _stream_anthropic(api_key, full_messages, model, temperature, max_tokens)
                return

            # OpenAI-compatible path
            base_url = provider["base_url"]
            body = {
                "model": model,
                "messages": full_messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "stream": True,
                "tools": TOOL_DEFINITIONS,
                "tool_choice": "auto",
            }

            resp = requests.post(
                f"{base_url}/chat/completions",
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
                json=body, stream=True, timeout=120,
            )
            resp.encoding = "utf-8"

            if resp.status_code != 200:
                error_msg = f"API error {resp.status_code}"
                try:
                    err_data = resp.json()
                    if "error" in err_data:
                        error_msg = err_data["error"].get("message", error_msg)
                except Exception:
                    pass
                if api_key:
                    error_msg = error_msg.replace(api_key, "[REDACTED]")
                yield f"data: {json.dumps({'type': 'error', 'content': error_msg})}\n\n"
                return

            content_buffer = ""
            tool_calls = {}
            finish_reason = None

            for line in resp.iter_lines(decode_unicode=True):
                if not line:
                    continue
                if line.startswith("data: "):
                    payload = line[6:]
                    if payload.strip() == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except json.JSONDecodeError:
                        continue

                    if "error" in chunk:
                        yield f"data: {json.dumps({'type': 'error', 'content': chunk['error'].get('message', 'Unknown error')})}\n\n"
                        return

                    choices = chunk.get("choices", [])
                    if not choices:
                        continue
                    choice = choices[0]
                    delta = choice.get("delta", {})
                    finish_reason = choice.get("finish_reason") or finish_reason

                    if delta.get("content"):
                        content_buffer += delta["content"]
                        yield f"data: {json.dumps({'type': 'content', 'content': delta['content']})}\n\n"

                    if delta.get("tool_calls"):
                        for tc in delta["tool_calls"]:
                            idx = tc["index"]
                            if idx not in tool_calls:
                                tool_calls[idx] = {"id": tc.get("id", ""), "function": {"name": "", "arguments": ""}}
                            if tc.get("id"):
                                tool_calls[idx]["id"] = tc["id"]
                            if tc.get("function", {}).get("name"):
                                tool_calls[idx]["function"]["name"] += tc["function"]["name"]
                            if tc.get("function", {}).get("arguments"):
                                tool_calls[idx]["function"]["arguments"] += tc["function"]["arguments"]

                    if chunk.get("usage"):
                        yield f"data: {json.dumps({'type': 'usage', 'usage': chunk['usage']})}\n\n"

            if finish_reason == "tool_calls" and tool_calls:
                sorted_calls = [tool_calls[k] for k in sorted(tool_calls.keys())]
                assistant_msg = {"role": "assistant", "content": content_buffer or None}
                assistant_msg["tool_calls"] = [
                    {"id": tc["id"], "type": "function", "function": tc["function"]}
                    for tc in sorted_calls
                ]
                full_messages.append(assistant_msg)

                for tc in sorted_calls:
                    name = tc["function"]["name"]
                    try:
                        args = json.loads(tc["function"]["arguments"])
                    except json.JSONDecodeError:
                        args = {}
                    yield f"data: {json.dumps({'type': 'tool_call', 'name': name, 'args': tc['function']['arguments'][:200]})}\n\n"
                    result = execute_tool(name, args)
                    yield f"data: {json.dumps({'type': 'tool_result', 'name': name, 'result': result[:500]})}\n\n"
                    full_messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result})

                content_buffer = ""
                tool_calls = {}
                finish_reason = None
                continue

            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            return

          yield f"data: {json.dumps({'type': 'error', 'content': 'Max tool iterations reached'})}\n\n"

        except requests.exceptions.ConnectionError:
            yield f"data: {json.dumps({'type': 'error', 'content': 'Connection failed - check your network'})}\n\n"
        except requests.exceptions.Timeout:
            yield f"data: {json.dumps({'type': 'error', 'content': 'Request timed out'})}\n\n"
        except Exception as e:
            msg = str(e)
            if api_key:
                msg = msg.replace(api_key, "[REDACTED]")
            yield f"data: {json.dumps({'type': 'error', 'content': f'Unexpected error: {msg}'})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _stream_anthropic(api_key, full_messages, model, temperature, max_tokens):
    """Anthropic streaming with tool loop."""
    system, anthropic_msgs = convert_messages_for_anthropic(full_messages)
    anthropic_tools = convert_tools_for_anthropic(TOOL_DEFINITIONS)

    for iteration in range(10):
        body = {"model": model, "max_tokens": max_tokens, "messages": anthropic_msgs,
                "tools": anthropic_tools, "stream": True}
        if system:
            body["system"] = system
        if temperature is not None:
            body["temperature"] = temperature

        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={"Content-Type": "application/json", "x-api-key": api_key,
                     "anthropic-version": "2023-06-01"},
            json=body, stream=True, timeout=120,
        )
        resp.encoding = "utf-8"

        if resp.status_code != 200:
            error_msg = f"Anthropic API error {resp.status_code}"
            try:
                err = resp.json()
                error_msg = err.get("error", {}).get("message", error_msg)
            except Exception:
                pass
            if api_key:
                error_msg = error_msg.replace(api_key, "[REDACTED]")
            yield f"data: {json.dumps({'type': 'error', 'content': error_msg})}\n\n"
            return

        content_buffer = ""
        tool_calls = {}
        stop_reason = None
        current_event = None

        for line in resp.iter_lines(decode_unicode=True):
            if not line:
                continue
            if line.startswith("event: "):
                current_event = line[7:]
                continue
            if not line.startswith("data: "):
                continue
            try:
                data = json.loads(line[6:])
            except json.JSONDecodeError:
                continue

            if current_event == "content_block_start":
                block = data.get("content_block", {})
                if block.get("type") == "tool_use":
                    idx = data["index"]
                    tool_calls[idx] = {"id": block["id"], "name": block["name"], "arguments": ""}
                    yield f"data: {json.dumps({'type': 'tool_call', 'name': block['name'], 'args': ''})}\n\n"

            elif current_event == "content_block_delta":
                delta = data.get("delta", {})
                if delta.get("type") == "text_delta":
                    content_buffer += delta["text"]
                    yield f"data: {json.dumps({'type': 'content', 'content': delta['text']})}\n\n"
                elif delta.get("type") == "input_json_delta":
                    idx = data["index"]
                    if idx in tool_calls:
                        tool_calls[idx]["arguments"] += delta.get("partial_json", "")

            elif current_event == "message_delta":
                stop_reason = data.get("delta", {}).get("stop_reason")
                usage = data.get("usage", {})
                if usage:
                    yield f"data: {json.dumps({'type': 'usage', 'usage': {'prompt_tokens': 0, 'completion_tokens': usage.get('output_tokens', 0), 'total_tokens': usage.get('output_tokens', 0)}})}\n\n"

            elif current_event == "message_start":
                usage = data.get("message", {}).get("usage", {})
                if usage:
                    yield f"data: {json.dumps({'type': 'usage', 'usage': {'prompt_tokens': usage.get('input_tokens', 0), 'completion_tokens': 0, 'total_tokens': usage.get('input_tokens', 0)}})}\n\n"

        if stop_reason == "tool_use" and tool_calls:
            sorted_calls = [tool_calls[k] for k in sorted(tool_calls.keys())]

            # Build assistant message in Anthropic format
            assistant_content = []
            if content_buffer:
                assistant_content.append({"type": "text", "text": content_buffer})
            for tc in sorted_calls:
                try:
                    inp = json.loads(tc["arguments"])
                except (json.JSONDecodeError, KeyError):
                    inp = {}
                assistant_content.append({"type": "tool_use", "id": tc["id"], "name": tc["name"], "input": inp})
            anthropic_msgs.append({"role": "assistant", "content": assistant_content})

            # Execute tools
            tool_results = []
            for tc in sorted_calls:
                try:
                    args = json.loads(tc["arguments"])
                except (json.JSONDecodeError, KeyError):
                    args = {}
                result = execute_tool(tc["name"], args)
                yield f"data: {json.dumps({'type': 'tool_result', 'name': tc['name'], 'result': result[:500]})}\n\n"
                tool_results.append({"type": "tool_result", "tool_use_id": tc["id"], "content": result})
            anthropic_msgs.append({"role": "user", "content": tool_results})

            content_buffer = ""
            tool_calls = {}
            stop_reason = None
            continue

        yield f"data: {json.dumps({'type': 'done'})}\n\n"
        return

    yield f"data: {json.dumps({'type': 'error', 'content': 'Max tool iterations reached'})}\n\n"


# ── File Browser ──────────────────────────────

@app.route("/api/files/list")
def list_dir():
    path = request.args.get("path", WORKSPACE)
    try:
        entries = []
        for item in sorted(os.listdir(path)):
            if item.startswith(".") and item not in (".env", ".gitignore", ".tetsuorc"):
                continue
            if item in ("node_modules", "__pycache__", ".git", "dist", "build", "__pycache__"):
                continue
            full = os.path.join(path, item)
            entries.append({
                "name": item,
                "path": full.replace("\\", "/"),
                "type": "dir" if os.path.isdir(full) else "file",
            })
        return jsonify({"entries": entries, "path": path.replace("\\", "/")})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/files/read")
def read_file_api():
    path = request.args.get("path", "")
    try:
        # Check if it's an image
        mime, _ = mimetypes.guess_type(path)
        if mime and mime.startswith("image/"):
            import base64
            with open(path, "rb") as f:
                data = base64.b64encode(f.read()).decode()
            return jsonify({"image": True, "mime": mime, "data": data, "path": path})

        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        if len(content) > 200000:
            content = content[:200000] + f"\n\n... [truncated]"
        ext = os.path.splitext(path)[1].lstrip(".")
        return jsonify({"content": content, "path": path, "extension": ext})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ── File Upload ──────────────────────────────

@app.route("/api/upload", methods=["POST"])
def upload():
    if "file" not in request.files:
        return jsonify({"error": "no file"}), 400
    f = request.files["file"]
    mime = f.content_type or ""
    if mime.startswith("image/"):
        import base64
        data = base64.b64encode(f.read()).decode()
        return jsonify({"filename": f.filename, "image": True, "mime": mime, "data": data})
    content = f.read().decode("utf-8", errors="replace")
    return jsonify({"filename": f.filename, "content": content})


# ── Workspace ──────────────────────────────

@app.route("/api/workspace", methods=["GET", "POST"])
def workspace():
    global WORKSPACE
    if request.method == "POST":
        new_path = request.json.get("path", "")
        new_path = os.path.abspath(new_path)
        if os.path.isdir(new_path):
            WORKSPACE = new_path
            return jsonify({"workspace": WORKSPACE.replace("\\", "/")})
        return jsonify({"error": "directory not found"}), 400
    return jsonify({"workspace": WORKSPACE.replace("\\", "/")})


# ── Providers ──────────────────────────────

@app.route("/api/providers")
def providers():
    result = {}
    for pid, p in PROVIDERS.items():
        result[pid] = {
            "name": p["name"],
            "models": p["models"],
            "has_key": bool(os.environ.get(p["env_key"], "")) if p["env_key"] else pid == "ollama",
        }
    return jsonify(result)


@app.route("/api/models")
def models():
    return {"models": ["grok-4-1-fast-reasoning", "grok-3-fast", "grok-3", "grok-3-mini"]}


# ── Terminal ──────────────────────────────

@app.route("/api/terminal", methods=["POST"])
def terminal():
    command = request.json.get("command", "")
    cwd = request.json.get("cwd", WORKSPACE)
    try:
        result = subprocess.run(
            command, shell=True, capture_output=True, text=True, timeout=30, cwd=cwd
        )
        out = result.stdout + result.stderr
        if len(out) > 50000:
            out = out[:50000] + "\n... [truncated]"
        return jsonify({"output": out, "exit_code": result.returncode})
    except subprocess.TimeoutExpired:
        return jsonify({"output": "Command timed out", "exit_code": -1})
    except Exception as e:
        return jsonify({"output": str(e), "exit_code": -1})


# ── Git ──────────────────────────────

@app.route("/api/git/status")
def git_status():
    try:
        branch = subprocess.run(
            ["git", "branch", "--show-current"], capture_output=True, text=True, timeout=5, cwd=WORKSPACE
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain"], capture_output=True, text=True, timeout=5, cwd=WORKSPACE
        ).stdout
        files = []
        for line in status.splitlines():
            if len(line) >= 4:
                xy = line[:2]
                path = line[3:]
                staged = xy[0] not in (" ", "?")
                files.append({"path": path, "status": xy.strip(), "staged": staged})
        return jsonify({"branch": branch, "files": files})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/git/diff")
def git_diff():
    path = request.args.get("path", "")
    try:
        result = subprocess.run(
            ["git", "diff", "--", path] if path else ["git", "diff"],
            capture_output=True, text=True, timeout=10, cwd=WORKSPACE
        )
        staged = subprocess.run(
            ["git", "diff", "--cached", "--", path] if path else ["git", "diff", "--cached"],
            capture_output=True, text=True, timeout=10, cwd=WORKSPACE
        )
        return jsonify({"diff": result.stdout + staged.stdout})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/git/stage", methods=["POST"])
def git_stage():
    files = request.json.get("files", [])
    try:
        subprocess.run(["git", "add"] + files, capture_output=True, text=True, timeout=10, cwd=WORKSPACE)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/git/unstage", methods=["POST"])
def git_unstage():
    files = request.json.get("files", [])
    try:
        subprocess.run(["git", "reset", "HEAD"] + files, capture_output=True, text=True, timeout=10, cwd=WORKSPACE)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/git/commit", methods=["POST"])
def git_commit():
    message = request.json.get("message", "")
    if not message:
        return jsonify({"error": "commit message required"}), 400
    try:
        result = subprocess.run(
            ["git", "commit", "-m", message], capture_output=True, text=True, timeout=15, cwd=WORKSPACE
        )
        return jsonify({"output": result.stdout + result.stderr, "exit_code": result.returncode})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/git/push", methods=["POST"])
def git_push():
    try:
        result = subprocess.run(
            ["git", "push"], capture_output=True, text=True, timeout=30, cwd=WORKSPACE
        )
        return jsonify({"output": result.stdout + result.stderr, "exit_code": result.returncode})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ── File Save ──────────────────────────────

@app.route("/api/files/save", methods=["POST"])
def save_file():
    path = request.json.get("path", "")
    content = request.json.get("content", "")
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return jsonify({"success": True, "path": path})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ── File Search ──────────────────────────────

@app.route("/api/files/search")
def search_files():
    query = request.args.get("q", "").lower()
    if not query:
        return jsonify({"files": []})
    results = []
    skip_dirs = {".git", "node_modules", "__pycache__", "dist", "build", ".next", "venv", ".venv", ".tox", "egg-info"}
    for root, dirs, filenames in os.walk(WORKSPACE):
        dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith(".")]
        for fn in filenames:
            if query in fn.lower():
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, WORKSPACE).replace("\\", "/")
                results.append({"name": fn, "path": full.replace("\\", "/"), "rel": rel})
                if len(results) >= 50:
                    break
        if len(results) >= 50:
            break
    return jsonify({"files": results})


# ── Undo ──────────────────────────────

@app.route("/api/files/undo", methods=["POST"])
def undo_file_edit():
    if not FILE_EDIT_HISTORY:
        return jsonify({"error": "Nothing to undo"}), 400
    entry = FILE_EDIT_HISTORY.pop()
    try:
        with open(entry["path"], "w", encoding="utf-8") as f:
            f.write(entry["old_content"])
        return jsonify({"success": True, "path": entry["path"], "action": f"Reverted {entry['tool']} on {os.path.basename(entry['path'])}"})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/files/history")
def file_edit_history():
    return jsonify({"history": [
        {"path": h["path"], "tool": h["tool"], "timestamp": h["timestamp"]}
        for h in FILE_EDIT_HISTORY[-20:]
    ]})


# ── Workspace Grep ──────────────────────────────

@app.route("/api/files/grep")
def grep_workspace():
    query = request.args.get("q", "")
    is_regex = request.args.get("regex", "false") == "true"
    case_sensitive = request.args.get("case", "false") == "true"
    if not query:
        return jsonify({"results": []})
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        pattern = re.compile(query if is_regex else re.escape(query), flags)
    except re.error:
        return jsonify({"error": "Invalid regex"}), 400
    results = []
    skip_dirs = {".git", "node_modules", "__pycache__", "dist", "build", ".next", "venv", ".venv"}
    skip_ext = {".pyc", ".pyo", ".exe", ".dll", ".so", ".o", ".class", ".png", ".jpg", ".gif", ".ico", ".woff", ".woff2", ".ttf"}
    for root, dirs, filenames in os.walk(WORKSPACE):
        dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith(".")]
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            if ext in skip_ext:
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, WORKSPACE).replace("\\", "/")
            try:
                with open(full, "r", encoding="utf-8", errors="replace") as f:
                    for i, line in enumerate(f, 1):
                        if pattern.search(line):
                            results.append({"file": rel, "path": full.replace("\\", "/"), "line": i, "text": line.rstrip()[:200]})
                            if len(results) >= 200:
                                break
            except Exception:
                continue
            if len(results) >= 200:
                break
        if len(results) >= 200:
            break
    return jsonify({"results": results, "count": len(results)})


@app.route("/api/files/replace", methods=["POST"])
def replace_in_files():
    data = request.json
    query = data.get("query", "")
    replacement = data.get("replacement", "")
    is_regex = data.get("regex", False)
    case_sensitive = data.get("case", False)
    target_files = data.get("files", [])
    if not query:
        return jsonify({"error": "No search query"}), 400
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        pattern = re.compile(query if is_regex else re.escape(query), flags)
    except re.error:
        return jsonify({"error": "Invalid regex"}), 400
    if not target_files:
        skip_dirs = {".git", "node_modules", "__pycache__", "dist", "build"}
        skip_ext = {".pyc", ".pyo", ".exe", ".dll", ".so", ".png", ".jpg", ".gif"}
        target_files = []
        for root, dirs, filenames in os.walk(WORKSPACE):
            dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith(".")]
            for fn in filenames:
                if os.path.splitext(fn)[1].lower() not in skip_ext:
                    target_files.append(os.path.join(root, fn).replace("\\", "/"))
    replaced_count = 0
    files_changed = []
    for fpath in target_files:
        try:
            with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            new_content, count = pattern.subn(replacement, content)
            if count > 0:
                FILE_EDIT_HISTORY.append({"path": fpath, "old_content": content, "new_content": new_content, "tool": "replace", "timestamp": time.time()})
                if len(FILE_EDIT_HISTORY) > MAX_UNDO_HISTORY:
                    FILE_EDIT_HISTORY.pop(0)
                with open(fpath, "w", encoding="utf-8") as f:
                    f.write(new_content)
                replaced_count += count
                files_changed.append(fpath)
        except Exception:
            continue
    return jsonify({"replaced": replaced_count, "files": len(files_changed), "changed": files_changed})


# ── Symbol Parsing ──────────────────────────────

SYMBOL_PATTERNS = {
    ".py": [(r"^\s*(async\s+)?def\s+(\w+)", "function", 2), (r"^\s*class\s+(\w+)", "class", 1)],
    ".js": [(r"^\s*(?:async\s+)?function\s+(\w+)", "function", 1), (r"^\s*class\s+(\w+)", "class", 1),
            (r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(", "function", 1),
            (r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function", "function", 1)],
    ".ts": [(r"^\s*(?:async\s+)?function\s+(\w+)", "function", 1), (r"^\s*class\s+(\w+)", "class", 1),
            (r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(", "function", 1),
            (r"^\s*interface\s+(\w+)", "interface", 1), (r"^\s*type\s+(\w+)", "type", 1)],
    ".go": [(r"^func\s+(?:\(.*?\)\s+)?(\w+)", "function", 1), (r"^type\s+(\w+)\s+struct", "class", 1),
            (r"^type\s+(\w+)\s+interface", "interface", 1)],
    ".rs": [(r"^\s*(?:pub\s+)?fn\s+(\w+)", "function", 1), (r"^\s*(?:pub\s+)?struct\s+(\w+)", "class", 1),
            (r"^\s*(?:pub\s+)?enum\s+(\w+)", "enum", 1), (r"^\s*impl\s+(\w+)", "impl", 1)],
    ".rb": [(r"^\s*def\s+(\w+)", "function", 1), (r"^\s*class\s+(\w+)", "class", 1), (r"^\s*module\s+(\w+)", "module", 1)],
    ".java": [(r"^\s*(?:public|private|protected)?\s*(?:static\s+)?[\w<>\[\]]+\s+(\w+)\s*\(", "function", 1),
              (r"^\s*(?:public\s+)?class\s+(\w+)", "class", 1)],
}

@app.route("/api/files/symbols")
def file_symbols():
    path = request.args.get("path", "")
    if not path:
        return jsonify({"symbols": []})
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    ext = os.path.splitext(path)[1].lower()
    patterns = SYMBOL_PATTERNS.get(ext, SYMBOL_PATTERNS.get(".js", []))
    # Also try tsx/jsx as js
    if ext in (".tsx", ".jsx", ".mjs"):
        patterns = SYMBOL_PATTERNS.get(".js", [])
    symbols = []
    seen = set()
    for i, line in enumerate(lines, 1):
        for pat, kind, group in patterns:
            m = re.match(pat, line)
            if m:
                try:
                    name = m.group(group)
                except IndexError:
                    continue
                indent = len(line) - len(line.lstrip())
                key = f"{name}:{i}"
                if key not in seen:
                    seen.add(key)
                    symbols.append({"name": name, "kind": kind, "line": i, "indent": indent})
    return jsonify({"symbols": symbols})


# ── Rename Symbol ──────────────────────────────

@app.route("/api/files/rename-symbol", methods=["POST"])
def rename_symbol():
    data = request.json
    old_name = data.get("old_name", "")
    new_name = data.get("new_name", "")
    if not old_name or not new_name:
        return jsonify({"error": "Both old_name and new_name required"}), 400
    pattern = re.compile(r'\b' + re.escape(old_name) + r'\b')
    replaced_count = 0
    files_changed = []
    skip_dirs = {".git", "node_modules", "__pycache__", "dist", "build", ".venv", "venv"}
    skip_ext = {".pyc", ".pyo", ".exe", ".dll", ".so", ".png", ".jpg", ".gif", ".ico"}
    for root, dirs, filenames in os.walk(WORKSPACE):
        dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith(".")]
        for fn in filenames:
            if os.path.splitext(fn)[1].lower() in skip_ext:
                continue
            fpath = os.path.join(root, fn).replace("\\", "/")
            try:
                with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                new_content, count = pattern.subn(new_name, content)
                if count > 0:
                    FILE_EDIT_HISTORY.append({"path": fpath, "old_content": content, "new_content": new_content, "tool": "rename", "timestamp": time.time()})
                    if len(FILE_EDIT_HISTORY) > MAX_UNDO_HISTORY:
                        FILE_EDIT_HISTORY.pop(0)
                    with open(fpath, "w", encoding="utf-8") as f:
                        f.write(new_content)
                    replaced_count += count
                    files_changed.append({"path": fpath, "count": count})
            except Exception:
                continue
    return jsonify({"replaced": replaced_count, "files": len(files_changed), "changed": files_changed})


# ── File Summary ──────────────────────────────

@app.route("/api/files/summary")
def file_summary():
    path = request.args.get("path", "")
    if not path:
        return jsonify({"error": "path required"}), 400
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        total_lines = content.count("\n") + 1
        total_tokens = estimate_tokens(content)
        skeleton = _build_file_skeleton(path, content)
        return jsonify({
            "path": path,
            "total_lines": total_lines,
            "total_tokens": total_tokens,
            "skeleton": skeleton,
            "skeleton_tokens": estimate_tokens(skeleton),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ── File Chunk ──────────────────────────────

@app.route("/api/files/chunk")
def file_chunk():
    path = request.args.get("path", "")
    center_line = int(request.args.get("line", 0))
    ctx_lines = int(request.args.get("context", 50))
    pattern = request.args.get("pattern", "")
    if not path:
        return jsonify({"error": "path required"}), 400
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        chunks = []
        if center_line > 0:
            start = max(0, center_line - ctx_lines - 1)
            end = min(len(lines), center_line + ctx_lines)
            chunks.append({"start": start + 1, "end": end, "text": "".join(lines[start:end])})
        if pattern:
            try:
                pat = re.compile(pattern, re.IGNORECASE)
                for i, line in enumerate(lines):
                    if pat.search(line):
                        s = max(0, i - 10)
                        e = min(len(lines), i + 10)
                        chunks.append({"start": s + 1, "end": e, "text": "".join(lines[s:e]), "match_line": i + 1})
                        if len(chunks) >= 10:
                            break
            except re.error:
                pass
        if not chunks and not center_line and not pattern:
            chunks.append({"start": 1, "end": min(len(lines), ctx_lines), "text": "".join(lines[:ctx_lines])})
        return jsonify({"path": path, "total_lines": len(lines), "chunks": chunks})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ── Workspace Tree ──────────────────────────────

@app.route("/api/files/tree")
def workspace_tree():
    max_files = int(request.args.get("max", 200))
    files = _get_workspace_tree(max_files)
    return jsonify({"files": files, "workspace": WORKSPACE.replace("\\", "/")})


# ── Context Budget Estimation ──────────────────────

@app.route("/api/context/estimate", methods=["POST"])
def estimate_context():
    data = request.json
    msgs = data.get("messages", [])
    model = data.get("model", "grok-3")
    limits = {
        "grok-4-1-fast-reasoning": 131072, "grok-3-fast": 131072, "grok-3": 131072, "grok-3-mini": 131072,
        "gpt-4o": 128000, "gpt-4o-mini": 128000, "o1": 200000, "o1-mini": 128000,
        "claude-sonnet-4-5-20250929": 200000, "claude-haiku-4-5-20251001": 200000,
    }
    limit = limits.get(model, 131072)
    total = 0
    breakdown = []
    for msg in msgs:
        content = msg.get("content", "") or ""
        tokens = estimate_tokens(content)
        total += tokens
        breakdown.append({"role": msg.get("role", ""), "tokens": tokens})
    return jsonify({
        "total_tokens": total, "limit": limit,
        "usage_pct": round((total / limit) * 100, 1) if limit else 0,
        "remaining": limit - total, "breakdown": breakdown,
    })


# ── Tool Approval Flow ──────────────────────────

@app.route("/api/tools/pending")
def list_pending():
    return jsonify({"pending": [
        {"id": k, "path": v["path"], "tool": v["tool"], "diff": v["diff"][:2000], "timestamp": v["timestamp"]}
        for k, v in PENDING_EDITS.items()
    ]})


@app.route("/api/tools/approve", methods=["POST"])
def approve_edit():
    edit_id = request.json.get("id", "")
    edit = PENDING_EDITS.pop(edit_id, None)
    if not edit:
        return jsonify({"error": "Pending edit not found"}), 404
    try:
        FILE_EDIT_HISTORY.append({"path": edit["path"], "old_content": edit["old_content"], "new_content": edit["new_content"], "tool": edit["tool"], "timestamp": time.time()})
        if len(FILE_EDIT_HISTORY) > MAX_UNDO_HISTORY:
            FILE_EDIT_HISTORY.pop(0)
        os.makedirs(os.path.dirname(edit["path"]) or ".", exist_ok=True)
        with open(edit["path"], "w", encoding="utf-8") as f:
            f.write(edit["new_content"])
        return jsonify({"success": True, "path": edit["path"]})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/tools/reject", methods=["POST"])
def reject_edit():
    edit_id = request.json.get("id", "")
    edit = PENDING_EDITS.pop(edit_id, None)
    if not edit:
        return jsonify({"error": "Pending edit not found"}), 404
    return jsonify({"success": True, "rejected": edit["path"]})


@app.route("/api/settings/approval", methods=["POST"])
def set_approval():
    global REQUIRE_APPROVAL
    REQUIRE_APPROVAL = request.json.get("enabled", False)
    return jsonify({"require_approval": REQUIRE_APPROVAL})


# ── Streaming Terminal ──────────────────────────

@app.route("/api/terminal/stream", methods=["POST"])
def terminal_stream():
    command = request.json.get("command", "")
    cwd = request.json.get("cwd", WORKSPACE)

    def generate():
        try:
            proc = subprocess.Popen(
                command, shell=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, cwd=cwd, bufsize=1
            )
            for line in iter(proc.stdout.readline, ""):
                yield f"data: {json.dumps({'type': 'output', 'text': line})}\n\n"
            proc.wait(timeout=120)
            yield f"data: {json.dumps({'type': 'exit', 'code': proc.returncode})}\n\n"
        except subprocess.TimeoutExpired:
            proc.kill()
            yield f"data: {json.dumps({'type': 'error', 'text': 'Command timed out (120s)'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'text': str(e)})}\n\n"

    return Response(stream_with_context(generate()), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── File Watcher ──────────────────────────────

@app.route("/api/files/mtime", methods=["POST"])
def file_mtime():
    paths = request.json.get("paths", [])
    changed = []
    for p in paths:
        try:
            mtime = os.path.getmtime(p)
            if p in FILE_MTIMES and FILE_MTIMES[p] < mtime:
                changed.append({"path": p, "mtime": mtime})
            FILE_MTIMES[p] = mtime
        except Exception:
            pass
    return jsonify({"changed": changed})


# ── MCP Server Support ──────────────────────────

@app.route("/api/mcp/servers", methods=["GET", "POST", "DELETE"])
def mcp_servers():
    global MCP_SERVERS
    if request.method == "POST":
        data = request.json
        server = {"name": data.get("name", ""), "url": data.get("url", ""), "tools": []}
        try:
            r = requests.post(server["url"], json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, timeout=10)
            if r.ok:
                tools = r.json().get("result", {}).get("tools", [])
                server["tools"] = tools
        except Exception:
            pass
        MCP_SERVERS.append(server)
        return jsonify({"success": True, "server": server})
    if request.method == "DELETE":
        name = request.args.get("name", "")
        MCP_SERVERS = [s for s in MCP_SERVERS if s["name"] != name]
        return jsonify({"success": True})
    return jsonify({"servers": MCP_SERVERS})


@app.route("/api/mcp/invoke", methods=["POST"])
def mcp_invoke():
    data = request.json
    server_name = data.get("server", "")
    tool_name = data.get("tool", "")
    tool_args = data.get("args", {})
    server = next((s for s in MCP_SERVERS if s["name"] == server_name), None)
    if not server:
        return jsonify({"error": "MCP server not found"}), 404
    try:
        r = requests.post(server["url"], json={
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": tool_name, "arguments": tool_args}
        }, timeout=30)
        return jsonify(r.json().get("result", {}))
    except Exception as e:
        return jsonify({"error": str(e)}), 400


if __name__ == "__main__":
    if not API_KEY:
        print("WARNING: XAI_API_KEY not set. Set it before making requests.")
    print(f"Workspace: {WORKSPACE}")
    print("Starting tetsuocode Web on http://localhost:5000")
    app.run(debug=True, port=5000, use_reloader=False)
