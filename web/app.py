"""tetsuocode Web - AI coding assistant powered by Grok"""
import json
import os
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
        try:
            old_content = ""
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    old_content = f.read()
            except FileNotFoundError:
                pass
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            diff = compute_diff(old_content, content, path)
            return json.dumps({"success": True, "path": path, "diff": diff[:3000]})
        except Exception as e:
            return json.dumps({"error": str(e)})

    elif name == "edit_file":
        path = args.get("path", "")
        old_string = args.get("old_string", "")
        new_string = args.get("new_string", "")
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
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            diff = compute_diff(old_content, content, path)
            return json.dumps({"success": True, "path": path, "diff": diff[:3000]})
        except Exception as e:
            return json.dumps({"error": str(e)})

    elif name == "run_command":
        command = args.get("command", "")
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
        result.append({"role": msg["role"], "content": msg["content"]})
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

    sys_prompt = custom_system if custom_system else SYSTEM_PROMPT
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


if __name__ == "__main__":
    if not API_KEY:
        print("WARNING: XAI_API_KEY not set. Set it before making requests.")
    print(f"Workspace: {WORKSPACE}")
    print("Starting tetsuocode Web on http://localhost:5000")
    app.run(debug=True, port=5000, use_reloader=False)
