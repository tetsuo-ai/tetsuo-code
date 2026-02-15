// tetsuocode Web - Frontend

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");
const cancelBtn = document.getElementById("cancelBtn");
const tokenCountEl = document.getElementById("tokenCount");
const chatTitleEl = document.getElementById("chatTitle");
const chatHistoryEl = document.getElementById("chatHistory");
const chatArea = document.getElementById("chatArea");

let messages = [];
let streaming = false;
let abortController = null;
let totalTokens = { prompt: 0, completion: 0, total: 0 };
let currentChatId = null;
let chats = {};
let autoScroll = true;
let pinnedMessages = [];
let editorTabs = []; // [{path, content, original, active}]
let settings = { temperature: 0.7, max_tokens: 4096, system_prompt: "", provider: "xai", api_key: "", sound: false, autoContext: false };

const SYSTEM_PRESETS = {
  "": "",
  reviewer: "You are a senior code reviewer. Focus on code quality, bugs, security, and best practices. Be thorough but constructive.",
  debugger: "You are an expert debugger. Analyze code systematically, identify root causes, and provide precise fixes.",
  architect: "You are a software architect. Focus on system design, scalability, maintainability, and architectural patterns.",
  teacher: "You are a patient programming teacher. Explain concepts clearly with examples. Avoid jargon unless necessary.",
  performance: "You are a performance optimization specialist. Focus on algorithmic efficiency, memory usage, and profiling.",
};

const MODEL_PRICING = {
  "grok-4-1-fast-reasoning": [5, 15], "grok-3-fast": [5, 15], "grok-3": [10, 30], "grok-3-mini": [1, 3],
  "gpt-4o": [2.5, 10], "gpt-4o-mini": [0.15, 0.6], "o1": [15, 60], "o1-mini": [3, 12],
  "claude-sonnet-4-5-20250929": [3, 15], "claude-haiku-4-5-20251001": [0.8, 4],
};

const CONTEXT_LIMITS = {
  "grok-4-1-fast-reasoning": 131072, "grok-3-fast": 131072, "grok-3": 131072, "grok-3-mini": 131072,
  "gpt-4o": 128000, "gpt-4o-mini": 128000, "o1": 200000, "o1-mini": 128000,
  "claude-sonnet-4-5-20250929": 200000, "claude-haiku-4-5-20251001": 200000,
};

const PROVIDER_MODELS = {
  xai: ["grok-4-1-fast-reasoning","grok-3-fast","grok-3","grok-3-mini"],
  openai: ["gpt-4o","gpt-4o-mini","o1","o1-mini"],
  anthropic: ["claude-sonnet-4-5-20250929","claude-haiku-4-5-20251001"],
  ollama: ["llama3","codellama","mistral","deepseek-coder"],
};

marked.setOptions({
  highlight: (code, lang) => { try { return lang && hljs.getLanguage(lang) ? hljs.highlight(code, {language:lang}).value : hljs.highlightAuto(code).value; } catch(e) { return code; } },
  breaks: true,
});

inputEl.addEventListener("input", () => { inputEl.style.height = "auto"; inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px"; });
inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } if (e.key === "Escape" && streaming) cancelStream(); });

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (streaming) cancelStream(); else if (!document.getElementById("searchOverlay").classList.contains("hidden")) closeSearch(); else if (!document.getElementById("paletteOverlay").classList.contains("hidden")) closePalette(); }
  if (e.key === "n" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!streaming) newChat(); }
  if (e.key === "," && (e.ctrlKey || e.metaKey)) { e.preventDefault(); toggleSettings(); }
  if (e.key === "f" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openSearch(); }
  if (e.key === "k" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openPalette(); }
  if (e.key === "`" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); toggleTerminal(); }
});

messagesEl.addEventListener("scroll", () => { const {scrollTop,scrollHeight,clientHeight}=messagesEl; autoScroll=scrollHeight-scrollTop-clientHeight<60; });
chatArea.addEventListener("dragover", (e) => { e.preventDefault(); document.getElementById("dropZone").classList.remove("hidden"); });
chatArea.addEventListener("dragleave", (e) => { if (!chatArea.contains(e.relatedTarget)) document.getElementById("dropZone").classList.add("hidden"); });
chatArea.addEventListener("drop", (e) => { e.preventDefault(); document.getElementById("dropZone").classList.add("hidden"); if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]); });

function insertPrompt(text) { inputEl.value = text; inputEl.focus(); sendMessage(); }

