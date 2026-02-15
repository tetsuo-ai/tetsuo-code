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
let editorTabs = [];
let splitMode = false;
let splitTab = null;
let selectedFiles = new Set();
let trash = [];
let mentionSearch = null;
let settings = { temperature: 0.7, max_tokens: 4096, system_prompt: "", provider: "xai", api_key: "", sound: false, autoContext: false, contextMode: "smart" };

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

inputEl.addEventListener("input", () => { inputEl.style.height = "auto"; inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px"; checkMentions(); });
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (mentionSearch !== null) { selectMention(); return; } sendMessage(); }
  if (e.key === "Escape") { if (mentionSearch !== null) { hideMentionDropdown(); return; } if (streaming) cancelStream(); }
  if (e.key === "ArrowDown" && mentionSearch !== null) { e.preventDefault(); navigateMention(1); }
  if (e.key === "ArrowUp" && mentionSearch !== null) { e.preventDefault(); navigateMention(-1); }
  if (e.key === "Tab" && mentionSearch !== null) { e.preventDefault(); selectMention(); }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (streaming) cancelStream(); else if (!document.getElementById("searchOverlay").classList.contains("hidden")) closeSearch(); else if (!document.getElementById("paletteOverlay").classList.contains("hidden")) closePalette(); else if (!document.getElementById("quickOpenOverlay").classList.contains("hidden")) closeQuickOpen(); else if (!document.getElementById("wsearchOverlay").classList.contains("hidden")) closeWorkspaceSearch(); else if (!document.getElementById("shortcutsOverlay").classList.contains("hidden")) closeShortcuts(); closeContextMenu(); }
  if (e.key === "n" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!streaming) newChat(); }
  if (e.key === "," && (e.ctrlKey || e.metaKey)) { e.preventDefault(); toggleSettings(); }
  if (e.key === "f" && (e.ctrlKey || e.metaKey) && e.shiftKey) { e.preventDefault(); openWorkspaceSearch(); }
  else if (e.key === "f" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openSearch(); }
  if (e.key === "h" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); toggleEditorFind(); }
  if (e.key === "k" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openPalette(); }
  if (e.key === "p" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openQuickOpen(); }
  if (e.key === "`" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); toggleTerminal(); }
  if (e.key === "/" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openShortcuts(); }
  if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey && document.activeElement !== inputEl && document.activeElement.tagName !== "TEXTAREA") { e.preventDefault(); undoLastEdit(); }
});

messagesEl.addEventListener("scroll", () => { const {scrollTop,scrollHeight,clientHeight}=messagesEl; autoScroll=scrollHeight-scrollTop-clientHeight<60; });
chatArea.addEventListener("dragover", (e) => { e.preventDefault(); document.getElementById("dropZone").classList.remove("hidden"); });
chatArea.addEventListener("dragleave", (e) => { if (!chatArea.contains(e.relatedTarget)) document.getElementById("dropZone").classList.add("hidden"); });
chatArea.addEventListener("drop", (e) => { e.preventDefault(); document.getElementById("dropZone").classList.add("hidden"); if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]); });
document.addEventListener("click", () => closeContextMenu());

function insertPrompt(text) { inputEl.value = text; inputEl.focus(); sendMessage(); }

