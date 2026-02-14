// tetsuocode Web - Frontend

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
let currentChatId = null;
let chats = {}; // { id: { title, messages, tokens } }

// Configure marked for code highlighting
marked.setOptions({
  highlight: function (code, lang) {
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    } catch (e) {
      return code;
    }
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

// ── Persistence ──────────────────────────────────────

function saveState() {
  if (!currentChatId) return;
  chats[currentChatId] = {
    title: chatTitleEl.textContent,
    messages: messages,
    tokens: totalTokens,
  };
  try {
    localStorage.setItem("tetsuocode_chats", JSON.stringify(chats));
    localStorage.setItem("tetsuocode_current", currentChatId);
  } catch (e) {
    // localStorage full or unavailable
  }
}

function loadState() {
  try {
    const saved = localStorage.getItem("tetsuocode_chats");
    const current = localStorage.getItem("tetsuocode_current");
    if (saved) {
      chats = JSON.parse(saved);
      renderChatHistory();
      if (current && chats[current]) {
        loadChat(current);
        return;
      }
    }
  } catch (e) {
    // corrupted data, start fresh
  }
  newChat();
}

function renderChatHistory() {
  chatHistoryEl.innerHTML = "";
  const ids = Object.keys(chats).sort((a, b) => Number(b) - Number(a));
  for (const id of ids) {
    const chat = chats[id];
    const item = document.createElement("div");
    item.className = "chat-item" + (id === currentChatId ? " active" : "");
    item.textContent = chat.title || "new chat";
    item.dataset.chatId = id;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "chat-delete";
    deleteBtn.innerHTML = "&times;";
    deleteBtn.setAttribute("aria-label", "Delete chat");
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deleteChat(id);
    };
    item.appendChild(deleteBtn);

    item.onclick = () => {
      if (streaming) return;
      saveState();
      loadChat(id);
    };
    chatHistoryEl.appendChild(item);
  }
}

function loadChat(id) {
  const chat = chats[id];
  if (!chat) return;

  currentChatId = id;
  messages = chat.messages || [];
  totalTokens = chat.tokens || { prompt: 0, completion: 0, total: 0 };
  chatTitleEl.textContent = chat.title || "new chat";
  tokenCountEl.textContent = totalTokens.total ? `${totalTokens.total.toLocaleString()} tokens` : "";

  // Re-render messages
  messagesEl.innerHTML = "";
  if (messages.length === 0) {
    showWelcome();
  } else {
    for (const msg of messages) {
      if (msg.role === "user" || msg.role === "assistant") {
        addMessage(msg.role, msg.content, true);
      }
    }
  }

  renderChatHistory();
  inputEl.focus();
}

function deleteChat(id) {
  delete chats[id];
  try {
    localStorage.setItem("tetsuocode_chats", JSON.stringify(chats));
  } catch (e) {}

  if (id === currentChatId) {
    const remaining = Object.keys(chats);
    if (remaining.length > 0) {
      loadChat(remaining.sort((a, b) => Number(b) - Number(a))[0]);
    } else {
      newChat();
    }
  } else {
    renderChatHistory();
  }
}

function newChat() {
  if (currentChatId && messages.length > 0) {
    saveState();
  }
  messages = [];
  totalTokens = { prompt: 0, completion: 0, total: 0 };
  currentChatId = Date.now().toString();
  chatTitleEl.textContent = "new chat";
  tokenCountEl.textContent = "";
  messagesEl.innerHTML = "";
  showWelcome();
  renderChatHistory();
  inputEl.focus();
}

function showWelcome() {
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
}

// ── Rendering ──────────────────────────────────────

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderMarkdown(text) {
  let html;
  try {
    html = marked.parse(text);
  } catch (e) {
    html = escapeHtml(text);
  }

  // Add copy buttons and language labels to code blocks
  html = html.replace(
    /<pre><code class="language-(\w+)">/g,
    '<pre><div class="code-header"><span>$1</span><button class="copy-btn" onclick="copyCode(this)" aria-label="Copy code">copy</button></div><code class="language-$1">'
  );
  html = html.replace(
    /<pre><code(?! class)>/g,
    '<pre><div class="code-header"><span>text</span><button class="copy-btn" onclick="copyCode(this)" aria-label="Copy code">copy</button></div><code>'
  );

  return html;
}

function copyCode(btn) {
  const code = btn.closest("pre").querySelector("code").textContent;
  navigator.clipboard.writeText(code).then(() => {
    btn.textContent = "copied";
    setTimeout(() => (btn.textContent = "copy"), 2000);
  }).catch(() => {
    btn.textContent = "failed";
    setTimeout(() => (btn.textContent = "copy"), 2000);
  });
}

function addMessage(role, content, silent) {
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
  if (!silent) scrollToBottom();
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

function showToolThinking() {
  const streamMsg = document.getElementById("streamingMessage");
  if (!streamMsg) return;
  const body = streamMsg.querySelector(".message-body");

  // Add a thinking indicator after tool calls
  let thinkingEl = body.querySelector(".tool-thinking");
  if (!thinkingEl) {
    thinkingEl = document.createElement("div");
    thinkingEl.className = "tool-thinking";
    thinkingEl.innerHTML = `
      <div class="thinking">
        <div class="thinking-dots"><span></span><span></span><span></span></div>
        <span>running...</span>
      </div>
    `;
    body.appendChild(thinkingEl);
  }
  scrollToBottom();
}

function removeToolThinking() {
  const streamMsg = document.getElementById("streamingMessage");
  if (!streamMsg) return;
  const thinkingEl = streamMsg.querySelector(".tool-thinking");
  if (thinkingEl) thinkingEl.remove();
}

function addToolCall(name, args) {
  const streamMsg = document.getElementById("streamingMessage");
  if (!streamMsg) return;

  removeToolThinking();

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
      <span class="tool-status">running</span>
    </div>
    <div class="tool-call-body">${escapeHtml(argsPreview)}</div>
  `;

  body.appendChild(toolDiv);
  showToolThinking();
  scrollToBottom();
}

function addToolResult(name, result) {
  const streamMsg = document.getElementById("streamingMessage");
  if (!streamMsg) return;

  removeToolThinking();

  // Find the last tool-call div and update it
  const toolDivs = streamMsg.querySelectorAll(".tool-call");
  if (toolDivs.length > 0) {
    const lastTool = toolDivs[toolDivs.length - 1];
    const resultBody = lastTool.querySelector(".tool-call-body");
    const statusEl = lastTool.querySelector(".tool-status");
    let preview = result;
    if (preview.length > 300) preview = preview.slice(0, 300) + "...";
    resultBody.textContent = preview;
    if (statusEl) statusEl.textContent = "done";
  }

  // Show thinking again for next iteration
  showToolThinking();
  scrollToBottom();
}

// ── Chat ──────────────────────────────────────

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || streaming) return;

  // Add user message
  addMessage("user", text);
  messages.push({ role: "user", content: text });

  // Update title from first message
  if (messages.filter((m) => m.role === "user").length === 1) {
    const title = text.length > 40 ? text.slice(0, 40) + "..." : text;
    chatTitleEl.textContent = title;
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

    if (!resp.ok) {
      throw new Error(`server returned ${resp.status}`);
    }

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

        let data;
        try {
          data = JSON.parse(payload);
        } catch (e) {
          continue;
        }

        if (data.type === "content") {
          // First content chunk - clear thinking indicator
          if (!fullContent) {
            body.innerHTML = "";
          }
          removeToolThinking();
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
          removeToolThinking();
          body.innerHTML = `<span class="error-text">${escapeHtml(data.content)}</span>`;
        } else if (data.type === "done") {
          removeToolThinking();
        }
      }
    }
  } catch (e) {
    removeToolThinking();
    if (e.name === "AbortError") {
      if (!fullContent) {
        body.innerHTML = '<span class="dim-text">cancelled</span>';
      }
    } else {
      let errorMsg = "connection failed";
      if (e.message.includes("server returned")) {
        errorMsg = e.message;
      } else if (e.message.includes("Failed to fetch") || e.message.includes("NetworkError")) {
        errorMsg = "network error - check your connection";
      }
      body.innerHTML = `<span class="error-text">${escapeHtml(errorMsg)}</span>`;
    }
  }

  // Finalize
  body.classList.remove("streaming-cursor");
  removeToolThinking();
  streamMsg.removeAttribute("id");

  if (fullContent) {
    messages.push({ role: "assistant", content: fullContent });
  }

  streaming = false;
  abortController = null;
  sendBtn.classList.remove("hidden");
  cancelBtn.classList.add("hidden");
  saveState();
  renderChatHistory();
  inputEl.focus();
}

function cancelStream() {
  if (abortController) {
    abortController.abort();
  }
}

// ── Init ──────────────────────────────────────

loadState();
inputEl.focus();