// ── Auth ──────────────────────────────────
async function checkAuth() {
  try { const r = await fetch("/api/auth/check"); const d = await r.json(); if (d.required && !d.authenticated) { document.getElementById("loginOverlay").classList.remove("hidden"); return false; } } catch(e) {} return true;
}
async function submitLogin() {
  try { const r = await fetch("/api/auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("loginPassword").value})}); if (r.ok) { document.getElementById("loginOverlay").classList.add("hidden"); loadState(); } else document.getElementById("loginError").classList.remove("hidden"); } catch(e) { document.getElementById("loginError").classList.remove("hidden"); }
}
document.getElementById("loginPassword").addEventListener("keydown",(e)=>{if(e.key==="Enter")submitLogin()});

// ── Persistence ──────────────────────────────
function saveState() { if (!currentChatId) return; chats[currentChatId]={title:chatTitleEl.textContent,messages,tokens:totalTokens,pinned:pinnedMessages}; try{localStorage.setItem("tetsuocode_chats",JSON.stringify(chats));localStorage.setItem("tetsuocode_current",currentChatId)}catch(e){} }
function loadSettings() { try{const s=localStorage.getItem("tetsuocode_settings");if(s)settings={...settings,...JSON.parse(s)}}catch(e){} }
function saveSettings() { try{localStorage.setItem("tetsuocode_settings",JSON.stringify(settings))}catch(e){} }

function loadState() {
  loadSettings();
  populateModels();
  try { const saved=localStorage.getItem("tetsuocode_chats"); const current=localStorage.getItem("tetsuocode_current");
    if(saved){chats=JSON.parse(saved);renderChatHistory();if(current&&chats[current]){loadChat(current);return;}} } catch(e){}
  newChat();
}

function populateModels() {
  const sel = document.getElementById("modelSelect");
  const models = PROVIDER_MODELS[settings.provider] || PROVIDER_MODELS.xai;
  sel.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join("");
}

function renderChatHistory() {
  chatHistoryEl.innerHTML="";
  const ids=Object.keys(chats).sort((a,b)=>Number(b)-Number(a));
  for(const id of ids){const c=chats[id];const item=document.createElement("div");item.className="chat-item"+(id===currentChatId?" active":"");item.textContent=c.title||"new chat";
    const del=document.createElement("button");del.className="chat-delete";del.innerHTML="&times;";del.onclick=(e)=>{e.stopPropagation();deleteChat(id)};item.appendChild(del);
    item.onclick=()=>{if(streaming)return;saveState();loadChat(id)};chatHistoryEl.appendChild(item);}
}

function loadChat(id) {
  const c=chats[id]; if(!c)return; currentChatId=id; messages=c.messages||[]; totalTokens=c.tokens||{prompt:0,completion:0,total:0}; pinnedMessages=c.pinned||[];
  chatTitleEl.textContent=c.title||"new chat"; updateTokenDisplay();
  messagesEl.innerHTML=""; if(!messages.length)showWelcome(); else for(const m of messages){if(m.role==="user"||m.role==="assistant")addMessage(m.role,m.content,true,m.timestamp)}
  renderPinned(); renderChatHistory(); inputEl.focus();
}
function deleteChat(id){delete chats[id];try{localStorage.setItem("tetsuocode_chats",JSON.stringify(chats))}catch(e){}if(id===currentChatId){const r=Object.keys(chats);r.length?loadChat(r.sort((a,b)=>Number(b)-Number(a))[0]):newChat()}else renderChatHistory()}
function newChat(){if(currentChatId&&messages.length)saveState();messages=[];totalTokens={prompt:0,completion:0,total:0};pinnedMessages=[];currentChatId=Date.now().toString();chatTitleEl.textContent="new chat";tokenCountEl.textContent="";document.getElementById("tokenCost").textContent="";messagesEl.innerHTML="";showWelcome();renderChatHistory();updateContextBar();inputEl.focus()}
function showWelcome(){messagesEl.innerHTML=`<div class="welcome"><h1>tetsuocode</h1><p>ai coding assistant powered by grok</p><div class="welcome-hints"><div class="hint" onclick="insertPrompt('explain this codebase')">explain this codebase</div><div class="hint" onclick="insertPrompt('find and fix bugs')">find and fix bugs</div><div class="hint" onclick="insertPrompt('write tests for this project')">write tests</div><div class="hint" onclick="insertPrompt('refactor for performance')">refactor for performance</div></div></div>`}

// ── Token Cost & Context ──────────────────────
function updateTokenDisplay() {
  tokenCountEl.textContent = totalTokens.total ? `${totalTokens.total.toLocaleString()} tokens` : "";
  const model = document.getElementById("modelSelect").value;
  const pricing = MODEL_PRICING[model];
  if (pricing && totalTokens.total) {
    const cost = (totalTokens.prompt * pricing[0] + totalTokens.completion * pricing[1]) / 1000000;
    document.getElementById("tokenCost").textContent = `~$${cost.toFixed(4)}`;
  }
  updateContextBar();
}
function updateContextBar() {
  const model = document.getElementById("modelSelect").value;
  const limit = CONTEXT_LIMITS[model] || 131072;
  const pct = Math.min((totalTokens.total / limit) * 100, 100);
  const fill = document.getElementById("contextFill");
  fill.style.width = pct + "%";
  fill.className = "context-fill" + (pct > 80 ? " ctx-red" : pct > 50 ? " ctx-yellow" : "");
}

// ── Export/Import ──────────────────────────
function exportChats(){const b=new Blob([JSON.stringify(chats,null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=`tetsuocode-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href)}
function importChats(){const i=document.createElement("input");i.type="file";i.accept=".json";i.onchange=(e)=>{const r=new FileReader();r.onload=(ev)=>{try{Object.assign(chats,JSON.parse(ev.target.result));localStorage.setItem("tetsuocode_chats",JSON.stringify(chats));renderChatHistory()}catch(err){alert("Invalid JSON")}};r.readAsText(e.target.files[0])};i.click()}
function exportMarkdown(){if(!messages.length)return;let md=`# ${chatTitleEl.textContent}\n\n`;for(const m of messages){if(m.role==="user")md+=`## You\n\n${m.content}\n\n`;else if(m.role==="assistant")md+=`## Tetsuo\n\n${m.content}\n\n`}const b=new Blob([md],{type:"text/markdown"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=`${chatTitleEl.textContent.replace(/[^a-z0-9]/gi,"-")}.md`;a.click();URL.revokeObjectURL(a.href)}

// ── Upload ──────────────────────────────
async function uploadFile(file){const f=new FormData();f.append("file",file);try{const r=await fetch("/api/upload",{method:"POST",body:f});const d=await r.json();if(d.image)inputEl.value+=`\n[Attached image: ${d.filename}]`;else if(d.content)inputEl.value+=`\n\`\`\`\n// ${d.filename}\n${d.content.slice(0,5000)}\n\`\`\``;inputEl.focus();inputEl.style.height=Math.min(inputEl.scrollHeight,200)+"px"}catch(e){alert("Upload failed")}}

// ── Settings ──────────────────────────────
function toggleSettings(){const p=document.getElementById("settingsPanel");if(!p.classList.contains("hidden")){p.classList.add("hidden");return}document.getElementById("settingProvider").value=settings.provider;document.getElementById("settingApiKey").value=settings.api_key;document.getElementById("settingTemp").value=settings.temperature;document.getElementById("tempValue").textContent=settings.temperature;document.getElementById("settingMaxTokens").value=settings.max_tokens;document.getElementById("settingSystemPrompt").value=settings.system_prompt;document.getElementById("settingSound").checked=settings.sound;document.getElementById("settingAutoContext").checked=settings.autoContext;p.classList.remove("hidden")}
function onProviderChange(){const p=document.getElementById("settingProvider").value;const sel=document.getElementById("modelSelect");sel.innerHTML=(PROVIDER_MODELS[p]||[]).map(m=>`<option value="${m}">${m}</option>`).join("")}
function onPresetChange(){const v=document.getElementById("settingPreset").value;document.getElementById("settingSystemPrompt").value=SYSTEM_PRESETS[v]||""}
function applySettings(){settings.provider=document.getElementById("settingProvider").value;settings.api_key=document.getElementById("settingApiKey").value;settings.temperature=parseFloat(document.getElementById("settingTemp").value)||0.7;settings.max_tokens=parseInt(document.getElementById("settingMaxTokens").value)||4096;settings.system_prompt=document.getElementById("settingSystemPrompt").value.trim();settings.sound=document.getElementById("settingSound").checked;settings.autoContext=document.getElementById("settingAutoContext").checked;saveSettings();populateModels();toggleSettings()}

// ── Theme ──────────────────────────────
function toggleTheme(){document.body.classList.toggle("light");localStorage.setItem("tetsuocode_theme",document.body.classList.contains("light")?"light":"dark")}
function loadTheme(){if(localStorage.getItem("tetsuocode_theme")==="light")document.body.classList.add("light")}

// ── Search ──────────────────────────────
function openSearch(){document.getElementById("searchOverlay").classList.remove("hidden");document.getElementById("searchInput").focus()}
function closeSearch(){document.getElementById("searchOverlay").classList.add("hidden");document.getElementById("searchInput").value="";messagesEl.querySelectorAll(".search-highlight").forEach(el=>{el.outerHTML=el.textContent})}
function doSearch(q){messagesEl.querySelectorAll(".search-highlight").forEach(el=>{el.outerHTML=el.textContent});if(!q.trim()){document.getElementById("searchCount").textContent="";return}let count=0;const re=new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})`,"gi");messagesEl.querySelectorAll(".message-body").forEach(body=>{const w=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);const nodes=[];while(w.nextNode())nodes.push(w.currentNode);nodes.forEach(n=>{if(re.test(n.textContent)){const s=document.createElement("span");s.innerHTML=n.textContent.replace(re,'<mark class="search-highlight">$1</mark>');n.parentNode.replaceChild(s,n);count+=(n.textContent.match(re)||[]).length}})});document.getElementById("searchCount").textContent=count?`${count} found`:"no results";const f=messagesEl.querySelector(".search-highlight");if(f)f.scrollIntoView({behavior:"smooth",block:"center"})}

// ── Command Palette ──────────────────────
const PALETTE_COMMANDS = [
  {name:"New Chat",key:"Ctrl+N",action:()=>newChat()},
  {name:"Search Messages",key:"Ctrl+F",action:()=>openSearch()},
  {name:"Settings",key:"Ctrl+,",action:()=>toggleSettings()},
  {name:"Toggle Terminal",key:"Ctrl+`",action:()=>toggleTerminal()},
  {name:"Toggle Files",action:()=>switchTab("files")},
  {name:"Toggle Git",action:()=>switchTab("git")},
  {name:"Toggle Theme",action:()=>toggleTheme()},
  {name:"Export JSON",action:()=>exportChats()},
  {name:"Export Markdown",action:()=>exportMarkdown()},
  {name:"Summarize Chat",action:()=>summarizeChat()},
  {name:"Change Workspace",action:()=>changeWorkspace()},
  {name:"Clear Terminal",action:()=>clearTerminal()},
];
function openPalette(){document.getElementById("paletteOverlay").classList.remove("hidden");document.getElementById("paletteInput").value="";filterPalette("");document.getElementById("paletteInput").focus()}
function closePalette(){document.getElementById("paletteOverlay").classList.add("hidden")}
function filterPalette(q){const list=document.getElementById("paletteList");const filtered=PALETTE_COMMANDS.filter(c=>c.name.toLowerCase().includes(q.toLowerCase()));list.innerHTML=filtered.map((c,i)=>`<div class="palette-item${i===0?" active":""}" onclick="execPalette(${PALETTE_COMMANDS.indexOf(c)})" onmouseenter="this.parentElement.querySelectorAll('.active').forEach(e=>e.classList.remove('active'));this.classList.add('active')"><span>${c.name}</span>${c.key?`<span class="palette-key">${c.key}</span>`:""}</div>`).join("")}
function execPalette(i){closePalette();PALETTE_COMMANDS[i].action()}
document.getElementById("paletteInput").addEventListener("keydown",(e)=>{
  const items=document.querySelectorAll(".palette-item");const active=document.querySelector(".palette-item.active");
  if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();if(!active)return;const idx=[...items].indexOf(active);const next=e.key==="ArrowDown"?Math.min(idx+1,items.length-1):Math.max(idx-1,0);active.classList.remove("active");items[next].classList.add("active");items[next].scrollIntoView({block:"nearest"})}
  if(e.key==="Enter"){e.preventDefault();if(active)active.click()}
});

// ── File Browser ──────────────────────────
function switchTab(tab){["chats","files","git"].forEach(t=>{document.getElementById("tab"+t.charAt(0).toUpperCase()+t.slice(1)).classList.toggle("active",t===tab);document.getElementById("panel"+t.charAt(0).toUpperCase()+t.slice(1)).classList.toggle("hidden",t!==tab)});if(tab==="files")loadFileTree();if(tab==="git")loadGitStatus()}
async function loadFileTree(path){try{const url=path?`/api/files/list?path=${encodeURIComponent(path)}`:"/api/files/list";const r=await fetch(url);const d=await r.json();document.getElementById("workspacePath").textContent=d.path;if(!path){const tree=document.getElementById("fileTree");tree.innerHTML="";renderFileEntries(d.entries,tree,0)}return d}catch(e){}}
function renderFileEntries(entries,container,depth){for(const e of entries){const item=document.createElement("div");item.className="file-item"+(e.type==="dir"?" dir":"");item.style.paddingLeft=(12+depth*16)+"px";item.innerHTML=`<span class="file-icon">${e.type==="dir"?"&#9656;":"&#9671;"}</span><span class="file-name">${escapeHtml(e.name)}</span>`;
  if(e.type==="dir"){let loaded=false;const ch=document.createElement("div");ch.className="file-children hidden";item.onclick=async(ev)=>{ev.stopPropagation();if(!loaded){const d=await loadFileTree(e.path);if(d&&d.entries)renderFileEntries(d.entries,ch,depth+1);loaded=true}ch.classList.toggle("hidden");item.querySelector(".file-icon").innerHTML=ch.classList.contains("hidden")?"&#9656;":"&#9662;"};container.appendChild(item);container.appendChild(ch)}
  else{item.onclick=()=>openInEditor(e.path);container.appendChild(item)}}}
async function changeWorkspace(){const p=prompt("Enter workspace path:");if(!p)return;try{const r=await fetch("/api/workspace",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p})});const d=await r.json();if(d.workspace)loadFileTree();else alert(d.error||"Failed")}catch(e){alert("Failed")}}

