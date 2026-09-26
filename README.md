# Locode 🤖

> **Local-First AI Developer CLI** powered by **Node.js** and local LLMs (like **Qwen 2.5 Coder 7B**) via **Ollama**, **LM Studio**, or **vLLM**.
> An open-source, privacy-first alternative to Claude Code that runs entirely on your own machine.

---

## ✨ Features

- **100% Local & Private:** Code never leaves your machine. Powered by Ollama (`qwen2.5-coder:7b`, `llama3.2`, etc.) or LM Studio / vLLM.
- **⏪ Git Checkpoints & `/undo`:** Creates an automated workspace snapshot before every turn. If the model hallucinates or breaks code, simply type `/undo` to instantly roll back!
- **📎 `@file` Mention Autocompletion:** Type `@path/to/file` in any prompt (e.g. `check @src/cli.ts`) to pre-inject file contents with zero latency.
- **🧠 Project Memory (`LOCODE.md` / `CLAUDE.md`):** Automatically detects `LOCODE.md`, `CLAUDE.md`, or `AGENTS.md` in the project root and enforces your coding styles and rules.
- **🤖 Conventional `/commit` Generator:** Generates semantic git commits based on your staged changes and git diffs.
- **🔀 Universal Provider Support:** Switch between Ollama, LM Studio, vLLM, or any OpenAI-compatible API with `--provider` and `--api-base`.
- **📊 Real-time Telemetry & `/stats`:** Tracks tokens consumed, duration, and tokens per second (TPS).
- **Claude Code-Style Toolset:**
  - `view_file`: Read file contents with line numbers and line range slicing.
  - `edit_file`: Surgical search-and-replace edits with unified diff previews.
  - `write_file`: Create new files or overwrite configuration files.
  - `list_dir`: Recursive directory scanner with `.gitignore` filtering.
  - `search_code`: Workspace grep/regex pattern search across code files.
  - `run_command`: Subprocess shell execution for running tests, linters, git, and builds.
- **Safety & Interactive Approvals:** Read-only operations execute automatically; file edits and shell commands prompt for confirmation `[y/N]` unless running with `--yes`.
- **Interactive REPL & Slash Commands:**
  - `/undo` - ⏪ Rollback workspace to state before the last agent turn.
  - `/commit [msg]` - 🤖 Auto-generate or apply a git commit for current changes.
  - `/stats` - 📊 Display session token metrics and speed.
  - `/diff` - 📝 Show git status and pending changes in workspace.
  - `/model [name]` - 🔄 View current model or switch on the fly.
  - `/clear` - 🧹 Clear conversation memory and reset context.
  - `/tools` - 🛠️ List all registered agent tools.
  - `/exit` - 🚪 Exit Locode CLI.

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

### Reference Files Directly in Prompts
```text
locode > Refactor @src/agent/loop.ts to use the new interfaces in @src/types.ts
```

### Rollback an Action
```text
locode > /undo
```

### Auto-Commit Changes
```text
locode > /commit
```

### Connect to LM Studio or vLLM
```bash
locode --provider lmstudio --api-base http://localhost:1234/v1 --model local-model
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

---

## 🧪 Testing

Run the test suite:
```bash
npm test
```

---

## 📄 License
MIT