// ── Auth ──────────────────────────────────
async function checkAuth() { try { const r = await fetch("/api/auth/check"); const d = await r.json(); if (d.required && !d.authenticated) { document.getElementById("loginOverlay").classList.remove("hidden"); return false; } } catch(e) {} return true; }
async function submitLogin() { try { const r = await fetch("/api/auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("loginPassword").value})}); if (r.ok) { document.getElementById("loginOverlay").classList.add("hidden"); loadState(); } else document.getElementById("loginError").classList.remove("hidden"); } catch(e) { document.getElementById("loginError").classList.remove("hidden"); } }
document.getElementById("loginPassword").addEventListener("keydown",(e)=>{if(e.key==="Enter")submitLogin()});

// ── Persistence ──────────────────────────────
function saveState() { if (!currentChatId) return; chats[currentChatId]={title:chatTitleEl.textContent,messages,tokens:totalTokens,pinned:pinnedMessages,forkedFrom:chats[currentChatId]?.forkedFrom||null}; try{localStorage.setItem("tetsuocode_chats",JSON.stringify(chats));localStorage.setItem("tetsuocode_current",currentChatId)}catch(e){} saveSessionState(); }
function loadSettings() { try{const s=localStorage.getItem("tetsuocode_settings");if(s)settings={...settings,...JSON.parse(s)}}catch(e){} }
function saveSettings() { try{localStorage.setItem("tetsuocode_settings",JSON.stringify(settings))}catch(e){} }
function loadState() { loadSettings(); loadTrash(); loadSessionSnapshots(); populateModels(); try { const saved=localStorage.getItem("tetsuocode_chats"); const current=localStorage.getItem("tetsuocode_current"); if(saved){chats=JSON.parse(saved);renderChatHistory();if(current&&chats[current]){loadChat(current);return;}} } catch(e){} newChat(); restoreSessionState(); }
function populateModels() { const sel = document.getElementById("modelSelect"); const models = PROVIDER_MODELS[settings.provider] || PROVIDER_MODELS.xai; sel.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join(""); }

function renderChatHistory() {
  chatHistoryEl.innerHTML="";
  const ids=Object.keys(chats).sort((a,b)=>Number(b)-Number(a));
  for(const id of ids){const c=chats[id];const item=document.createElement("div");item.className="chat-item"+(id===currentChatId?" active":"");
    const label = c.forkedFrom ? "&#9095; " : "";
    item.innerHTML=`<span>${label}${escapeHtml(c.title||"new chat")}</span>`;
    const actions=document.createElement("div");actions.className="chat-item-actions";
    const fork=document.createElement("button");fork.className="chat-action-btn";fork.innerHTML="&#9095;";fork.title="Fork";fork.onclick=(e)=>{e.stopPropagation();forkChat(id)};
    const del=document.createElement("button");del.className="chat-delete";del.innerHTML="&times;";del.onclick=(e)=>{e.stopPropagation();deleteChat(id)};
    actions.appendChild(fork);actions.appendChild(del);item.appendChild(actions);
    item.onclick=()=>{if(streaming)return;saveState();loadChat(id)};chatHistoryEl.appendChild(item);}
  renderTrash();renderForkTree();
}

function loadChat(id) {
  const c=chats[id]; if(!c)return; currentChatId=id; messages=c.messages||[]; totalTokens=c.tokens||{prompt:0,completion:0,total:0}; pinnedMessages=c.pinned||[];
  chatTitleEl.textContent=c.title||"new chat"; updateTokenDisplay();
  messagesEl.innerHTML=""; if(!messages.length)showWelcome(); else for(let i=0;i<messages.length;i++){const m=messages[i];if(m.role==="user"||m.role==="assistant")addMessage(m.role,m.content,true,m.timestamp,i)}
  renderPinned(); renderChatHistory(); inputEl.focus();
}
function deleteChat(id){ const chat=chats[id]; if(chat){trash.push({id,...chat,deletedAt:Date.now()});saveTrash()} delete chats[id];try{localStorage.setItem("tetsuocode_chats",JSON.stringify(chats))}catch(e){} if(id===currentChatId){const r=Object.keys(chats);r.length?loadChat(r.sort((a,b)=>Number(b)-Number(a))[0]):newChat()}else renderChatHistory() }
function newChat(){if(currentChatId&&messages.length)saveState();messages=[];totalTokens={prompt:0,completion:0,total:0};pinnedMessages=[];currentChatId=Date.now().toString();chatTitleEl.textContent="new chat";tokenCountEl.textContent="";document.getElementById("tokenCost").textContent="";messagesEl.innerHTML="";showWelcome();renderChatHistory();updateContextBar();inputEl.focus()}
function showWelcome(){messagesEl.innerHTML=`<div class="welcome"><h1>tetsuocode</h1><p>ai coding assistant powered by grok</p><div class="welcome-hints"><div class="hint" onclick="insertPrompt('explain this codebase')">explain this codebase</div><div class="hint" onclick="insertPrompt('find and fix bugs')">find and fix bugs</div><div class="hint" onclick="insertPrompt('write tests for this project')">write tests</div><div class="hint" onclick="insertPrompt('refactor for performance')">refactor for performance</div></div></div>`}

// ── Trash ──────────────────────────
function loadTrash(){try{trash=JSON.parse(localStorage.getItem("tetsuocode_trash")||"[]")}catch(e){trash=[]}}
function saveTrash(){try{localStorage.setItem("tetsuocode_trash",JSON.stringify(trash.slice(-50)))}catch(e){}}
function renderTrash(){const section=document.getElementById("trashSection");const list=document.getElementById("trashList");const count=document.getElementById("trashCount");if(!trash.length){section.classList.add("hidden");return}section.classList.remove("hidden");count.textContent=`(${trash.length})`;list.innerHTML=trash.slice().reverse().map((t,i)=>{const ri=trash.length-1-i;return`<div class="trash-item"><span>${escapeHtml(t.title||"untitled")}</span><div class="trash-item-actions"><button onclick="restoreFromTrash(${ri})" title="Restore">&#8634;</button><button onclick="permanentDelete(${ri})" title="Delete">&times;</button></div></div>`}).join("")}
function toggleTrashList(){document.getElementById("trashList").classList.toggle("hidden")}
function restoreFromTrash(i){const t=trash.splice(i,1)[0];if(!t)return;const id=t.id||Date.now().toString();delete t.deletedAt;delete t.id;chats[id]=t;try{localStorage.setItem("tetsuocode_chats",JSON.stringify(chats))}catch(e){}saveTrash();renderChatHistory()}
function permanentDelete(i){trash.splice(i,1);saveTrash();renderTrash()}
function emptyTrash(){trash=[];saveTrash();renderTrash()}

// ── Token Cost & Context ──────────────────────
function updateTokenDisplay(){tokenCountEl.textContent=totalTokens.total?`${totalTokens.total.toLocaleString()} tokens`:"";const model=document.getElementById("modelSelect").value;const pricing=MODEL_PRICING[model];if(pricing&&totalTokens.total){const cost=(totalTokens.prompt*pricing[0]+totalTokens.completion*pricing[1])/1000000;document.getElementById("tokenCost").textContent=`~$${cost.toFixed(4)}`}updateContextBar()}
function updateContextBar(){
  const model=document.getElementById("modelSelect").value;const limit=CONTEXT_LIMITS[model]||131072;
  // Use server-reported tokens if available, otherwise estimate from message content
  let used=totalTokens.total;
  if(!used){let est=0;for(const m of messages)est+=estimateTokens(m.content);used=est}
  const pct=Math.min((used/limit)*100,100);
  const fill=document.getElementById("contextFill");fill.style.width=pct+"%";
  fill.className="context-fill"+(pct>80?" ctx-red":pct>50?" ctx-yellow":"");
  const bar=document.getElementById("contextBar");
  bar.title=`${used.toLocaleString()} / ${limit.toLocaleString()} tokens (${Math.round(pct)}%) — mode: ${settings.contextMode||"smart"}`;
}

// ── Export/Import ──────────────────────────
function exportChats(){const b=new Blob([JSON.stringify(chats,null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=`tetsuocode-${new Date().toISOString().slice(0,10)}.json`;a.click();URL.revokeObjectURL(a.href)}
function importChats(){const i=document.createElement("input");i.type="file";i.accept=".json";i.onchange=(e)=>{const r=new FileReader();r.onload=(ev)=>{try{Object.assign(chats,JSON.parse(ev.target.result));localStorage.setItem("tetsuocode_chats",JSON.stringify(chats));renderChatHistory()}catch(err){alert("Invalid JSON")}};r.readAsText(e.target.files[0])};i.click()}
function exportMarkdown(){if(!messages.length)return;let md=`# ${chatTitleEl.textContent}\n\n`;for(const m of messages){if(m.role==="user")md+=`## You\n\n${m.content}\n\n`;else if(m.role==="assistant")md+=`## Tetsuo\n\n${m.content}\n\n`}const b=new Blob([md],{type:"text/markdown"});const a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=`${chatTitleEl.textContent.replace(/[^a-z0-9]/gi,"-")}.md`;a.click();URL.revokeObjectURL(a.href)}
// uploadFile moved below (multimodal version)

// ── Settings ──────────────────────────────
function toggleSettings(){const p=document.getElementById("settingsPanel");if(!p.classList.contains("hidden")){p.classList.add("hidden");return}document.getElementById("settingProvider").value=settings.provider;document.getElementById("settingApiKey").value=settings.api_key;document.getElementById("settingTemp").value=settings.temperature;document.getElementById("tempValue").textContent=settings.temperature;document.getElementById("settingMaxTokens").value=settings.max_tokens;document.getElementById("settingSystemPrompt").value=settings.system_prompt;document.getElementById("settingSound").checked=settings.sound;document.getElementById("settingAutoContext").checked=settings.autoContext;document.getElementById("settingContextMode").value=settings.contextMode||"smart";document.getElementById("settingApproval").checked=settings.requireApproval||false;loadMcpServers();p.classList.remove("hidden")}
function onProviderChange(){const p=document.getElementById("settingProvider").value;document.getElementById("modelSelect").innerHTML=(PROVIDER_MODELS[p]||[]).map(m=>`<option value="${m}">${m}</option>`).join("")}
function onPresetChange(){document.getElementById("settingSystemPrompt").value=SYSTEM_PRESETS[document.getElementById("settingPreset").value]||""}
function applySettings(){settings.provider=document.getElementById("settingProvider").value;settings.api_key=document.getElementById("settingApiKey").value;settings.temperature=parseFloat(document.getElementById("settingTemp").value)||0.7;settings.max_tokens=parseInt(document.getElementById("settingMaxTokens").value)||4096;settings.system_prompt=document.getElementById("settingSystemPrompt").value.trim();settings.sound=document.getElementById("settingSound").checked;settings.autoContext=document.getElementById("settingAutoContext").checked;settings.contextMode=document.getElementById("settingContextMode").value;settings.requireApproval=document.getElementById("settingApproval").checked;saveSettings();populateModels();fetch("/api/settings/approval",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({require:settings.requireApproval})}).catch(()=>{});toggleSettings()}

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
  {name:"Open File",key:"Ctrl+P",action:()=>openQuickOpen()},
  {name:"Search Messages",key:"Ctrl+F",action:()=>openSearch()},
  {name:"Search Workspace",key:"Ctrl+Shift+F",action:()=>openWorkspaceSearch()},
  {name:"Settings",key:"Ctrl+,",action:()=>toggleSettings()},
  {name:"Toggle Terminal",key:"Ctrl+`",action:()=>toggleTerminal()},
  {name:"Toggle Files",action:()=>switchTab("files")},
  {name:"Toggle Git",action:()=>switchTab("git")},
  {name:"Toggle Outline",action:()=>switchTab("outline")},
  {name:"Toggle Theme",action:()=>toggleTheme()},
  {name:"Toggle Split Editor",action:()=>toggleSplitEditor()},
  {name:"Find in Editor",key:"Ctrl+H",action:()=>toggleEditorFind()},
  {name:"Undo Last Edit",key:"Ctrl+Z",action:()=>undoLastEdit()},
  {name:"Rename Symbol",action:()=>promptRename()},
  {name:"Fork Chat",action:()=>forkCurrentChat()},
  {name:"Export JSON",action:()=>exportChats()},
  {name:"Export Markdown",action:()=>exportMarkdown()},
  {name:"Summarize Chat",action:()=>summarizeChat()},
  {name:"Keyboard Shortcuts",key:"Ctrl+/",action:()=>openShortcuts()},
  {name:"Save Session",action:()=>saveSessionSnapshot()},
  {name:"Change Workspace",action:()=>changeWorkspace()},
  {name:"Clear Terminal",action:()=>clearTerminal()},
  {name:"Empty Trash",action:()=>emptyTrash()},
];
function openPalette(){document.getElementById("paletteOverlay").classList.remove("hidden");document.getElementById("paletteInput").value="";filterPalette("");document.getElementById("paletteInput").focus()}
function closePalette(){document.getElementById("paletteOverlay").classList.add("hidden")}
function filterPalette(q){const list=document.getElementById("paletteList");const filtered=PALETTE_COMMANDS.filter(c=>c.name.toLowerCase().includes(q.toLowerCase()));list.innerHTML=filtered.map((c,i)=>`<div class="palette-item${i===0?" active":""}" onclick="execPalette(${PALETTE_COMMANDS.indexOf(c)})" onmouseenter="this.parentElement.querySelectorAll('.active').forEach(e=>e.classList.remove('active'));this.classList.add('active')"><span>${c.name}</span>${c.key?`<span class="palette-key">${c.key}</span>`:""}</div>`).join("")}
function execPalette(i){closePalette();PALETTE_COMMANDS[i].action()}
document.getElementById("paletteInput").addEventListener("keydown",(e)=>{const items=document.querySelectorAll(".palette-item");const active=document.querySelector(".palette-item.active");if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();if(!active)return;const idx=[...items].indexOf(active);const next=e.key==="ArrowDown"?Math.min(idx+1,items.length-1):Math.max(idx-1,0);active.classList.remove("active");items[next].classList.add("active");items[next].scrollIntoView({block:"nearest"})}if(e.key==="Enter"){e.preventDefault();if(active)active.click()}});

// ── Quick Open (Ctrl+P) ──────────────────────
let quickOpenDebounce = null;
function openQuickOpen(){document.getElementById("quickOpenOverlay").classList.remove("hidden");document.getElementById("quickOpenInput").value="";document.getElementById("quickOpenList").innerHTML='<div class="quickopen-hint">start typing to search files...</div>';document.getElementById("quickOpenInput").focus()}
function closeQuickOpen(){document.getElementById("quickOpenOverlay").classList.add("hidden")}
function searchFilesQuick(q){clearTimeout(quickOpenDebounce);if(!q.trim()){document.getElementById("quickOpenList").innerHTML='<div class="quickopen-hint">start typing to search files...</div>';return}quickOpenDebounce=setTimeout(async()=>{try{const r=await fetch(`/api/files/search?q=${encodeURIComponent(q)}`);const d=await r.json();const list=document.getElementById("quickOpenList");if(!d.files.length){list.innerHTML='<div class="quickopen-hint">no files found</div>';return}list.innerHTML=d.files.map((f,i)=>`<div class="quickopen-item${i===0?" active":""}" onclick="quickOpenFile('${f.path.replace(/'/g,"\\'")}')" onmouseenter="this.parentElement.querySelectorAll('.active').forEach(e=>e.classList.remove('active'));this.classList.add('active')"><span class="quickopen-name">${escapeHtml(f.name)}</span><span class="quickopen-path">${escapeHtml(f.rel)}</span></div>`).join("")}catch(e){}},150)}
function quickOpenFile(path){closeQuickOpen();openInEditor(path)}
document.getElementById("quickOpenInput").addEventListener("keydown",(e)=>{const items=document.querySelectorAll(".quickopen-item");const active=document.querySelector(".quickopen-item.active");if(e.key==="ArrowDown"||e.key==="ArrowUp"){e.preventDefault();if(!active||!items.length)return;const idx=[...items].indexOf(active);const next=e.key==="ArrowDown"?Math.min(idx+1,items.length-1):Math.max(idx-1,0);active.classList.remove("active");items[next].classList.add("active");items[next].scrollIntoView({block:"nearest"})}if(e.key==="Enter"){e.preventDefault();if(active)active.click()}});

// ── Workspace Search (Ctrl+Shift+F) ──────────────
let wsearchDebounce = null;
function openWorkspaceSearch(){document.getElementById("wsearchOverlay").classList.remove("hidden");document.getElementById("wsearchQuery").focus()}
function closeWorkspaceSearch(){document.getElementById("wsearchOverlay").classList.add("hidden")}
function toggleWSearchReplace(){document.getElementById("wsearchReplace").classList.toggle("hidden");document.getElementById("wsearchActions").classList.toggle("hidden")}
function debounceWSearch(){clearTimeout(wsearchDebounce);wsearchDebounce=setTimeout(doWorkspaceSearch,300)}
async function doWorkspaceSearch(){
  const q=document.getElementById("wsearchQuery").value.trim();if(!q){document.getElementById("wsearchResults").innerHTML="";return}
  const cs=document.getElementById("wsearchCase").checked;const rx=document.getElementById("wsearchRegex").checked;
  try{const r=await fetch(`/api/files/grep?q=${encodeURIComponent(q)}&case=${cs}&regex=${rx}`);const d=await r.json();
    if(d.error){document.getElementById("wsearchResults").innerHTML=`<div class="wsearch-msg">${escapeHtml(d.error)}</div>`;return}
    const results=document.getElementById("wsearchResults");
    document.getElementById("wsearchSummary").textContent=`${d.count} results`;
    if(!d.results.length){results.innerHTML='<div class="wsearch-msg">no results</div>';return}
    // Group by file
    const grouped={};d.results.forEach(r=>{(grouped[r.file]=grouped[r.file]||[]).push(r)});
    results.innerHTML=Object.entries(grouped).map(([file,matches])=>`<div class="wsearch-file"><div class="wsearch-file-name" onclick="this.nextElementSibling.classList.toggle('hidden')">${escapeHtml(file)} <span class="wsearch-file-count">(${matches.length})</span></div><div class="wsearch-file-matches">${matches.map(m=>`<div class="wsearch-match" onclick="openInEditor('${m.path.replace(/'/g,"\\'")}')"><span class="wsearch-line-num">${m.line}</span><span>${escapeHtml(m.text)}</span></div>`).join("")}</div></div>`).join("")
  }catch(e){document.getElementById("wsearchResults").innerHTML='<div class="wsearch-msg">search failed</div>'}
}
async function replaceAllWorkspace(){
  const q=document.getElementById("wsearchQuery").value.trim();const rep=document.getElementById("wsearchReplace").value;
  if(!q){return}if(!confirm(`Replace all occurrences of "${q}" with "${rep}"?`))return;
  const cs=document.getElementById("wsearchCase").checked;const rx=document.getElementById("wsearchRegex").checked;
  try{const r=await fetch("/api/files/replace",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:q,replacement:rep,regex:rx,case:cs})});const d=await r.json();
    showNotification(`Replaced ${d.replaced} occurrences in ${d.files} files`);doWorkspaceSearch()}catch(e){showNotification("Replace failed","error")}
}