// ── Editor ──────────────────────────────
async function openInEditor(path){
  const existing = editorTabs.find(t=>t.path===path);
  if(existing){editorTabs.forEach(t=>t.active=false);existing.active=true;renderEditorTabs();return}
  try{const r=await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);const d=await r.json();if(d.error)return;
    editorTabs.forEach(t=>t.active=false);editorTabs.push({path,content:d.content||"",original:d.content||"",active:true,ext:d.extension||""});
    document.getElementById("editorPanel").classList.remove("hidden");renderEditorTabs()}catch(e){}
}
function renderEditorTabs(){
  const tabs=document.getElementById("editorTabs");
  tabs.innerHTML=editorTabs.map((t,i)=>{const name=t.path.split("/").pop().split("\\").pop();const modified=t.content!==t.original?"*":"";return`<div class="editor-tab${t.active?" active":""}" onclick="activateTab(${i})"><span>${escapeHtml(name)}${modified}</span><button class="editor-tab-close" onclick="event.stopPropagation();closeTab(${i})">&times;</button></div>`}).join("");
  const active=editorTabs.find(t=>t.active);const ed=document.getElementById("editorContent");
  if(active){ed.value=active.content;ed.oninput=()=>{active.content=ed.value;renderEditorTabs()}}
}
function activateTab(i){editorTabs.forEach(t=>t.active=false);editorTabs[i].active=true;renderEditorTabs()}
function closeTab(i){editorTabs.splice(i,1);if(editorTabs.length===0){document.getElementById("editorPanel").classList.add("hidden");return}if(!editorTabs.some(t=>t.active))editorTabs[Math.min(i,editorTabs.length-1)].active=true;renderEditorTabs()}
function closeEditor(){editorTabs=[];document.getElementById("editorPanel").classList.add("hidden")}
async function saveCurrentTab(){const active=editorTabs.find(t=>t.active);if(!active)return;try{const r=await fetch("/api/files/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:active.path,content:active.content})});const d=await r.json();if(d.success){active.original=active.content;renderEditorTabs()}}catch(e){alert("Save failed")}}

// ── Git ──────────────────────────────
async function loadGitStatus(){
  try{const r=await fetch("/api/git/status");const d=await r.json();if(d.error){document.getElementById("gitFiles").innerHTML=`<div class="git-msg">${escapeHtml(d.error)}</div>`;return}
    document.getElementById("gitBranch").textContent=d.branch||"no branch";
    const el=document.getElementById("gitFiles");
    el.innerHTML=d.files.map(f=>`<div class="git-file"><label><input type="checkbox" value="${escapeHtml(f.path)}" ${f.staged?"checked":""}  onchange="gitToggle(this)"><span class="git-status-badge">${escapeHtml(f.status)}</span>${escapeHtml(f.path)}</label></div>`).join("")||'<div class="git-msg">clean working tree</div>'}catch(e){document.getElementById("gitFiles").innerHTML='<div class="git-msg">git not available</div>'}
}
async function gitToggle(cb){const files=[cb.value];try{if(cb.checked)await fetch("/api/git/stage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({files})});else await fetch("/api/git/unstage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({files})});loadGitStatus()}catch(e){}}
async function gitCommit(){const msg=document.getElementById("commitMsg").value.trim();if(!msg){alert("Enter a commit message");return}try{const r=await fetch("/api/git/commit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg})});const d=await r.json();document.getElementById("gitOutput").textContent=d.output||d.error||"";document.getElementById("commitMsg").value="";loadGitStatus()}catch(e){document.getElementById("gitOutput").textContent="Commit failed"}}
async function gitPush(){try{const r=await fetch("/api/git/push",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})});const d=await r.json();document.getElementById("gitOutput").textContent=d.output||d.error||""}catch(e){document.getElementById("gitOutput").textContent="Push failed"}}

// ── Terminal ──────────────────────────────
function toggleTerminal(){document.getElementById("terminalPanel").classList.toggle("hidden");if(!document.getElementById("terminalPanel").classList.contains("hidden"))document.getElementById("terminalInput").focus()}
function clearTerminal(){document.getElementById("terminalOutput").innerHTML=""}
async function runTerminal(){const inp=document.getElementById("terminalInput");const cmd=inp.value.trim();if(!cmd)return;const out=document.getElementById("terminalOutput");out.innerHTML+=`<div class="term-cmd">$ ${escapeHtml(cmd)}</div>`;inp.value="";
  try{const r=await fetch("/api/terminal",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({command:cmd})});const d=await r.json();out.innerHTML+=`<div class="term-out${d.exit_code?' term-err':''}">${escapeHtml(d.output)}</div>`;out.scrollTop=out.scrollHeight}catch(e){out.innerHTML+=`<div class="term-out term-err">Error: ${escapeHtml(e.message)}</div>`}}

// ── Pinned Messages ──────────────────────
function pinMessage(){const last=messages.filter(m=>m.role==="assistant").pop();if(!last)return;pinnedMessages.push({content:last.content.slice(0,200),timestamp:Date.now()});renderPinned();saveState()}
function renderPinned(){const bar=document.getElementById("pinnedBar");const list=document.getElementById("pinnedList");if(!pinnedMessages.length){bar.classList.add("hidden");return}bar.classList.remove("hidden");list.innerHTML=pinnedMessages.map((p,i)=>`<div class="pinned-item"><span>${escapeHtml(p.content.slice(0,80))}...</span><button onclick="pinnedMessages.splice(${i},1);renderPinned();saveState()">&times;</button></div>`).join("")}

// ── Summarize ──────────────────────────────
async function summarizeChat(){if(messages.length<4||streaming)return;streaming=true;
  try{const model=document.getElementById("modelSelect").value;const summary_messages=[...messages,{role:"user",content:"Summarize this entire conversation in 2-3 concise paragraphs. Include key decisions, code changes, and outcomes."}];
    const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:summary_messages,model,provider:settings.provider,...(settings.api_key?{api_key:settings.api_key}:{})})});
    const reader=r.body.getReader();const decoder=new TextDecoder();let summary="",buffer="";
    while(true){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split("\n");buffer=lines.pop();for(const line of lines){if(!line.startsWith("data: "))continue;try{const d=JSON.parse(line.slice(6));if(d.type==="content")summary+=d.content}catch(e){}}}
    if(summary){messages=[{role:"system",content:`Previous conversation summary: ${summary}`},{role:"assistant",content:`**Conversation summarized.** Here's what we covered:\n\n${summary}`,timestamp:Date.now()}];
      messagesEl.innerHTML="";addMessage("assistant",messages[1].content,false,messages[1].timestamp);saveState()}}catch(e){}streaming=false}

