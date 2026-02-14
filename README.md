<p align="center">
  <img src="assets/banner.jpg" alt="tetsuocode" width="100%" />
</p>
<p align="center"><strong>AI Coding Assistant, Powered by Grok.</strong></p>

<p align="center">
  <a href="https://github.com/tetsuo-ai/tetsuo-code/stargazers"><img src="https://img.shields.io/github/stars/tetsuo-ai/tetsuo-code?style=flat-square" /></a>
  <a href="https://github.com/tetsuo-ai/tetsuo-code/blob/main/LICENSE"><img src="https://img.shields.io/github/license/tetsuo-ai/tetsuo-code?style=flat-square" /></a>
  <img src="https://img.shields.io/badge/powered%20by-Grok-blue?style=flat-square" />
</p>

---

An agentic AI coding assistant powered by xAI's Grok. Streaming chat, tool calling (file read/write, shell commands, search), code generation, and more. Available as a **web app** and a **Neovim plugin**.

## Web App

A standalone browser-based UI. No Vim required.

**Requirements:** Python 3.10+, an [xAI API key](https://console.x.ai)

```bash
export XAI_API_KEY="xai-..."
cd web
pip install flask requests
python app.py
```

Open **http://localhost:5000**. Features:

- Streaming chat with markdown and syntax highlighting
- Agentic tool loop - Grok reads files, writes code, runs commands autonomously
- Chat persistence across sessions (localStorage)
- Model switching (grok-4-1-fast-reasoning, grok-3-fast, grok-3, grok-3-mini)
- Code block copy buttons
- Mobile responsive
- Keyboard shortcuts: `Enter` send, `Shift+Enter` newline, `Ctrl+N` new chat, `Esc` cancel

## Neovim Plugin

For Vim users. Adds an AI chat panel directly in your editor.

**Requirements:** Neovim >= 0.9, curl, an [xAI API key](https://console.x.ai)

```bash
export XAI_API_KEY="xai-..."
```

**lazy.nvim**
```lua
{
  "tetsuo-ai/tetsuo-code",
  config = function()
    require("tetsuo").setup()
  end,
}
```

**packer.nvim**
```lua
use {
  "tetsuo-ai/tetsuo-code",
  config = function()
    require("tetsuo").setup()
  end,
}
```

### Keymaps

| Keymap | Action |
|--------|--------|
| `<leader>tc` | Toggle chat panel |
| `<leader>ta` | Ask a question |
| `<leader>ti` | Inline edit selection (visual mode) |
| `<leader>tr` | Reset conversation |
| `<leader>tf` | Fix diagnostics in current buffer |

| Chat Buffer | Action |
|-------------|--------|
| `i` / `Enter` | Focus input |
| `<C-s>` | Send message |
| `<C-c>` | Cancel response |
| `yc` | Yank code block under cursor |
| `q` | Close panel |
| `R` | Reset chat |

| Command | Action |
|---------|--------|
| `:Tetsuo` | Toggle chat |
| `:TetsuoAsk <prompt>` | One-shot question |
| `:TetsuoInline` | Inline edit selection |
| `:TetsuoModel [model]` | Switch Grok model |
| `:TetsuoSave [name]` | Save conversation |
| `:TetsuoLoad [name]` | Load conversation |
| `:TetsuoReset` | Reset chat |

## Tools

Grok has access to these tools and uses them autonomously:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Create/overwrite files |
| `edit_file` | Surgical find-and-replace |
| `run_command` | Execute shell commands |
| `list_files` | Project directory tree |
| `grep_files` | Regex search across files |

The Neovim plugin also exposes `get_current_buffer`, `get_diagnostics`, and `list_buffers`.

## Configuration

### Neovim

```lua
require("tetsuo").setup({
  api_key = nil,            -- or set XAI_API_KEY env var
  model = "grok-4-1-fast-reasoning",
  base_url = "https://api.x.ai/v1",
  max_tokens = 4096,
  temperature = 0.7,

  ui = {
    width = 0.38,           -- chat panel width (fraction of editor)
    position = "right",     -- "right" or "left"
    border = "single",
  },

  keymaps = {
    toggle_chat = "<leader>tc",
    ask = "<leader>ta",
    inline_edit = "<leader>ti",
    reset = "<leader>tr",
    fix_diagnostics = "<leader>tf",
  },

  tools = {
    enabled = true,
    max_iterations = 10,
    confirm_writes = true,
    confirm_bash = true,
    bash_timeout = 30000,
  },
})
```

### Project Config

Create a `.tetsuorc` in your project root:

```json
{
  "model": "grok-4-1-fast-reasoning",
  "temperature": 0.5,
  "system_prompt": "You are working on a Rust project using Actix-web."
}
```

## License

GNU General Public License v3.0