// ── Keyboard Shortcuts (Ctrl+/) ──────────────
function openShortcuts(){document.getElementById("shortcutsOverlay").classList.remove("hidden")}
function closeShortcuts(){document.getElementById("shortcutsOverlay").classList.add("hidden")}

// ── Context Menu (right-click in editor) ──────
document.getElementById("editorContent").addEventListener("contextmenu",(e)=>{
  const sel=document.getElementById("editorContent").value.substring(document.getElementById("editorContent").selectionStart,document.getElementById("editorContent").selectionEnd);
  if(!sel)return; // only show for selections
  e.preventDefault();const menu=document.getElementById("contextMenu");menu.style.left=e.clientX+"px";menu.style.top=e.clientY+"px";menu.classList.remove("hidden");menu.dataset.selection=sel;
});
function closeContextMenu(){document.getElementById("contextMenu").classList.add("hidden")}
function contextAction(action){
  const sel=document.getElementById("contextMenu").dataset.selection||"";closeContextMenu();
  if(!sel)return;
  if(action==="rename"){const active=editorTabs.find(t=>t.active);promptRenameSymbol(sel);return}
  const prompts={explain:"Explain this code:\n\n```\n"+sel+"\n```",fix:"Fix any bugs in this code:\n\n```\n"+sel+"\n```",test:"Write tests for this code:\n\n```\n"+sel+"\n```",refactor:"Refactor this code for clarity and performance:\n\n```\n"+sel+"\n```",docs:"Add documentation/comments to this code:\n\n```\n"+sel+"\n```"};
  inputEl.value=prompts[action]||sel;inputEl.style.height=Math.min(inputEl.scrollHeight,200)+"px";inputEl.focus();
}

// ── Rename Symbol ──────────────────────────
function promptRename(){const name=prompt("Enter symbol name to rename:");if(!name)return;const newName=prompt(`Rename "${name}" to:`);if(!newName)return;doRenameSymbol(name,newName)}
function promptRenameSymbol(oldName){const newName=prompt(`Rename "${oldName}" to:`);if(!newName)return;doRenameSymbol(oldName,newName)}
async function doRenameSymbol(oldName,newName){
  try{const r=await fetch("/api/files/rename-symbol",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({old_name:oldName,new_name:newName})});const d=await r.json();
    if(d.error){showNotification(d.error,"error");return}
    showNotification(`Renamed "${oldName}" to "${newName}": ${d.replaced} occurrences in ${d.files} files`);
    // Refresh open editor tabs
    for(const tab of editorTabs){try{const r2=await fetch(`/api/files/read?path=${encodeURIComponent(tab.path)}`);const d2=await r2.json();if(d2.content!==undefined){tab.content=d2.content;tab.original=d2.content}}catch(e){}}
    renderEditorTabs()}catch(e){showNotification("Rename failed","error")}
}

// ── @ Mentions ──────────────────────────
let mentionDebounce=null;
function checkMentions(){const val=inputEl.value;const pos=inputEl.selectionStart;const before=val.slice(0,pos);const atIdx=before.lastIndexOf("@");if(atIdx===-1||(atIdx>0&&before[atIdx-1]!==" "&&before[atIdx-1]!=="\n")){hideMentionDropdown();return}const query=before.slice(atIdx+1);if(query.includes(" ")||query.length>40){hideMentionDropdown();return}mentionSearch={atIdx,query};clearTimeout(mentionDebounce);mentionDebounce=setTimeout(()=>fetchMentions(query),150)}
async function fetchMentions(q){try{const r=await fetch(`/api/files/search?q=${encodeURIComponent(q)}`);const d=await r.json();showMentionDropdown(d.files.slice(0,8))}catch(e){hideMentionDropdown()}}
function showMentionDropdown(files){const dd=document.getElementById("mentionDropdown");if(!files.length){hideMentionDropdown();return}dd.classList.remove("hidden");dd.innerHTML=files.map((f,i)=>`<div class="mention-item${i===0?" active":""}" onmousedown="insertMention('${f.path.replace(/'/g,"\\'")}')" onmouseenter="this.parentElement.querySelectorAll('.active').forEach(e=>e.classList.remove('active'));this.classList.add('active')"><span class="mention-name">${escapeHtml(f.name)}</span><span class="mention-path">${escapeHtml(f.rel)}</span></div>`).join("")}
function hideMentionDropdown(){mentionSearch=null;document.getElementById("mentionDropdown").classList.add("hidden")}
function navigateMention(dir){const items=document.querySelectorAll(".mention-item");const active=document.querySelector(".mention-item.active");if(!active||!items.length)return;const idx=[...items].indexOf(active);const next=dir>0?Math.min(idx+1,items.length-1):Math.max(idx-1,0);active.classList.remove("active");items[next].classList.add("active")}
function selectMention(){const active=document.querySelector(".mention-item.active");if(active)active.dispatchEvent(new Event("mousedown"))}
function insertMention(path){if(!mentionSearch)return;const val=inputEl.value;const before=val.slice(0,mentionSearch.atIdx);const after=val.slice(inputEl.selectionStart);inputEl.value=before+"@"+path+" "+after;inputEl.selectionStart=inputEl.selectionEnd=before.length+1+path.length+1;hideMentionDropdown();inputEl.focus()}