// ── Auto Context ──────────────────────────
function detectFilePaths(text){const paths=new Set();const patterns=[/(?:^|\s)((?:\.\/|\.\.\/|\/|[a-zA-Z]:\\)[\w\-./\\]+\.\w+)/g,/(?:^|\s)([\w\-]+\.(?:py|js|ts|tsx|jsx|rs|go|java|rb|php|c|cpp|h|lua|css|html|json|yaml|yml|toml|sh))/g];for(const p of patterns){let m;while((m=p.exec(text))!==null)paths.add(m[1].trim())}return[...paths]}
async function attachContext(text){if(!settings.autoContext)return text;const paths=detectFilePaths(text);if(!paths.length)return text;let ctx="";for(const p of paths.slice(0,3)){try{const r=await fetch(`/api/files/read?path=${encodeURIComponent(p)}`);const d=await r.json();if(d.content)ctx+=`\n\nContents of ${p}:\n\`\`\`\n${d.content.slice(0,5000)}\n\`\`\`\n`}catch(e){}}return ctx?text+"\n\n[Auto-attached context:]"+ctx:text}

// ── Rendering ──────────────────────────────
function scrollToBottom(){if(autoScroll)messagesEl.scrollTop=messagesEl.scrollHeight}
function formatTime(ts){if(!ts)return"";return new Date(ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
function addLineNumbers(html){return html.split("\n").map((l,i)=>`<span class="line-number">${i+1}</span>${l}`).join("\n")}
function renderMarkdown(text){let html;try{html=marked.parse(text)}catch(e){html=escapeHtml(text)}
  html=html.replace(/<pre><code class="language-(\w+)">/g,'<pre><div class="code-header"><span>$1</span><button class="copy-btn" onclick="copyCode(this)">copy</button></div><code class="language-$1 line-numbers">');
  html=html.replace(/<pre><code(?! class)>/g,'<pre><div class="code-header"><span>text</span><button class="copy-btn" onclick="copyCode(this)">copy</button></div><code class="line-numbers">');return html}
function copyCode(btn){const c=btn.closest("pre").querySelector("code").textContent;navigator.clipboard.writeText(c).then(()=>{btn.textContent="copied";setTimeout(()=>btn.textContent="copy",2000)})}
function copyMessage(btn){navigator.clipboard.writeText(btn.closest(".message").querySelector(".message-body").innerText).then(()=>{btn.textContent="copied";setTimeout(()=>btn.textContent="copy",2000)})}

function addMessage(role,content,silent,timestamp){
  const w=messagesEl.querySelector(".welcome");if(w)w.remove();const div=document.createElement("div");div.className=`message ${role}`;const time=formatTime(timestamp||Date.now());
  const actions=role==="assistant"?`<div class="message-actions"><button class="msg-action-btn" onclick="copyMessage(this)">copy</button><button class="msg-action-btn" onclick="regenerate()">retry</button></div>`:"";
  div.innerHTML=`<div class="message-header"><span class="message-role">${role==="user"?"you":"tetsuo"}</span><span class="message-time">${time}</span>${actions}</div><div class="message-body">${role==="user"?escapeHtml(content).replace(/\n/g,"<br>"):renderMarkdown(content)}</div>`;
  div.querySelectorAll("code.line-numbers").forEach(c=>{if(!c.querySelector(".line-number"))c.innerHTML=addLineNumbers(c.innerHTML)});
  messagesEl.appendChild(div);if(!silent)scrollToBottom();return div}
function escapeHtml(t){const d=document.createElement("div");d.textContent=t;return d.innerHTML}

function addThinking(){const w=messagesEl.querySelector(".welcome");if(w)w.remove();document.title="tetsuocode ...";const div=document.createElement("div");div.className="message assistant";div.id="streamingMessage";div.innerHTML=`<div class="message-header"><span class="message-role">tetsuo</span></div><div class="message-body"><div class="thinking"><div class="thinking-dots"><span></span><span></span><span></span></div></div></div>`;messagesEl.appendChild(div);scrollToBottom();return div}
function showToolThinking(){const sm=document.getElementById("streamingMessage");if(!sm)return;const b=sm.querySelector(".message-body");if(!b.querySelector(".tool-thinking")){const el=document.createElement("div");el.className="tool-thinking";el.innerHTML=`<div class="thinking"><div class="thinking-dots"><span></span><span></span><span></span></div><span>running...</span></div>`;b.appendChild(el)}scrollToBottom()}
function removeToolThinking(){const el=document.querySelector("#streamingMessage .tool-thinking");if(el)el.remove()}

function renderDiff(diff){if(!diff)return"";return`<div class="diff-side-by-side">${renderSideBySide(diff)}</div>`}
function renderSideBySide(diff){const lines=diff.split("\n");let left=[],right=[];
  for(const line of lines){if(line.startsWith("---")||line.startsWith("+++"))continue;if(line.startsWith("@@")){left.push({type:"hunk",text:line});right.push({type:"hunk",text:line});continue}
    if(line.startsWith("-")){left.push({type:"del",text:line.slice(1)});right.push({type:"empty",text:""})}
    else if(line.startsWith("+")){left.push({type:"empty",text:""});right.push({type:"add",text:line.slice(1)})}
    else{left.push({type:"ctx",text:line.slice(1)||line});right.push({type:"ctx",text:line.slice(1)||line})}}
  const renderCol=(col)=>col.map(l=>`<div class="diff-line diff-${l.type}">${escapeHtml(l.text)}</div>`).join("");
  return`<div class="diff-col">${renderCol(left)}</div><div class="diff-col">${renderCol(right)}</div>`}

function formatToolOutput(raw){try{const p=JSON.parse(raw);if(p.diff)return renderDiff(p.diff)+`<div class="diff-meta">${escapeHtml(p.path||"")}</div>`;if(p.image&&p.data)return`<img src="data:${p.mime};base64,${p.data}" style="max-width:100%;border-radius:4px">`;return escapeHtml(JSON.stringify(p,null,2))}catch(e){return escapeHtml(raw)}}

function addToolCall(name,args){const sm=document.getElementById("streamingMessage");if(!sm)return;removeToolThinking();const b=sm.querySelector(".message-body");const div=document.createElement("div");div.className="tool-call";let preview=args;try{preview=JSON.stringify(JSON.parse(args),null,2)}catch(e){}if(preview.length>200)preview=preview.slice(0,200)+"...";
  div.innerHTML=`<div class="tool-call-header" onclick="this.parentElement.classList.toggle('collapsed')"><span class="tool-collapse-icon">&#9660;</span><span class="tool-name">${escapeHtml(name)}</span><span class="tool-status">running</span></div><div class="tool-call-body"><code>${escapeHtml(preview)}</code></div>`;b.appendChild(div);showToolThinking();scrollToBottom()}
function addToolResult(name,result){const sm=document.getElementById("streamingMessage");if(!sm)return;removeToolThinking();const divs=sm.querySelectorAll(".tool-call");if(divs.length){const last=divs[divs.length-1];let preview=result;if(preview.length>1000)preview=preview.slice(0,1000)+"...";last.querySelector(".tool-call-body").innerHTML=`<code>${formatToolOutput(preview)}</code>`;const st=last.querySelector(".tool-status");if(st)st.textContent="done";last.classList.add("collapsed")}showToolThinking();scrollToBottom()}

function playNotification(){if(!settings.sound)return;try{const ctx=new(window.AudioContext||window.webkitAudioContext)();const o=ctx.createOscillator();const g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=660;g.gain.value=0.08;o.start();o.stop(ctx.currentTime+0.12)}catch(e){}}

// ── Chat ──────────────────────────────
async function sendMessage(retryText){
  let text=retryText||inputEl.value.trim();if(!text||streaming)return;
  if(!retryText){text=await attachContext(text);addMessage("user",text,false,Date.now());messages.push({role:"user",content:text,timestamp:Date.now()})}
  if(messages.filter(m=>m.role==="user").length===1)chatTitleEl.textContent=text.length>40?text.slice(0,40)+"...":text;
  inputEl.value="";inputEl.style.height="auto";streaming=true;sendBtn.classList.add("hidden");cancelBtn.classList.remove("hidden");
  const streamMsg=addThinking();const body=streamMsg.querySelector(".message-body");let fullContent="";let hadError=false;abortController=new AbortController();
  try{const model=document.getElementById("modelSelect").value;const payload={messages,model,provider:settings.provider};if(settings.temperature!==0.7)payload.temperature=settings.temperature;if(settings.max_tokens!==4096)payload.max_tokens=settings.max_tokens;if(settings.system_prompt)payload.system_prompt=settings.system_prompt;if(settings.api_key)payload.api_key=settings.api_key;
    const resp=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:abortController.signal});if(!resp.ok)throw new Error(`server returned ${resp.status}`);
    const reader=resp.body.getReader();const decoder=new TextDecoder();let buffer="";
    while(true){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split("\n");buffer=lines.pop();
      for(const line of lines){if(!line.startsWith("data: "))continue;let data;try{data=JSON.parse(line.slice(6))}catch(e){continue}
        if(data.type==="content"){if(!fullContent)body.innerHTML="";removeToolThinking();fullContent+=data.content;body.innerHTML=renderMarkdown(fullContent);body.classList.add("streaming-cursor");body.querySelectorAll("code.line-numbers").forEach(c=>{if(!c.querySelector(".line-number"))c.innerHTML=addLineNumbers(c.innerHTML)});scrollToBottom()}
        else if(data.type==="tool_call"){if(!fullContent)body.innerHTML="";addToolCall(data.name,data.args)}
        else if(data.type==="tool_result"){addToolResult(data.name,data.result)}
        else if(data.type==="usage"){totalTokens.prompt+=data.usage.prompt_tokens||0;totalTokens.completion+=data.usage.completion_tokens||0;totalTokens.total+=data.usage.total_tokens||0;updateTokenDisplay()}
        else if(data.type==="error"){removeToolThinking();hadError=true;body.innerHTML=`<span class="error-text">${escapeHtml(data.content)}</span><button class="retry-btn" onclick="retryLast()">retry</button>`}
        else if(data.type==="done"){removeToolThinking()}}
    }
  }catch(e){removeToolThinking();if(e.name==="AbortError"){if(!fullContent)body.innerHTML='<span class="dim-text">cancelled</span>'}else{hadError=true;let msg="connection failed";if(e.message.includes("server returned"))msg=e.message;else if(e.message.includes("Failed to fetch")||e.message.includes("NetworkError"))msg="network error";body.innerHTML=`<span class="error-text">${escapeHtml(msg)}</span><button class="retry-btn" onclick="retryLast()">retry</button>`}}
  body.classList.remove("streaming-cursor");removeToolThinking();streamMsg.removeAttribute("id");document.title="tetsuocode";
  if(fullContent){messages.push({role:"assistant",content:fullContent,timestamp:Date.now()});if(messages.filter(m=>m.role==="user").length===1)generateTitle(messages[0].content,fullContent);playNotification()}
  streaming=false;abortController=null;sendBtn.classList.remove("hidden");cancelBtn.classList.add("hidden");saveState();renderChatHistory();inputEl.focus()}

