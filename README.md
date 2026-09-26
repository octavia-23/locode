# Locode 🤖

> **Local-First AI Developer CLI** powered by **Node.js** and local LLMs (like **Qwen 2.5 Coder 7B**) via **Ollama**.
> An open-source, privacy-first alternative to Claude Code that runs entirely on your own machine.

---

## ✨ Features

- **100% Local & Private:** Code never leaves your machine. Powered by Ollama (`qwen2.5-coder:7b`, `llama3.2`, etc.).
- **Claude Code-Style Toolset:**
  - `view_file`: Read file contents with line numbers and line range slicing.
  - `edit_file`: Surgical search-and-replace edits with unified diff previews.
  - `write_file`: Create new files or overwrite configuration files.
  - `list_dir`: Recursive directory scanner with `.gitignore` filtering.
  - `search_code`: Workspace grep/regex pattern search across code files.
  - `run_command`: Subprocess shell execution for running tests, linters, git, and builds.
- **Safety & Interactive Approvals:** Read-only operations execute automatically; file edits and shell commands prompt for confirmation `[y/N]` unless running with `--yes`.
- **Extended Context Window Support:** Automatically configures Ollama's `num_ctx` (16k/32k tokens) with intelligent sliding-window context compaction.
- **Interactive REPL & Slash Commands:**
  - `/help` - List all slash commands and shortcuts.
  - `/model [name]` - View current model or switch on the fly.
  - `/clear` - Reset conversation history and memory.
  - `/diff` - View current Git status and diffs.
  - `/tools` - Inspect available tools.
  - `/exit` - Exit the CLI.
- **Dual Execution Modes:**
  - **Interactive REPL:** Launch `locode` and chat in a persistent loop.
  - **One-Shot Task Mode:** `locode "run tests and fix the failing assertion"`

---

## 🚀 Quick Start

### 1. Prerequisites
- [Node.js](https://nodejs.org/) v20 or higher
- [Ollama](https://ollama.com/) with a coding model installed:
  ```bash
  ollama pull qwen2.5-coder:7b
  ```

### 2. Install / Link Globally
From this directory:
```bash
npm install
npm run build
npm link
```

Now `locode` is available anywhere in your terminal!

---

## 💻 Usage

### Interactive Mode (Default)
Navigate to any codebase and launch:
```bash
locode
```

### Auto-Approve Mode (Non-interactive)
Skip confirmation prompts for shell commands and edits:
```bash
locode --yes
```

### One-Shot Task Execution
Give the AI developer CLI a direct command:
```bash
locode "Check git status, run npm test, and fix any failing tests"
```

### Select a Different Model
```bash
locode --model qwen2.5-coder:14b
# or
locode --model llama3.2
```

---

## 🛠️ Project Architecture

```
src/
├── agent/
│   ├── loop.ts          # Autonomous ReAct reasoning & execution loop
│   ├── prompt.ts        # System prompt tuned for local coding models
│   └── context.ts       # Context manager & history compaction engine
├── providers/
│   └── ollama.ts        # Ollama API client with native tool calling & fallback parsing
├── tools/
│   ├── file-ops.ts      # view_file, edit_file, write_file
│   ├── search.ts        # list_dir, search_code (grep)
│   ├── terminal.ts      # run_command (sandboxed execution)
│   └── index.ts         # Tool registry
├── ui/
│   ├── commands.ts      # Slash commands (/help, /model, /clear, /diff, etc.)
│   └── renderer.ts      # Markdown streaming, syntax highlighting & diff display
└── cli.ts               # CLI entrypoint & Commander options
```

---

## 🧪 Testing

Run the test suite:
```bash
npm run test
```

Or run via tsx directly:
```bash
npx tsx --test tests/tools.test.ts
```

---

## 📄 License
MIT