// ── File Browser ──────────────────────────
function switchTab(tab){["chats","files","git","outline"].forEach(t=>{document.getElementById("tab"+t.charAt(0).toUpperCase()+t.slice(1)).classList.toggle("active",t===tab);document.getElementById("panel"+t.charAt(0).toUpperCase()+t.slice(1)).classList.toggle("hidden",t!==tab)});if(tab==="files")loadFileTree();if(tab==="git")loadGitStatus();if(tab==="outline")loadOutline()}
async function loadFileTree(path){try{const url=path?`/api/files/list?path=${encodeURIComponent(path)}`:"/api/files/list";const r=await fetch(url);const d=await r.json();document.getElementById("workspacePath").textContent=d.path;if(!path){document.getElementById("fileTree").innerHTML="";renderFileEntries(d.entries,document.getElementById("fileTree"),0)}return d}catch(e){}}
function renderFileEntries(entries,container,depth){for(const e of entries){const item=document.createElement("div");item.className="file-item"+(e.type==="dir"?" dir":"");item.style.paddingLeft=(12+depth*16)+"px";item.setAttribute("tabindex","0");item.setAttribute("data-path",e.path);const selectBox=e.type==="file"?`<input type="checkbox" class="file-checkbox" onclick="event.stopPropagation();toggleFileSelect('${e.path.replace(/'/g,"\\'")}',this)" ${selectedFiles.has(e.path)?"checked":""}> `:"";item.innerHTML=`${selectBox}<span class="file-icon">${e.type==="dir"?"&#9656;":"&#9671;"}</span><span class="file-name">${escapeHtml(e.name)}</span>`;if(e.type==="dir"){let loaded=false;const ch=document.createElement("div");ch.className="file-children hidden";item.onclick=async(ev)=>{ev.stopPropagation();if(!loaded){const d=await loadFileTree(e.path);if(d&&d.entries)renderFileEntries(d.entries,ch,depth+1);loaded=true}ch.classList.toggle("hidden");item.querySelector(".file-icon").innerHTML=ch.classList.contains("hidden")?"&#9656;":"&#9662;"};container.appendChild(item);container.appendChild(ch)}else{item.onclick=()=>openInEditor(e.path);container.appendChild(item)}item.addEventListener("keydown",(ev)=>{if(ev.key==="j"||ev.key==="ArrowDown"){ev.preventDefault();const next=item.nextElementSibling;if(next&&next.classList.contains("file-item"))next.focus();else if(next&&next.nextElementSibling)next.nextElementSibling.focus()}if(ev.key==="k"||ev.key==="ArrowUp"){ev.preventDefault();const prev=item.previousElementSibling;if(prev&&prev.classList.contains("file-item"))prev.focus();else if(prev&&prev.previousElementSibling&&prev.previousElementSibling.classList.contains("file-item"))prev.previousElementSibling.focus()}if(ev.key==="Enter"){ev.preventDefault();item.click()}})}}
async function changeWorkspace(){const p=prompt("Enter workspace path:");if(!p)return;try{const r=await fetch("/api/workspace",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:p})});const d=await r.json();if(d.workspace)loadFileTree();else alert(d.error||"Failed")}catch(e){alert("Failed")}}
function toggleFileSelect(path,cb){if(cb.checked)selectedFiles.add(path);else selectedFiles.delete(path);const bar=document.getElementById("fileSelectBar");document.getElementById("fileSelectCount").textContent=`${selectedFiles.size} selected`;if(selectedFiles.size>0)bar.classList.remove("hidden");else bar.classList.add("hidden")}
function clearFileSelection(){selectedFiles.clear();document.querySelectorAll(".file-checkbox").forEach(cb=>cb.checked=false);document.getElementById("fileSelectBar").classList.add("hidden")}
async function attachSelectedFiles(){
  if(!selectedFiles.size)return;let ctx="";let totalTk=0;
  const mode=settings.contextMode||"smart";const maxFiles=mode==="full"?5:10;
  for(const path of[...selectedFiles].slice(0,maxFiles)){
    const file=await getFileSmart(path);if(!file)continue;
    if(file.type==="ref"){ctx+=`\n@${path.split("/").pop()} `;continue}
    const label=file.type==="summary"?"summary":"";
    ctx+=`\n\`\`\`\n// ${path.split("/").pop()}${label?" ("+label+")":""}\n${file.text}\n\`\`\`\n`;
    totalTk+=(file.tokens||0);
  }
  if(ctx){
    if(totalTk>0)showNotification(`Attached ~${totalTk.toLocaleString()} tokens`);
    inputEl.value+=ctx;inputEl.style.height=Math.min(inputEl.scrollHeight,200)+"px";inputEl.focus()
  }clearFileSelection();
}

// ── Outline / Symbol View ──────────────────────
async function loadOutline(){
  const active=editorTabs.find(t=>t.active);const list=document.getElementById("outlineList");
  if(!active){list.innerHTML='<div class="outline-empty">open a file to see symbols</div>';return}
  try{const r=await fetch(`/api/files/symbols?path=${encodeURIComponent(active.path)}`);const d=await r.json();
    if(!d.symbols||!d.symbols.length){list.innerHTML='<div class="outline-empty">no symbols found</div>';return}
    list.innerHTML=d.symbols.map(s=>{const icon=s.kind==="class"?"C":s.kind==="function"?"f":s.kind==="interface"?"I":s.kind==="enum"?"E":"s";
      return`<div class="outline-item" style="padding-left:${8+s.indent*2}px" onclick="jumpToLine(${s.line})"><span class="outline-icon outline-${s.kind}">${icon}</span><span class="outline-name">${escapeHtml(s.name)}</span><span class="outline-line">${s.line}</span></div>`}).join("")}catch(e){list.innerHTML='<div class="outline-empty">failed to load</div>'}
}
function jumpToLine(line){const ed=document.getElementById("editorContent");const lines=ed.value.split("\n");let pos=0;for(let i=0;i<line-1&&i<lines.length;i++)pos+=lines[i].length+1;ed.focus();ed.selectionStart=ed.selectionEnd=pos;ed.scrollTop=(line-1)*18}

// ── Breadcrumb Navigation ──────────────────────
function renderBreadcrumb(){
  const bc=document.getElementById("editorBreadcrumb");const active=editorTabs.find(t=>t.active);
  if(!active){bc.innerHTML="";return}
  const parts=active.path.replace(/\\/g,"/").split("/");
  bc.innerHTML=parts.map((p,i)=>`<span class="bc-part${i===parts.length-1?" bc-active":""}">${escapeHtml(p)}</span>`).join('<span class="bc-sep">/</span>');
}

