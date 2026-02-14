<p align="center">
  <img src="assets/banner.png" alt="TetsuoCode" width="100%" />
</p>

<h1 align="center">TetsuoCode</h1>
<p align="center"><strong>Cursor for Vim, Powered by Grok.</strong></p>

<p align="center">
  <a href="https://github.com/tetsuo-ai/TetsuoCode/stargazers"><img src="https://img.shields.io/github/stars/tetsuo-ai/TetsuoCode?style=flat-square" /></a>
  <a href="https://github.com/tetsuo-ai/TetsuoCode/blob/main/LICENSE"><img src="https://img.shields.io/github/license/tetsuo-ai/TetsuoCode?style=flat-square" /></a>
  <img src="https://img.shields.io/badge/neovim-%3E%3D0.9-green?style=flat-square&logo=neovim" />
  <img src="https://img.shields.io/badge/powered%20by-Grok-blue?style=flat-square" />
</p>

---

A Neovim plugin that turns your editor into an AI coding IDE. Streaming chat panel, agentic tool calling, inline code editing — all powered by xAI's Grok. Zero dependencies.

## Features

- **Streaming chat panel** - vsplit that stays open alongside your code
- **Agentic tool loop** - Grok reads files, edits code, runs commands, searches your project autonomously
- **Inline editing** - select code, describe the change, preview the diff, accept/reject
- **Auto-context** - every message includes your current file, cursor, git branch, and LSP diagnostics
- **User confirmation** - prompts before file writes and shell commands (with "Always" option)
- **Token tracking** - live usage counter in the statusline
- **Conversation persistence** - save/load chat history to disk
- **Runtime model switching** - swap between Grok models on the fly
- **Project config** - drop a `.tetsuorc` in your project root for per-project settings
- **Zero dependencies** - just Neovim + curl

## Install

**Requirements:** Neovim >= 0.9, curl, an [xAI API key](https://console.x.ai)

```bash
export XAI_API_KEY="xai-..."
```

**lazy.nvim**
```lua
{
  "tetsuo-ai/TetsuoCode",
  config = function()
    require("tetsuo").setup()
  end,
}
```

**packer.nvim**
```lua
use {
  "tetsuo-ai/TetsuoCode",
  config = function()
    require("tetsuo").setup()
  end,
}
```

## Usage

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
| `get_current_buffer` | Read active buffer |
| `get_diagnostics` | Get LSP errors/warnings |
| `list_buffers` | List open buffers |
| `list_files` | Project directory tree |
| `grep_files` | Regex search across files |

## Configuration

```lua
require("tetsuo").setup({
  api_key = nil,            -- or set XAI_API_KEY env var
  model = "grok-3-fast",    -- grok-3-fast, grok-3, grok-3-mini
  base_url = "https://api.x.ai/v1",
  max_tokens = 4096,
  temperature = 0.7,

  ui = {
    width = 0.38,           -- chat panel width (fraction of editor)
    position = "right",     -- "right" or "left"
    border = "rounded",
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

## Project Config

Create a `.tetsuorc` in your project root:

```json
{
  "model": "grok-3",
  "temperature": 0.5,
  "system_prompt": "You are working on a Rust project using Actix-web."
}
```

## License

GNU General Public License v3.0
