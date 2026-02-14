local M = {}

M.defaults = {
  api_key = nil, -- falls back to $XAI_API_KEY
  model = "grok-4-1-fast-reasoning",
  base_url = "https://api.x.ai/v1",
  max_tokens = 4096,
  temperature = 0.7,
  system_prompt = [[You are tetsuocode, an elite AI coding assistant embedded in Neovim. You are powered by Grok.

You have access to tools for reading files, writing files, editing files, and running shell commands. Use them when the user asks you to modify code, explore a project, or run commands.

When editing code:
- Be precise and surgical. Only change what's needed.
- Show the user what you changed and why.
- If you're unsure, ask before making destructive changes.

When responding:
- Be concise and direct.
- Use markdown for formatting.
- Include code blocks with language tags for syntax highlighting.
- Don't over-explain obvious things.]],

  ui = {
    width = 0.38,       -- chat panel width as fraction of editor
    position = "right",  -- "right" or "left"
    border = "single",   -- border style for floating windows
    icons = {
      user = ">",
      assistant = "tetsuo",
      system = "system",
      tool = "$",
      spinner = { ".", "..", "...", "..", "." },
    },
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
    confirm_writes = true,   -- ask before writing files
    confirm_bash = true,     -- ask before running shell commands
    bash_timeout = 30000,    -- ms
  },
}

M.options = {}

-- Load .tetsuorc from project root if it exists
local function load_project_config()
  local rc_path = vim.fn.getcwd() .. "/.tetsuorc"
  if vim.fn.filereadable(rc_path) ~= 1 then
    return {}
  end

  local lines = vim.fn.readfile(rc_path)
  local content = table.concat(lines, "\n")
  local ok, data = pcall(vim.json.decode, content)
  if ok and type(data) == "table" then
    return data
  end
  return {}
end

function M.setup(opts)
  local project_opts = load_project_config()
  M.options = vim.tbl_deep_extend("force", {}, M.defaults, project_opts, opts or {})
  -- Resolve API key from env if not set
  if not M.options.api_key then
    M.options.api_key = vim.env.XAI_API_KEY
  end
end

-- Switch model at runtime
function M.set_model(model)
  M.options.model = model
end

function M.get()
  if vim.tbl_isempty(M.options) then
    M.setup()
  end
  return M.options
end

return M