// ── Editor ──────────────────────────────
async function openInEditor(path){
  const existing=editorTabs.find(t=>t.path===path);if(existing){editorTabs.forEach(t=>t.active=false);existing.active=true;renderEditorTabs();loadOutline();return}
  try{const r=await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);const d=await r.json();if(d.error)return;
    editorTabs.forEach(t=>t.active=false);editorTabs.push({path,content:d.content||"",original:d.content||"",active:true,ext:d.extension||""});
    document.getElementById("editorPanel").classList.remove("hidden");renderEditorTabs();loadOutline()}catch(e){}
}
function renderEditorTabs(){
  const tabs=document.getElementById("editorTabs");tabs.innerHTML=editorTabs.map((t,i)=>{const name=t.path.split("/").pop().split("\\").pop();const modified=t.content!==t.original?"*":"";return`<div class="editor-tab${t.active?" active":""}" onclick="activateTab(${i})"><span>${escapeHtml(name)}${modified}</span><button class="editor-tab-close" onclick="event.stopPropagation();closeTab(${i})">&times;</button></div>`}).join("");
  const active=editorTabs.find(t=>t.active);const ed=document.getElementById("editorContent");
  if(active){ed.value=active.content;ed.oninput=()=>{active.content=ed.value;renderEditorTabs();updateMinimap();updateEditorHighlight()};ed.onscroll=()=>syncEditorScroll();updateMinimap();updateEditorHighlight()}
  const splitEl=document.getElementById("editorContentSplit");if(splitMode&&splitTab){splitEl.classList.remove("hidden");splitEl.value=splitTab.content;splitEl.oninput=()=>{splitTab.content=splitEl.value;renderEditorTabs()}}else{splitEl.classList.add("hidden")}
  renderBreadcrumb(); saveSessionState();
}
function activateTab(i){editorTabs.forEach(t=>t.active=false);editorTabs[i].active=true;renderEditorTabs();loadOutline()}
function closeTab(i){editorTabs.splice(i,1);if(editorTabs.length===0){document.getElementById("editorPanel").classList.add("hidden");return}if(!editorTabs.some(t=>t.active))editorTabs[Math.min(i,editorTabs.length-1)].active=true;renderEditorTabs();loadOutline()}
function closeEditor(){editorTabs=[];splitMode=false;splitTab=null;document.getElementById("editorPanel").classList.add("hidden")}
async function saveCurrentTab(){const active=editorTabs.find(t=>t.active);if(!active)return;try{const r=await fetch("/api/files/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:active.path,content:active.content})});const d=await r.json();if(d.success){active.original=active.content;renderEditorTabs();showNotification("Saved "+active.path.split("/").pop())}}catch(e){alert("Save failed")}}
function toggleSplitEditor(){splitMode=!splitMode;if(splitMode&&editorTabs.length>=2){splitTab=editorTabs.find(t=>!t.active)||editorTabs[1]}else if(splitMode){splitMode=false}else{splitTab=null}renderEditorTabs()}
function updateMinimap(){const mm=document.getElementById("editorMinimap");const active=editorTabs.find(t=>t.active);if(!active||!mm)return;const lines=active.content.split("\n").slice(0,200);mm.innerHTML=lines.map(l=>`<div class="minimap-line">${escapeHtml(l.slice(0,80))}</div>`).join("")}

// ── Editor Find/Replace (Ctrl+H) ──────────────
function toggleEditorFind(){const bar=document.getElementById("editorFindBar");bar.classList.toggle("hidden");if(!bar.classList.contains("hidden"))document.getElementById("editorFindInput").focus()}
function editorFind(){const q=document.getElementById("editorFindInput").value;const ed=document.getElementById("editorContent");if(!q){document.getElementById("editorFindCount").textContent="";return}const matches=ed.value.split(q).length-1;document.getElementById("editorFindCount").textContent=matches?`${matches} found`:"none"}
function editorFindNext(){const q=document.getElementById("editorFindInput").value;if(!q)return;const ed=document.getElementById("editorContent");const start=ed.selectionEnd||0;const idx=ed.value.indexOf(q,start);if(idx!==-1){ed.focus();ed.selectionStart=idx;ed.selectionEnd=idx+q.length;const linesBefore=ed.value.substring(0,idx).split("\n").length;ed.scrollTop=(linesBefore-1)*18}else{const idx2=ed.value.indexOf(q);if(idx2!==-1){ed.focus();ed.selectionStart=idx2;ed.selectionEnd=idx2+q.length}}}
function editorReplaceOne(){const q=document.getElementById("editorFindInput").value;const rep=document.getElementById("editorReplaceInput").value;if(!q)return;const ed=document.getElementById("editorContent");const active=editorTabs.find(t=>t.active);if(!active)return;const start=ed.selectionStart;const selectedText=ed.value.substring(ed.selectionStart,ed.selectionEnd);if(selectedText===q){active.content=ed.value.substring(0,start)+rep+ed.value.substring(start+q.length);ed.value=active.content;ed.selectionStart=ed.selectionEnd=start+rep.length;renderEditorTabs()}else{editorFindNext()}}
function editorReplaceAll(){const q=document.getElementById("editorFindInput").value;const rep=document.getElementById("editorReplaceInput").value;if(!q)return;const active=editorTabs.find(t=>t.active);if(!active)return;const count=active.content.split(q).length-1;active.content=active.content.split(q).join(rep);document.getElementById("editorContent").value=active.content;renderEditorTabs();showNotification(`Replaced ${count} occurrences`)}

// ── Git ──────────────────────────────
async function loadGitStatus(){try{const r=await fetch("/api/git/status");const d=await r.json();if(d.error){document.getElementById("gitFiles").innerHTML=`<div class="git-msg">${escapeHtml(d.error)}</div>`;return}document.getElementById("gitBranch").textContent=d.branch||"no branch";document.getElementById("gitFiles").innerHTML=d.files.map(f=>`<div class="git-file"><label><input type="checkbox" value="${escapeHtml(f.path)}" ${f.staged?"checked":""} onchange="gitToggle(this)"><span class="git-status-badge">${escapeHtml(f.status)}</span>${escapeHtml(f.path)}</label></div>`).join("")||'<div class="git-msg">clean working tree</div>'}catch(e){document.getElementById("gitFiles").innerHTML='<div class="git-msg">git not available</div>'}}
async function gitToggle(cb){const files=[cb.value];try{if(cb.checked)await fetch("/api/git/stage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({files})});else await fetch("/api/git/unstage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({files})});loadGitStatus()}catch(e){}}
async function gitCommit(){const msg=document.getElementById("commitMsg").value.trim();if(!msg){alert("Enter a commit message");return}try{const r=await fetch("/api/git/commit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg})});const d=await r.json();document.getElementById("gitOutput").textContent=d.output||d.error||"";document.getElementById("commitMsg").value="";loadGitStatus()}catch(e){document.getElementById("gitOutput").textContent="Commit failed"}}
async function gitPush(){try{const r=await fetch("/api/git/push",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})});const d=await r.json();document.getElementById("gitOutput").textContent=d.output||d.error||""}catch(e){document.getElementById("gitOutput").textContent="Push failed"}}

// ── Terminal ──────────────────────────────
function toggleTerminal(){document.getElementById("terminalPanel").classList.toggle("hidden");if(!document.getElementById("terminalPanel").classList.contains("hidden"))document.getElementById("terminalInput").focus()}
function clearTerminal(){document.getElementById("terminalOutput").innerHTML=""}
async function runTerminal(){const inp=document.getElementById("terminalInput");const cmd=inp.value.trim();if(!cmd)return;const out=document.getElementById("terminalOutput");out.innerHTML+=`<div class="term-cmd">$ ${escapeHtml(cmd)}</div>`;inp.value="";try{const r=await fetch("/api/terminal",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({command:cmd})});const d=await r.json();out.innerHTML+=`<div class="term-out${d.exit_code?' term-err':''}">${formatTerminalOutput(d.output)}</div>`;out.scrollTop=out.scrollHeight}catch(e){out.innerHTML+=`<div class="term-out term-err">Error: ${escapeHtml(e.message)}</div>`}}
function formatTerminalOutput(text){if(!text)return"";const isTest=/(?:PASSED|FAILED|ERROR|OK|test[_\s]|pytest|jest|mocha)/i.test(text);if(!isTest)return escapeHtml(text);return escapeHtml(text).replace(/(PASSED|PASS|OK|SUCCESS|\u2713|passed)/gi,'<span class="test-pass">$1</span>').replace(/(FAILED|FAIL|ERROR|ERRORS|\u2717|failed)/gi,'<span class="test-fail">$1</span>').replace(/(WARNING|WARN|SKIP|SKIPPED)/gi,'<span class="test-warn">$1</span>').replace(/(\d+ passed)/gi,'<span class="test-pass">$1</span>').replace(/(\d+ failed)/gi,'<span class="test-fail">$1</span>')}

// ── Pinned / Summarize / Fork ──────────────
function pinMessage(){const last=messages.filter(m=>m.role==="assistant").pop();if(!last)return;pinnedMessages.push({content:last.content.slice(0,200),timestamp:Date.now()});renderPinned();saveState()}
function renderPinned(){const bar=document.getElementById("pinnedBar");const list=document.getElementById("pinnedList");if(!pinnedMessages.length){bar.classList.add("hidden");return}bar.classList.remove("hidden");list.innerHTML=pinnedMessages.map((p,i)=>`<div class="pinned-item"><span>${escapeHtml(p.content.slice(0,80))}...</span><button onclick="pinnedMessages.splice(${i},1);renderPinned();saveState()">&times;</button></div>`).join("")}
async function summarizeChat(){if(messages.length<4||streaming)return;streaming=true;try{const model=document.getElementById("modelSelect").value;const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:[...messages,{role:"user",content:"Summarize this entire conversation in 2-3 concise paragraphs."}],model,provider:settings.provider,...(settings.api_key?{api_key:settings.api_key}:{})})});const reader=r.body.getReader();const decoder=new TextDecoder();let summary="",buffer="";while(true){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split("\n");buffer=lines.pop();for(const line of lines){if(!line.startsWith("data: "))continue;try{const d=JSON.parse(line.slice(6));if(d.type==="content")summary+=d.content}catch(e){}}}if(summary){messages=[{role:"system",content:`Previous conversation summary: ${summary}`},{role:"assistant",content:`**Conversation summarized.**\n\n${summary}`,timestamp:Date.now()}];messagesEl.innerHTML="";addMessage("assistant",messages[1].content,false,messages[1].timestamp,1);saveState()}}catch(e){}streaming=false}
function forkFromMessage(index){if(streaming)return;saveState();const forkedMessages=messages.slice(0,index+1);const newId=Date.now().toString();chats[newId]={title:(chatTitleEl.textContent||"new chat")+" (fork)",messages:JSON.parse(JSON.stringify(forkedMessages)),tokens:{...totalTokens},pinned:[],forkedFrom:currentChatId};try{localStorage.setItem("tetsuocode_chats",JSON.stringify(chats))}catch(e){}loadChat(newId)}
function forkChat(chatId){const chat=chats[chatId];if(!chat)return;const newId=Date.now().toString();chats[newId]={title:(chat.title||"chat")+" (fork)",messages:JSON.parse(JSON.stringify(chat.messages||[])),tokens:{...(chat.tokens||{prompt:0,completion:0,total:0})},pinned:[],forkedFrom:chatId};try{localStorage.setItem("tetsuocode_chats",JSON.stringify(chats))}catch(e){}loadChat(newId)}
function forkCurrentChat(){if(messages.length)forkFromMessage(messages.length-1)}

// ── Undo Last Edit ──────────────────────────
async function undoLastEdit(){try{const r=await fetch("/api/files/undo",{method:"POST"});const d=await r.json();if(d.success){showNotification(d.action);const tab=editorTabs.find(t=>t.path===d.path);if(tab){try{const r2=await fetch(`/api/files/read?path=${encodeURIComponent(d.path)}`);const d2=await r2.json();if(d2.content!==undefined){tab.content=d2.content;tab.original=d2.content;renderEditorTabs()}}catch(e){}}}else{showNotification(d.error||"Nothing to undo","error")}}catch(e){}}

// ── Session State (persistent editor tabs) ──────
function saveSessionState(){try{localStorage.setItem("tetsuocode_session",JSON.stringify({tabs:editorTabs.map(t=>({path:t.path,active:t.active})),sidebarTab:document.querySelector(".sidebar-tab.active")?.textContent||"chats"}))}catch(e){}}
function restoreSessionState(){try{const s=JSON.parse(localStorage.getItem("tetsuocode_session")||"null");if(!s)return;if(s.sidebarTab)switchTab(s.sidebarTab);if(s.tabs&&s.tabs.length){s.tabs.forEach(async(t)=>{await openInEditor(t.path);if(!t.active){const tab=editorTabs.find(et=>et.path===t.path);if(tab)tab.active=false}});}}catch(e){}}

// ── Session Snapshots ──────────────────────
function loadSessionSnapshots(){try{const snaps=JSON.parse(localStorage.getItem("tetsuocode_snapshots")||"[]");const sel=document.getElementById("sessionSelect");sel.innerHTML='<option value="">sessions...</option>'+snaps.map((s,i)=>`<option value="${i}">${escapeHtml(s.name)}</option>`).join("")}catch(e){}}
function saveSessionSnapshot(){const name=prompt("Session name:");if(!name)return;let snaps=[];try{snaps=JSON.parse(localStorage.getItem("tetsuocode_snapshots")||"[]")}catch(e){}snaps.push({name,chatId:currentChatId,tabs:editorTabs.map(t=>({path:t.path,active:t.active})),timestamp:Date.now()});try{localStorage.setItem("tetsuocode_snapshots",JSON.stringify(snaps.slice(-20)))}catch(e){}loadSessionSnapshots();showNotification(`Session "${name}" saved`)}
function loadSessionSnapshot(idx){if(idx==="")return;let snaps=[];try{snaps=JSON.parse(localStorage.getItem("tetsuocode_snapshots")||"[]")}catch(e){}const snap=snaps[parseInt(idx)];if(!snap)return;if(snap.chatId&&chats[snap.chatId])loadChat(snap.chatId);if(snap.tabs){editorTabs=[];snap.tabs.forEach(t=>openInEditor(t.path))}document.getElementById("sessionSelect").value="";showNotification(`Session "${snap.name}" loaded`)}