function cancelStream(){if(abortController)abortController.abort()}
function retryLast(){if(streaming)return;const all=messagesEl.querySelectorAll(".message");if(all.length)all[all.length-1].remove();const last=[...messages].reverse().find(m=>m.role==="user");if(last)sendMessage(last.content)}
function regenerate(){if(streaming)return;const all=messagesEl.querySelectorAll(".message");if(all.length)all[all.length-1].remove();while(messages.length&&messages[messages.length-1].role==="assistant")messages.pop();const last=[...messages].reverse().find(m=>m.role==="user");if(last)sendMessage(last.content)}

async function generateTitle(userMsg,assistantMsg){try{const model=document.getElementById("modelSelect").value;const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:[{role:"user",content:userMsg},{role:"assistant",content:assistantMsg.slice(0,500)},{role:"user",content:"Generate a 3-5 word title for this conversation. Reply with ONLY the title, no quotes, no punctuation, all lowercase."}],model,provider:settings.provider,...(settings.api_key?{api_key:settings.api_key}:{})})});
  const reader=r.body.getReader();const decoder=new TextDecoder();let title="",buffer="";while(true){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split("\n");buffer=lines.pop();for(const line of lines){if(!line.startsWith("data: "))continue;try{const d=JSON.parse(line.slice(6));if(d.type==="content")title+=d.content}catch(e){}}}
  title=title.trim().toLowerCase().replace(/['"`.]/g,"");if(title&&title.length>0&&title.length<60){chatTitleEl.textContent=title;saveState();renderChatHistory()}}catch(e){}}

function toggleSidebar(){document.querySelector(".sidebar").classList.toggle("open");document.getElementById("sidebarOverlay").classList.toggle("hidden")}

// Templates
const defaultTemplates=[{name:"explain code",prompt:"Explain what this code does"},{name:"find bugs",prompt:"Find and fix any bugs"},{name:"write tests",prompt:"Write comprehensive tests"},{name:"refactor",prompt:"Refactor for performance and readability"},{name:"add docs",prompt:"Add documentation"},{name:"security audit",prompt:"Review for security vulnerabilities"}];
function toggleTemplates(){document.getElementById("templateMenu").classList.toggle("hidden");if(!document.getElementById("templateMenu").classList.contains("hidden"))renderTemplates()}
function renderTemplates(){let saved=[];try{saved=JSON.parse(localStorage.getItem("tetsuocode_templates")||"[]")}catch(e){}const all=[...defaultTemplates,...saved];document.getElementById("templateMenu").innerHTML=all.map((t,i)=>`<div class="template-item" onclick="useTemplate(${i})"><span>${escapeHtml(t.name)}</span></div>`).join("")+`<div class="template-item template-save" onclick="saveTemplate()"><span>+ save as template</span></div>`}
function useTemplate(i){let saved=[];try{saved=JSON.parse(localStorage.getItem("tetsuocode_templates")||"[]")}catch(e){}const all=[...defaultTemplates,...saved];if(all[i]){inputEl.value=all[i].prompt;inputEl.focus()}document.getElementById("templateMenu").classList.add("hidden")}
function saveTemplate(){const text=inputEl.value.trim();if(!text){alert("Type a prompt first");return}const name=prompt("Template name:");if(!name)return;let saved=[];try{saved=JSON.parse(localStorage.getItem("tetsuocode_templates")||"[]")}catch(e){}saved.push({name,prompt:text});localStorage.setItem("tetsuocode_templates",JSON.stringify(saved));document.getElementById("templateMenu").classList.add("hidden")}

// ── Init ──────────────────────────────
(async function(){loadTheme();const ok=await checkAuth();if(ok)loadState();inputEl.focus()})();
