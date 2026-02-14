"""tetsuocode Web - Cursor-style AI coding assistant powered by Grok"""
import json
import os
import requests
from flask import Flask, render_template, request, Response, stream_with_context

app = Flask(__name__)

API_KEY = os.environ.get("XAI_API_KEY", "")
BASE_URL = "https://api.x.ai/v1"
MODEL = "grok-4-1-fast-reasoning"

SYSTEM_PROMPT = """You are tetsuocode, an elite AI coding assistant. You are powered by Grok.

When responding:
- Be concise and direct.
- Use markdown for formatting.
- Include code blocks with language tags for syntax highlighting.
- Don't over-explain obvious things."""

TOOL_DEFINITIONS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a file at the given path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file"}
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write content to a file, creating it if needed.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Path to the file"},
                    "content": {"type": "string", "description": "Content to write"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Execute a shell command and return output.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to run"}
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_files",
            "description": "List files in a directory tree.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory path"},
                    "max_depth": {"type": "number", "description": "Max depth (default 3)"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep_files",
            "description": "Search for a pattern across files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex pattern"},
                    "path": {"type": "string", "description": "Directory to search"},
                },
                "required": ["pattern"],
            },
        },
    },
]


def execute_tool(name, args):
    """Execute a tool call and return the result."""
    import subprocess

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
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            return json.dumps({"success": True, "path": path})
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
            return json.dumps(
                {"stdout": out, "stderr": result.stderr, "exit_code": result.returncode}
            )
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


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/chat", methods=["POST"])
def chat():
    if not API_KEY:
        return Response(
            f"data: {json.dumps({'type': 'error', 'content': 'No API key configured. Set XAI_API_KEY environment variable.'})}\n\n",
            mimetype="text/event-stream",
        )

    data = request.json
    messages = data.get("messages", [])
    model = data.get("model", MODEL)

    # Prepend system message
    full_messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages

    def generate():
        nonlocal full_messages
        iteration = 0
        max_iterations = 10

        try:
          while iteration < max_iterations:
            iteration += 1

            body = {
                "model": model,
                "messages": full_messages,
                "max_tokens": 4096,
                "temperature": 0.7,
                "stream": True,
                "tools": TOOL_DEFINITIONS,
                "tool_choice": "auto",
            }

            resp = requests.post(
                f"{BASE_URL}/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {API_KEY}",
                },
                json=body,
                stream=True,
                timeout=120,
            )

            if resp.status_code != 200:
                # Sanitize error - never leak API key or raw response
                error_msg = f"API error {resp.status_code}"
                try:
                    err_data = resp.json()
                    if "error" in err_data:
                        error_msg = err_data["error"].get("message", error_msg)
                except Exception:
                    pass
                # Strip any auth tokens from error messages
                error_msg = error_msg.replace(API_KEY, "[REDACTED]") if API_KEY else error_msg
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

                    # Content streaming
                    if delta.get("content"):
                        content_buffer += delta["content"]
                        yield f"data: {json.dumps({'type': 'content', 'content': delta['content']})}\n\n"

                    # Tool call fragments
                    if delta.get("tool_calls"):
                        for tc in delta["tool_calls"]:
                            idx = tc["index"]
                            if idx not in tool_calls:
                                tool_calls[idx] = {
                                    "id": tc.get("id", ""),
                                    "function": {"name": "", "arguments": ""},
                                }
                            if tc.get("id"):
                                tool_calls[idx]["id"] = tc["id"]
                            if tc.get("function", {}).get("name"):
                                tool_calls[idx]["function"]["name"] += tc["function"]["name"]
                            if tc.get("function", {}).get("arguments"):
                                tool_calls[idx]["function"]["arguments"] += tc["function"]["arguments"]

                    # Usage info
                    if chunk.get("usage"):
                        yield f"data: {json.dumps({'type': 'usage', 'usage': chunk['usage']})}\n\n"

            # Handle tool calls
            if finish_reason == "tool_calls" and tool_calls:
                sorted_calls = [tool_calls[k] for k in sorted(tool_calls.keys())]

                # Add assistant message with tool calls
                assistant_msg = {"role": "assistant", "content": content_buffer or None}
                assistant_msg["tool_calls"] = [
                    {
                        "id": tc["id"],
                        "type": "function",
                        "function": tc["function"],
                    }
                    for tc in sorted_calls
                ]
                full_messages.append(assistant_msg)

                # Execute each tool and send results
                for tc in sorted_calls:
                    name = tc["function"]["name"]
                    try:
                        args = json.loads(tc["function"]["arguments"])
                    except json.JSONDecodeError:
                        args = {}

                    yield f"data: {json.dumps({'type': 'tool_call', 'name': name, 'args': tc['function']['arguments'][:200]})}\n\n"

                    result = execute_tool(name, args)

                    yield f"data: {json.dumps({'type': 'tool_result', 'name': name, 'result': result[:500]})}\n\n"

                    full_messages.append({
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": result,
                    })

                # Reset for next iteration
                content_buffer = ""
                tool_calls = {}
                finish_reason = None
                continue

            # Normal completion
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            return

          yield f"data: {json.dumps({'type': 'error', 'content': 'Max tool iterations reached'})}\n\n"

        except requests.exceptions.ConnectionError:
            yield f"data: {json.dumps({'type': 'error', 'content': 'Connection failed - check your network'})}\n\n"
        except requests.exceptions.Timeout:
            yield f"data: {json.dumps({'type': 'error', 'content': 'Request timed out'})}\n\n"
        except Exception as e:
            msg = str(e)
            if API_KEY:
                msg = msg.replace(API_KEY, "[REDACTED]")
            yield f"data: {json.dumps({'type': 'error', 'content': f'Unexpected error: {msg}'})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/models")
def models():
    return {"models": ["grok-4-1-fast-reasoning", "grok-3-fast", "grok-3", "grok-3-mini"]}


if __name__ == "__main__":
    if not API_KEY:
        print("WARNING: XAI_API_KEY not set. Set it before making requests.")
    print("Starting tetsuocode Web on http://localhost:5000")
    app.run(debug=True, port=5000, use_reloader=False)