// ── Resizable Panels ──────────────────────
(function initResizable(){
  const sidebarResize=document.getElementById("sidebarResize");const sidebar=document.getElementById("sidebar");
  if(sidebarResize){let dragging=false,startX,startW;
    sidebarResize.addEventListener("mousedown",(e)=>{dragging=true;startX=e.clientX;startW=sidebar.offsetWidth;document.body.style.cursor="col-resize";document.body.style.userSelect="none";e.preventDefault()});
    document.addEventListener("mousemove",(e)=>{if(!dragging)return;const w=Math.max(180,Math.min(500,startW+(e.clientX-startX)));sidebar.style.width=w+"px";sidebar.style.minWidth=w+"px"});
    document.addEventListener("mouseup",()=>{if(dragging){dragging=false;document.body.style.cursor="";document.body.style.userSelect=""}})}
  const termResize=document.getElementById("terminalResize");const termPanel=document.getElementById("terminalPanel");
  if(termResize){let dragging=false,startY,startH;
    termResize.addEventListener("mousedown",(e)=>{dragging=true;startY=e.clientY;startH=termPanel.offsetHeight;document.body.style.cursor="row-resize";document.body.style.userSelect="none";e.preventDefault()});
    document.addEventListener("mousemove",(e)=>{if(!dragging)return;const h=Math.max(100,Math.min(600,startH-(e.clientY-startY)));termPanel.style.height=h+"px";termPanel.style.maxHeight=h+"px";termPanel.style.minHeight=h+"px"});
    document.addEventListener("mouseup",()=>{if(dragging){dragging=false;document.body.style.cursor="";document.body.style.userSelect=""}})}
})();

// ── Notification Helper ──────────────────────
function showNotification(text,type){const n=document.createElement("div");n.className="undo-notification"+(type==="error"?" undo-error":"");n.textContent=text;document.body.appendChild(n);setTimeout(()=>n.remove(),3000)}

// ── Token Estimation & Context Budget ──────────
function estimateTokens(text){return Math.ceil((text||"").length/4)}
function checkContextBudget(){
  const model=document.getElementById("modelSelect").value;const limit=CONTEXT_LIMITS[model]||131072;
  let total=0;for(const m of messages)total+=estimateTokens(m.content);
  const pct=(total/limit)*100;
  if(pct>90){showNotification(`Context ${Math.round(pct)}% full — consider summarizing or starting new chat`,"error");return false}
  if(pct>70){showNotification(`Context ${Math.round(pct)}% full`);return true}
  return true;
}
async function getFileSmart(path){
  const mode=settings.contextMode||"smart";
  if(mode==="lazy")return{type:"ref",text:`[File: ${path.split("/").pop()}]`};
  try{
    const r=await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);const d=await r.json();
    if(!d.content)return null;
    const tokens=estimateTokens(d.content);
    if(mode==="smart"&&tokens>2000){
      try{const sr=await fetch(`/api/files/summary?path=${encodeURIComponent(path)}`);const sd=await sr.json();
        if(sd.skeleton)return{type:"summary",text:`// ${path.split("/").pop()} (summary, ${sd.total_lines} lines, ~${sd.total_tokens} tokens)\n${sd.skeleton}`,tokens:sd.skeleton_tokens,fullTokens:sd.total_tokens};
      }catch(e){}
    }
    return{type:"full",text:d.content.slice(0,8000),tokens,fullTokens:tokens};
  }catch(e){return null}
}

// ── Auto Context ──────────────────────────
function detectFilePaths(text){const paths=new Set();const patterns=[/(?:^|\s)((?:\.\/|\.\.\/|\/|[a-zA-Z]:\\)[\w\-./\\]+\.\w+)/g,/(?:^|\s)([\w\-]+\.(?:py|js|ts|tsx|jsx|rs|go|java|rb|php|c|cpp|h|lua|css|html|json|yaml|yml|toml|sh))/g];for(const p of patterns){let m;while((m=p.exec(text))!==null)paths.add(m[1].trim())}const mentionRe=/@([\w\-./\\:]+\.\w+)/g;let mm;while((mm=mentionRe.exec(text))!==null)paths.add(mm[1]);return[...paths]}
async function attachContext(text){
  if(!settings.autoContext)return text;
  const mode=settings.contextMode||"smart";
  if(mode==="lazy")return text;
  const paths=detectFilePaths(text);if(!paths.length)return text;
  let ctx="";
  for(const p of paths.slice(0,3)){
    const file=await getFileSmart(p);if(!file||file.type==="ref")continue;
    const label=file.type==="summary"?"Summary of":"Contents of";
    ctx+=`\n\n${label} ${p}:\n\`\`\`\n${file.text}\n\`\`\`\n`;
  }
  return ctx?text+"\n\n[Auto-attached context:]"+ctx:text;
}

// ── Rendering ──────────────────────────────
function scrollToBottom(){if(autoScroll)messagesEl.scrollTop=messagesEl.scrollHeight}
function formatTime(ts){if(!ts)return"";return new Date(ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
function addLineNumbers(html){return html.split("\n").map((l,i)=>`<span class="line-number">${i+1}</span>${l}`).join("\n")}
function renderMarkdown(text){let html;try{html=marked.parse(text)}catch(e){html=escapeHtml(text)}html=html.replace(/<pre><code class="language-(\w+)">/g,'<pre><div class="code-header"><span>$1</span><button class="copy-btn" onclick="copyCode(this)">copy</button></div><code class="language-$1 line-numbers">');html=html.replace(/<pre><code(?! class)>/g,'<pre><div class="code-header"><span>text</span><button class="copy-btn" onclick="copyCode(this)">copy</button></div><code class="line-numbers">');return html}
function copyCode(btn){const c=btn.closest("pre").querySelector("code").textContent;navigator.clipboard.writeText(c).then(()=>{btn.textContent="copied";setTimeout(()=>btn.textContent="copy",2000)})}
function copyMessage(btn){navigator.clipboard.writeText(btn.closest(".message").querySelector(".message-body").innerText).then(()=>{btn.textContent="copied";setTimeout(()=>btn.textContent="copy",2000)})}
function addMessage(role,content,silent,timestamp,msgIndex){const w=messagesEl.querySelector(".welcome");if(w)w.remove();const div=document.createElement("div");div.className=`message ${role}`;const time=formatTime(timestamp||Date.now());const idx=msgIndex!==undefined?msgIndex:messages.length-1;const forkBtn=`<button class="msg-action-btn" onclick="forkFromMessage(${idx})" title="Fork from here">fork</button>`;const actions=role==="assistant"?`<div class="message-actions"><button class="msg-action-btn" onclick="copyMessage(this)">copy</button><button class="msg-action-btn" onclick="regenerate()">retry</button>${forkBtn}</div>`:`<div class="message-actions">${forkBtn}</div>`;div.innerHTML=`<div class="message-header"><span class="message-role">${role==="user"?"you":"tetsuo"}</span><span class="message-time">${time}</span>${actions}</div><div class="message-body">${role==="user"?escapeHtml(content).replace(/\n/g,"<br>"):renderMarkdown(content)}</div>`;div.querySelectorAll("code.line-numbers").forEach(c=>{if(!c.querySelector(".line-number"))c.innerHTML=addLineNumbers(c.innerHTML)});messagesEl.appendChild(div);if(!silent)scrollToBottom();return div}
function escapeHtml(t){const d=document.createElement("div");d.textContent=t;return d.innerHTML}
function addThinking(){const w=messagesEl.querySelector(".welcome");if(w)w.remove();document.title="tetsuocode ...";const div=document.createElement("div");div.className="message assistant";div.id="streamingMessage";div.innerHTML=`<div class="message-header"><span class="message-role">tetsuo</span></div><div class="message-body"><div class="thinking"><div class="thinking-dots"><span></span><span></span><span></span></div></div></div>`;messagesEl.appendChild(div);scrollToBottom();return div}
function showToolThinking(){const sm=document.getElementById("streamingMessage");if(!sm)return;const b=sm.querySelector(".message-body");if(!b.querySelector(".tool-thinking")){const el=document.createElement("div");el.className="tool-thinking";el.innerHTML=`<div class="thinking"><div class="thinking-dots"><span></span><span></span><span></span></div><span>running...</span></div>`;b.appendChild(el)}scrollToBottom()}
function removeToolThinking(){const el=document.querySelector("#streamingMessage .tool-thinking");if(el)el.remove()}
function renderDiff(diff){if(!diff)return"";return`<div class="diff-side-by-side">${renderSideBySide(diff)}</div>`}
function renderSideBySide(diff){const lines=diff.split("\n");let left=[],right=[];for(const line of lines){if(line.startsWith("---")||line.startsWith("+++"))continue;if(line.startsWith("@@")){left.push({type:"hunk",text:line});right.push({type:"hunk",text:line});continue}if(line.startsWith("-")){left.push({type:"del",text:line.slice(1)});right.push({type:"empty",text:""})}else if(line.startsWith("+")){left.push({type:"empty",text:""});right.push({type:"add",text:line.slice(1)})}else{left.push({type:"ctx",text:line.slice(1)||line});right.push({type:"ctx",text:line.slice(1)||line})}}const renderCol=(col)=>col.map(l=>`<div class="diff-line diff-${l.type}">${escapeHtml(l.text)}</div>`).join("");return`<div class="diff-col">${renderCol(left)}</div><div class="diff-col">${renderCol(right)}</div>`}
// formatToolOutput moved below (approval flow version)
function addToolCall(name,args){const sm=document.getElementById("streamingMessage");if(!sm)return;removeToolThinking();const b=sm.querySelector(".message-body");const div=document.createElement("div");div.className="tool-call";let preview=args;try{preview=JSON.stringify(JSON.parse(args),null,2)}catch(e){}if(preview.length>200)preview=preview.slice(0,200)+"...";div.innerHTML=`<div class="tool-call-header" onclick="this.parentElement.classList.toggle('collapsed')"><span class="tool-collapse-icon">&#9660;</span><span class="tool-name">${escapeHtml(name)}</span><span class="tool-status">running</span></div><div class="tool-call-body"><code>${escapeHtml(preview)}</code></div>`;b.appendChild(div);showToolThinking();scrollToBottom()}
function addToolResult(name,result){const sm=document.getElementById("streamingMessage");if(!sm)return;removeToolThinking();const divs=sm.querySelectorAll(".tool-call");if(divs.length){const last=divs[divs.length-1];let preview=result;if(preview.length>1000)preview=preview.slice(0,1000)+"...";last.querySelector(".tool-call-body").innerHTML=`<code>${formatToolOutput(preview)}</code>`;const st=last.querySelector(".tool-status");if(st)st.textContent="done";last.classList.add("collapsed")}showToolThinking();scrollToBottom()}
function playNotification(){if(!settings.sound)return;try{const ctx=new(window.AudioContext||window.webkitAudioContext)();const o=ctx.createOscillator();const g=ctx.createGain();o.connect(g);g.connect(ctx.destination);o.frequency.value=660;g.gain.value=0.08;o.start();o.stop(ctx.currentTime+0.12)}catch(e){}}

// ── Chat ──────────────────────────────
async function sendMessage(retryText){
  let text=retryText||inputEl.value.trim();if(!text||streaming)return;
  const mentionedPaths=[];const mentionRe=/@([\w\-./\\:]+\.\w+)/g;let mm;while((mm=mentionRe.exec(text))!==null)mentionedPaths.push(mm[1]);
  if(!retryText){
    let contextText=text;const mode=settings.contextMode||"smart";
    if(mentionedPaths.length&&mode!=="lazy"){
      for(const p of mentionedPaths.slice(0,5)){
        const file=await getFileSmart(p);if(!file||file.type==="ref")continue;
        const label=file.type==="summary"?"Summary of":"Contents of";
        contextText+=`\n\n${label} ${p}:\n\`\`\`\n${file.text}\n\`\`\`\n`;
      }
    }
    contextText=await attachContext(contextText);
    addMessage("user",text,false,Date.now(),messages.length);
    messages.push({role:"user",content:contextText,timestamp:Date.now()});
    checkContextBudget();
  }
  if(messages.filter(m=>m.role==="user").length===1)chatTitleEl.textContent=text.length>40?text.slice(0,40)+"...":text;
  inputEl.value="";inputEl.style.height="auto";streaming=true;sendBtn.classList.add("hidden");cancelBtn.classList.remove("hidden");
  const streamMsg=addThinking();const body=streamMsg.querySelector(".message-body");let fullContent="";let hadError=false;abortController=new AbortController();
  try{const model=document.getElementById("modelSelect").value;const payload={messages,model,provider:settings.provider,context_mode:settings.contextMode||"smart"};if(settings.temperature!==0.7)payload.temperature=settings.temperature;if(settings.max_tokens!==4096)payload.max_tokens=settings.max_tokens;if(settings.system_prompt)payload.system_prompt=settings.system_prompt;if(settings.api_key)payload.api_key=settings.api_key;if(pendingImages.length){payload.images=pendingImages.slice();pendingImages=[]}
    const resp=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload),signal:abortController.signal});if(!resp.ok)throw new Error(`server returned ${resp.status}`);
    const reader=resp.body.getReader();const decoder=new TextDecoder();let buffer="";
    while(true){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split("\n");buffer=lines.pop();
      for(const line of lines){if(!line.startsWith("data: "))continue;let data;try{data=JSON.parse(line.slice(6))}catch(e){continue}
        if(data.type==="content"){if(!fullContent)body.innerHTML="";removeToolThinking();fullContent+=data.content;scheduleStreamRender(body,fullContent);scrollToBottom()}
        else if(data.type==="tool_call"){if(!fullContent)body.innerHTML="";addToolCall(data.name,data.args)}
        else if(data.type==="tool_result"){addToolResult(data.name,data.result)}
        else if(data.type==="usage"){totalTokens.prompt+=data.usage.prompt_tokens||0;totalTokens.completion+=data.usage.completion_tokens||0;totalTokens.total+=data.usage.total_tokens||0;updateTokenDisplay()}
        else if(data.type==="error"){removeToolThinking();hadError=true;body.innerHTML=`<span class="error-text">${escapeHtml(data.content)}</span><button class="retry-btn" onclick="retryLast()">retry</button>`}
        else if(data.type==="done"){removeToolThinking()}}}
  }catch(e){removeToolThinking();if(e.name==="AbortError"){if(!fullContent)body.innerHTML='<span class="dim-text">cancelled</span>'}else{hadError=true;let msg="connection failed";if(e.message.includes("server returned"))msg=e.message;else if(e.message.includes("Failed to fetch")||e.message.includes("NetworkError"))msg="network error";body.innerHTML=`<span class="error-text">${escapeHtml(msg)}</span><button class="retry-btn" onclick="retryLast()">retry</button>`}}
  body.classList.remove("streaming-cursor");removeToolThinking();streamMsg.removeAttribute("id");document.title="tetsuocode";
  if(fullContent){messages.push({role:"assistant",content:fullContent,timestamp:Date.now()});if(messages.filter(m=>m.role==="user").length===1)generateTitle(messages[0].content,fullContent);playNotification();autoSummarizeIfNeeded()}
  streaming=false;abortController=null;sendBtn.classList.remove("hidden");cancelBtn.classList.add("hidden");saveState();renderChatHistory();inputEl.focus()}
