// TetsuoCode Web - Frontend

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const cancelBtn = document.getElementById("cancelBtn");
const tokenCountEl = document.getElementById("tokenCount");
const chatTitleEl = document.getElementById("chatTitle");
const chatHistoryEl = document.getElementById("chatHistory");

let messages = [];
let streaming = false;
let abortController = null;
let totalTokens = { prompt: 0, completion: 0, total: 0 };
let chatList = [];
let currentChatId = null;

// Configure marked for code highlighting
marked.setOptions({
  highlight: function (code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang }).value;
    }
    return hljs.highlightAuto(code).value;
  },
  breaks: true,
});

// Auto-resize textarea
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
});

// Keyboard shortcuts
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
  if (e.key === "Escape") {
    if (streaming) cancelStream();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && streaming) {
    cancelStream();
  }
});

function insertPrompt(text) {
  inputEl.value = text;
  inputEl.focus();
  sendMessage();
}

function newChat() {
  messages = [];
  totalTokens = { prompt: 0, completion: 0, total: 0 };
  currentChatId = Date.now().toString();
  chatTitleEl.textContent = "new chat";
  tokenCountEl.textContent = "";
  messagesEl.innerHTML = `
    <div class="welcome">
      <h1>tetsuocode</h1>
      <p>ai coding assistant powered by grok</p>
      <div class="welcome-hints">
        <div class="hint" onclick="insertPrompt('explain this codebase')">explain this codebase</div>
        <div class="hint" onclick="insertPrompt('find and fix bugs')">find and fix bugs</div>
        <div class="hint" onclick="insertPrompt('write tests for this project')">write tests</div>
        <div class="hint" onclick="insertPrompt('refactor for performance')">refactor for performance</div>
      </div>
    </div>`;
  inputEl.focus();
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMarkdown(text) {
  let html = marked.parse(text);

  // Add copy buttons and language labels to code blocks
  html = html.replace(
    /<pre><code class="language-(\w+)">/g,
    '<pre><div class="code-header"><span>$1</span><button class="copy-btn" onclick="copyCode(this)">copy</button></div><code class="language-$1">'
  );
  html = html.replace(
    /<pre><code(?! class)>/g,
    '<pre><div class="code-header"><span>text</span><button class="copy-btn" onclick="copyCode(this)">copy</button></div><code>'
  );

  return html;
}

function copyCode(btn) {
  const code = btn.closest("pre").querySelector("code").textContent;
  navigator.clipboard.writeText(code);
  btn.textContent = "copied";
  setTimeout(() => (btn.textContent = "copy"), 2000);
}

function addMessage(role, content) {
  // Remove welcome screen
  const welcome = messagesEl.querySelector(".welcome");
  if (welcome) welcome.remove();

  const div = document.createElement("div");
  div.className = `message ${role}`;

  const roleLabel = role === "user" ? "you" : "tetsuo";

  div.innerHTML = `
    <div class="message-header">
      <span class="message-role">${roleLabel}</span>
    </div>
    <div class="message-body">${role === "user" ? escapeHtml(content).replace(/\n/g, "<br>") : renderMarkdown(content)}</div>
  `;

  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function addThinking() {
  const welcome = messagesEl.querySelector(".welcome");
  if (welcome) welcome.remove();

  const div = document.createElement("div");
  div.className = "message assistant";
  div.id = "streamingMessage";
  div.innerHTML = `
    <div class="message-header">
      <span class="message-role">tetsuo</span>
    </div>
    <div class="message-body">
      <div class="thinking">
        <div class="thinking-dots"><span></span><span></span><span></span></div>
      </div>
    </div>
  `;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function addToolCall(name, args) {
  const streamMsg = document.getElementById("streamingMessage");
  if (!streamMsg) return;

  const body = streamMsg.querySelector(".message-body");
  const toolDiv = document.createElement("div");
  toolDiv.className = "tool-call";

  let argsPreview = args;
  try {
    const parsed = JSON.parse(args);
    argsPreview = JSON.stringify(parsed, null, 2);
  } catch (e) {}

  if (argsPreview.length > 200) argsPreview = argsPreview.slice(0, 200) + "...";

  toolDiv.innerHTML = `
    <div class="tool-call-header">
      <span>$</span>
      <span class="tool-name">${escapeHtml(name)}</span>
    </div>
    <div class="tool-call-body">${escapeHtml(argsPreview)}</div>
  `;

  body.appendChild(toolDiv);
  scrollToBottom();
}

function addToolResult(name, result) {
  const streamMsg = document.getElementById("streamingMessage");
  if (!streamMsg) return;

  // Find the last tool-call div and append result
  const toolDivs = streamMsg.querySelectorAll(".tool-call");
  if (toolDivs.length > 0) {
    const lastTool = toolDivs[toolDivs.length - 1];
    const resultBody = lastTool.querySelector(".tool-call-body");
    let preview = result;
    if (preview.length > 300) preview = preview.slice(0, 300) + "...";
    resultBody.textContent = preview;
  }
  scrollToBottom();
}

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || streaming) return;

  // Add user message
  addMessage("user", text);
  messages.push({ role: "user", content: text });

  // Update title from first message
  if (messages.length === 1) {
    const title = text.length > 40 ? text.slice(0, 40) + "..." : text;
    chatTitleEl.textContent = title;
    saveChatToHistory(title);
  }

  // Clear input
  inputEl.value = "";
  inputEl.style.height = "auto";

  // Start streaming
  streaming = true;
  sendBtn.classList.add("hidden");
  cancelBtn.classList.remove("hidden");

  const streamMsg = addThinking();
  const body = streamMsg.querySelector(".message-body");
  let fullContent = "";

  abortController = new AbortController();

  try {
    const model = document.getElementById("modelSelect").value;
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, model }),
      signal: abortController.signal,
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);

        try {
          const data = JSON.parse(payload);

          if (data.type === "content") {
            // First content chunk - clear thinking indicator
            if (!fullContent) {
              body.innerHTML = "";
            }
            fullContent += data.content;
            body.innerHTML = renderMarkdown(fullContent);
            body.classList.add("streaming-cursor");
            scrollToBottom();
          } else if (data.type === "tool_call") {
            if (!fullContent) body.innerHTML = "";
            addToolCall(data.name, data.args);
          } else if (data.type === "tool_result") {
            addToolResult(data.name, data.result);
          } else if (data.type === "usage") {
            totalTokens.prompt += data.usage.prompt_tokens || 0;
            totalTokens.completion += data.usage.completion_tokens || 0;
            totalTokens.total += data.usage.total_tokens || 0;
            tokenCountEl.textContent = `${totalTokens.total.toLocaleString()} tokens`;
          } else if (data.type === "error") {
            body.innerHTML = `<span style="color: #cc4444">${escapeHtml(data.content)}</span>`;
          } else if (data.type === "done") {
            // done
          }
        } catch (e) {
          // skip malformed JSON
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      if (!fullContent) {
        body.innerHTML = '<span style="color: var(--text-dim)">cancelled</span>';
      }
    } else {
      body.innerHTML = `<span style="color: #cc4444">error: ${escapeHtml(e.message)}</span>`;
    }
  }

  // Finalize
  body.classList.remove("streaming-cursor");
  streamMsg.removeAttribute("id");

  if (fullContent) {
    messages.push({ role: "assistant", content: fullContent });
  }

  streaming = false;
  abortController = null;
  sendBtn.classList.remove("hidden");
  cancelBtn.classList.add("hidden");
  inputEl.focus();
}

function cancelStream() {
  if (abortController) {
    abortController.abort();
  }
}

function saveChatToHistory(title) {
  const item = document.createElement("div");
  item.className = "chat-item active";
  item.textContent = title;
  item.onclick = () => {
    // For now just visual
    document.querySelectorAll(".chat-item").forEach((i) => i.classList.remove("active"));
    item.classList.add("active");
  };

  // Deactivate others
  document.querySelectorAll(".chat-item").forEach((i) => i.classList.remove("active"));
  chatHistoryEl.prepend(item);
}

// Init
inputEl.focus();