function cancelStream(){if(abortController)abortController.abort()}
function retryLast(){if(streaming)return;const all=messagesEl.querySelectorAll(".message");if(all.length)all[all.length-1].remove();const last=[...messages].reverse().find(m=>m.role==="user");if(last)sendMessage(last.content)}
function regenerate(){if(streaming)return;const all=messagesEl.querySelectorAll(".message");if(all.length)all[all.length-1].remove();while(messages.length&&messages[messages.length-1].role==="assistant")messages.pop();const last=[...messages].reverse().find(m=>m.role==="user");if(last)sendMessage(last.content)}
async function generateTitle(userMsg,assistantMsg){try{const model=document.getElementById("modelSelect").value;const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:[{role:"user",content:userMsg},{role:"assistant",content:assistantMsg.slice(0,500)},{role:"user",content:"Generate a 3-5 word title for this conversation. Reply with ONLY the title, no quotes, no punctuation, all lowercase."}],model,provider:settings.provider,...(settings.api_key?{api_key:settings.api_key}:{})})});const reader=r.body.getReader();const decoder=new TextDecoder();let title="",buffer="";while(true){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const lines=buffer.split("\n");buffer=lines.pop();for(const line of lines){if(!line.startsWith("data: "))continue;try{const d=JSON.parse(line.slice(6));if(d.type==="content")title+=d.content}catch(e){}}}title=title.trim().toLowerCase().replace(/['"`.]/g,"");if(title&&title.length>0&&title.length<60){chatTitleEl.textContent=title;saveState();renderChatHistory()}}catch(e){}}
function toggleSidebar(){document.querySelector(".sidebar").classList.toggle("open");document.getElementById("sidebarOverlay").classList.toggle("hidden")}

// Templates
const defaultTemplates=[{name:"explain code",prompt:"Explain what this code does"},{name:"find bugs",prompt:"Find and fix any bugs"},{name:"write tests",prompt:"Write comprehensive tests"},{name:"refactor",prompt:"Refactor for performance and readability"},{name:"add docs",prompt:"Add documentation"},{name:"security audit",prompt:"Review for security vulnerabilities"}];
function toggleTemplates(){document.getElementById("templateMenu").classList.toggle("hidden");if(!document.getElementById("templateMenu").classList.contains("hidden"))renderTemplates()}
function renderTemplates(){let saved=[];try{saved=JSON.parse(localStorage.getItem("tetsuocode_templates")||"[]")}catch(e){}const all=[...defaultTemplates,...saved];document.getElementById("templateMenu").innerHTML=all.map((t,i)=>`<div class="template-item" onclick="useTemplate(${i})"><span>${escapeHtml(t.name)}</span></div>`).join("")+`<div class="template-item template-save" onclick="saveTemplate()"><span>+ save as template</span></div>`}
function useTemplate(i){let saved=[];try{saved=JSON.parse(localStorage.getItem("tetsuocode_templates")||"[]")}catch(e){}const all=[...defaultTemplates,...saved];if(all[i]){inputEl.value=all[i].prompt;inputEl.focus()}document.getElementById("templateMenu").classList.add("hidden")}
function saveTemplate(){const text=inputEl.value.trim();if(!text){alert("Type a prompt first");return}const name=prompt("Template name:");if(!name)return;let saved=[];try{saved=JSON.parse(localStorage.getItem("tetsuocode_templates")||"[]")}catch(e){}saved.push({name,prompt:text});localStorage.setItem("tetsuocode_templates",JSON.stringify(saved));document.getElementById("templateMenu").classList.add("hidden")}

// ── Incremental Streaming Render ──────────────
let _renderPending=false;
function scheduleStreamRender(body,content){
  if(!_renderPending){_renderPending=true;requestAnimationFrame(()=>{
    body.innerHTML=renderMarkdown(content);body.classList.add("streaming-cursor");
    body.querySelectorAll("code.line-numbers").forEach(c=>{if(!c.querySelector(".line-number"))c.innerHTML=addLineNumbers(c.innerHTML)});
    _renderPending=false;
  })}
}

// ── Diff Approval Flow ──────────────────────
function formatToolOutput(raw){
  try{const p=JSON.parse(raw);
    if(p.pending&&p.pending_id){
      return renderDiff(p.diff)+`<div class="diff-meta diff-pending">${escapeHtml(p.path||"")}<button class="approve-btn" onclick="approveEdit('${p.pending_id}')">apply</button><button class="reject-btn" onclick="rejectEdit('${p.pending_id}')">reject</button><span class="pending-badge">pending</span></div>`;
    }
    if(p.diff){const revertBtn=p.path?`<button class="revert-btn" onclick="undoLastEdit()">revert</button>`:"";return renderDiff(p.diff)+`<div class="diff-meta">${escapeHtml(p.path||"")}${revertBtn}</div>`}
    if(p.image&&p.data)return`<img src="data:${p.mime};base64,${p.data}" style="max-width:100%;border-radius:4px">`;
    return escapeHtml(JSON.stringify(p,null,2))
  }catch(e){return escapeHtml(raw)}
}
async function approveEdit(id){
  try{const r=await fetch("/api/tools/approve",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});const d=await r.json();
    if(d.success){showNotification("Applied: "+d.path.split("/").pop());document.querySelector(`.pending-badge`)?.closest('.diff-meta')?.querySelector('.pending-badge')?.remove();refreshEditorTab(d.path)}
    else showNotification(d.error||"Failed","error")
  }catch(e){showNotification("Approve failed","error")}
}
async function rejectEdit(id){
  try{const r=await fetch("/api/tools/reject",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id})});const d=await r.json();
    if(d.success)showNotification("Rejected: "+d.rejected.split("/").pop());
  }catch(e){showNotification("Reject failed","error")}
}
async function refreshEditorTab(path){
  const tab=editorTabs.find(t=>t.path===path);if(!tab)return;
  try{const r=await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);const d=await r.json();
    if(d.content!==undefined){tab.content=d.content;tab.original=d.content;renderEditorTabs()}
  }catch(e){}
}

// ── Syntax Highlighting Overlay ──────────────
const EXT_TO_LANG={py:"python",js:"javascript",ts:"typescript",tsx:"typescript",jsx:"javascript",rs:"rust",go:"go",java:"java",rb:"ruby",php:"php",lua:"lua",sh:"bash",css:"css",html:"xml",json:"json",yml:"yaml",yaml:"yaml",md:"markdown",toml:"ini",sql:"sql"};
function updateEditorHighlight(){
  const hl=document.getElementById("editorHighlight");const ed=document.getElementById("editorContent");
  if(!hl||!ed)return;const active=editorTabs.find(t=>t.active);if(!active){hl.innerHTML="";return}
  const lang=EXT_TO_LANG[active.ext]||active.ext;
  try{hl.innerHTML=lang&&hljs.getLanguage(lang)?hljs.highlight(ed.value,{language:lang}).value:hljs.highlightAuto(ed.value).value}
  catch(e){hl.textContent=ed.value}
}
function syncEditorScroll(){
  const ed=document.getElementById("editorContent");const hlWrap=document.getElementById("editorHighlight");
  if(ed&&hlWrap){hlWrap.scrollTop=ed.scrollTop;hlWrap.scrollLeft=ed.scrollLeft}
}

// ── File Watcher ──────────────────────────
let _watcherInterval=null;
function startFileWatcher(){
  if(_watcherInterval)return;
  _watcherInterval=setInterval(async()=>{
    if(!editorTabs.length)return;
    const paths=editorTabs.map(t=>t.path);
    try{const r=await fetch("/api/files/mtime",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({paths})});
      const d=await r.json();
      for(const c of d.changed||[]){
        const tab=editorTabs.find(t=>t.path===c.path);
        if(tab&&tab.content===tab.original){refreshEditorTab(c.path);showNotification(c.path.split("/").pop()+" changed on disk")}
      }
    }catch(e){}
  },3000);
}

// ── Streaming Terminal ──────────────────────
async function runTerminalStream(){
  const inp=document.getElementById("terminalInput");const cmd=inp.value.trim();if(!cmd)return;
  const out=document.getElementById("terminalOutput");
  out.innerHTML+=`<div class="term-cmd">$ ${escapeHtml(cmd)}</div>`;inp.value="";
  const outDiv=document.createElement("div");outDiv.className="term-out";out.appendChild(outDiv);
  try{
    const r=await fetch("/api/terminal/stream",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({command:cmd})});
    const reader=r.body.getReader();const decoder=new TextDecoder();let buffer="";
    while(true){const{done,value}=await reader.read();if(done)break;
      buffer+=decoder.decode(value,{stream:true});const lines=buffer.split("\n");buffer=lines.pop();
      for(const line of lines){if(!line.startsWith("data: "))continue;
        try{const d=JSON.parse(line.slice(6));
          if(d.type==="output")outDiv.innerHTML+=formatTerminalOutput(d.text);
          else if(d.type==="exit"){if(d.code!==0)outDiv.classList.add("term-err");outDiv.innerHTML+=`\n<span class="test-warn">[exit ${d.code}]</span>`}
          else if(d.type==="error")outDiv.innerHTML+=`<span class="test-fail">${escapeHtml(d.text)}</span>`;
        }catch(e){}}
      out.scrollTop=out.scrollHeight;
    }
  }catch(e){outDiv.innerHTML+=`<span class="term-err">Error: ${escapeHtml(e.message)}</span>`}
  out.scrollTop=out.scrollHeight;
}

// ── Per-Hunk Diff with Accept/Reject ──────────
function renderHunkedDiff(diff){
  if(!diff)return"";
  const lines=diff.split("\n");const hunks=[];let current=null;
  for(const line of lines){
    if(line.startsWith("---")||line.startsWith("+++"))continue;
    if(line.startsWith("@@")){if(current)hunks.push(current);current={header:line,lines:[]};continue}
    if(current)current.lines.push(line);
  }
  if(current)hunks.push(current);
  return hunks.map((h,i)=>`<div class="diff-hunk-block"><div class="diff-hunk-header"><span>${escapeHtml(h.header)}</span></div><div class="diff-hunk-content">${h.lines.map(l=>{
    if(l.startsWith("+"))return`<div class="diff-line diff-add">${escapeHtml(l.slice(1))}</div>`;
    if(l.startsWith("-"))return`<div class="diff-line diff-del">${escapeHtml(l.slice(1))}</div>`;
    return`<div class="diff-line diff-ctx">${escapeHtml(l.slice(1)||l)}</div>`;
  }).join("")}</div></div>`).join("");
}

// ── Conversation Tree / Fork Graph ──────────────
function renderForkTree(){
  const roots=[];const children={};
  for(const id of Object.keys(chats)){
    const c=chats[id];const parent=c.forkedFrom;
    if(parent&&chats[parent]){(children[parent]=children[parent]||[]).push(id)}
    else roots.push(id);
  }
  const treeEl=document.getElementById("forkTree");if(!treeEl)return;
  function buildTree(id,depth){
    const c=chats[id];const indent=depth*12;const active=id===currentChatId?" fork-active":"";
    let html=`<div class="fork-node${active}" style="padding-left:${8+indent}px" onclick="loadChat('${id}')" title="${escapeHtml(c.title||'chat')}"><span class="fork-dot">${depth>0?"├":"●"}</span><span class="fork-label">${escapeHtml((c.title||"chat").slice(0,25))}</span></div>`;
    for(const child of (children[id]||[]).sort())html+=buildTree(child,depth+1);
    return html;
  }
  treeEl.innerHTML=roots.sort((a,b)=>Number(b)-Number(a)).map(id=>buildTree(id,0)).join("");
}

// ── Multimodal Image Support ──────────────
let pendingImages=[];
async function uploadFile(file){
  const f=new FormData();f.append("file",file);
  try{const r=await fetch("/api/upload",{method:"POST",body:f});const d=await r.json();
    if(d.image){
      pendingImages.push({mime:d.mime,data:d.data,filename:d.filename});
      inputEl.value+=`\n[Image attached: ${d.filename}]`;
      showNotification("Image attached — will be sent with next message");
    }else if(d.content){inputEl.value+=`\n\`\`\`\n// ${d.filename}\n${d.content.slice(0,5000)}\n\`\`\`\n`}
    inputEl.focus();inputEl.style.height=Math.min(inputEl.scrollHeight,200)+"px";
  }catch(e){alert("Upload failed")}
}

// ── Auto-Summarization ──────────────────────
async function autoSummarizeIfNeeded(){
  const model=document.getElementById("modelSelect").value;const limit=CONTEXT_LIMITS[model]||131072;
  let total=0;for(const m of messages)total+=estimateTokens(m.content);
  const pct=(total/limit)*100;
  if(pct<80||messages.length<6)return;
  showNotification("Auto-summarizing to free context...");
  try{
    const r=await fetch("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
      messages:[...messages.slice(0,Math.max(2,messages.length-4)),{role:"user",content:"Summarize the conversation so far in 2-3 concise paragraphs. Include key decisions and code changes."}],
      model,provider:settings.provider,...(settings.api_key?{api_key:settings.api_key}:{})
    })});
    const reader=r.body.getReader();const decoder=new TextDecoder();let summary="",buffer="";
    while(true){const{done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});
      const lines=buffer.split("\n");buffer=lines.pop();
      for(const line of lines){if(!line.startsWith("data: "))continue;try{const d=JSON.parse(line.slice(6));if(d.type==="content")summary+=d.content}catch(e){}}
    }
    if(summary){
      const recentMessages=messages.slice(-4);
      messages=[{role:"system",content:`Previous conversation summary:\n${summary}`},...recentMessages];
      showNotification("Context auto-summarized");saveState();
    }
  }catch(e){}
}

// ── MCP Configuration ──────────────────────
async function loadMcpServers(){
  try{const r=await fetch("/api/mcp/servers");const d=await r.json();
    const list=document.getElementById("mcpServerList");if(!list)return;
    list.innerHTML=(d.servers||[]).map(s=>`<div class="mcp-server"><span class="mcp-name">${escapeHtml(s.name)}</span><span class="mcp-tools">${s.tools.length} tools</span><button class="mcp-remove" onclick="removeMcpServer('${escapeHtml(s.name)}')">&times;</button></div>`).join("")||'<div class="mcp-empty">no servers connected</div>';
  }catch(e){}
}
async function addMcpServer(){
  const name=prompt("Server name:");if(!name)return;
  const url=prompt("Server URL (e.g. http://localhost:3000):");if(!url)return;
  try{const r=await fetch("/api/mcp/servers",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name,url})});
    const d=await r.json();if(d.success){showNotification(`MCP server "${name}" added (${d.server.tools.length} tools)`);loadMcpServers()}
  }catch(e){showNotification("Failed to add MCP server","error")}
}
async function removeMcpServer(name){
  try{await fetch(`/api/mcp/servers?name=${encodeURIComponent(name)}`,{method:"DELETE"});loadMcpServers();showNotification(`Removed "${name}"`)}catch(e){}
}

// ── Init ──────────────────────────────
(async function(){loadTheme();const ok=await checkAuth();if(ok)loadState();inputEl.focus();startFileWatcher()})();
