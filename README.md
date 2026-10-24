# Locode

Locode is an extensible terminal coding agent supporting both frontier cloud APIs and local quantized LLM runtimes. It provides an automated development loop with repository indexing, multi-strategy file editing, integrated compiler/test verification, and file rollback capabilities.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![Tests: 122 Passing](https://img.shields.io/badge/Tests-122%20Passing-brightgreen.svg)](#testing)
[![License: Non--Commercial](https://img.shields.io/badge/License-Non--Commercial-orange.svg)](#license)

---

## Overview

Coding agents frequently encounter failure modes that reduce reliability:

- **Prompt prefill timeouts:** Heavy multi-file contexts can cause standard HTTP client sockets to time out during prefill on local inference engines.
- **Repetitive read loops:** Smaller or local models can become trapped in passive file inspection without applying code changes.
- **Unchecked errors:** Agentic loops that do not run project linters or test suites often report success while leaving syntax errors, broken imports, or failing tests.
- **Workspace risks:** Shell commands run without path restrictions can modify files outside the intended project tree or introduce destructive changes.

Locode addresses these issues through:

1. **Adaptive Loop Profiles:** Differentiates between cloud and local models. Cloud providers (Claude, Gemini, Groq, OpenAI) receive expanded step budgets and deep context inspection, while local runtimes (llama.cpp, Ollama) enforce strict action gates and cycle detection to prevent resource thrashing.
2. **Multi-Strategy File Editing:** A multi-tier patching engine that falls back from exact matching to whitespace-tolerant matching, contextual line anchors, and unified diff application. Preserves CRLF line endings on Windows.
3. **Automated Verification Feedback:** Integrates directly with project build systems (`tsc`, `npm test`, `pytest`, `py_compile`, `cargo check`). Captures compiler error outputs, filters out unrelated project errors, and injects actionable diagnostics into the next turn for autonomous correction.
4. **Sandboxed Workspace Operations:** Enforces path containment to prevent directory traversal outside the repository root, blocks destructive commands, and creates atomic file snapshots before each modification.
5. **Prompt Caching & Streaming:** Utilizes Server-Sent Events (SSE) and vendor prompt caching (e.g. Anthropic prompt caching, Gemini context reuse) to minimize latency and token expenditure.

---

## Architecture

```text
                           USER OBJECTIVE / TASK
                                     │
                                     ▼
                    ┌──────────────────────────────────┐
                    │  Provider & Environment Config   │
                    │  (Cloud API or Local Runtime)    │
                    └────────────────┬─────────────────┘
                                     │
                                     ▼
                    ┌──────────────────────────────────┐
                    │      Context Engine & Memory     │
                    │   (Repository Map, Task State)   │
                    └────────────────┬─────────────────┘
                                     │
                                     ▼
                    ┌──────────────────────────────────┐
                    │       Active LLM Streaming       │
                    │  (Groq / Gemini / Claude / etc)  │
                    └────────────────┬─────────────────┘
                                     │
                        Tool Calls Requested?
                                     │
                      ┌──────────────┴──────────────┐
                      │                             │
                 [Tool Calls]                  [Text Response]
                      │                             │
                      ▼                             ▼
     ┌──────────────────────────────────┐   ┌───────────────────┐
     │  Stagnation & Cycle Guard        │   │ Session Memory    │
     │  (Detects repetitive patterns)   │   │ Persisted         │
     └────────────────┬─────────────────┘   └───────────────────┘
                      │
                      ▼
     ┌──────────────────────────────────┐
     │  Sandboxed Execution Pipeline    │
     │  - Path containment check        │
     │  - Pre-edit snapshot recorded    │
     │  - Dangerous command filter      │
     └────────────────┬─────────────────┘
                      │
                      ▼
     ┌──────────────────────────────────┐
     │  Verification & Fast-Lint Gate   │
     │  (tsc, npm test, pytest, cargo)  │
     └────────────────┬─────────────────┘
                      │
                Checks Pass?
                ┌─────┴─────┐
                │           │
              [Yes]        [No]
                │           │
                ▼           ▼
     ┌────────────────┐   ┌─────────────────────────────┐
     │ Turn Finalized │   │ Feed Compiler Error Trace   │
     │ or Next Action │   │ Directly Into Next Turn     │
     └────────────────┘   └─────────────────────────────┘
```

---

## Supported Providers

Locode supports both managed cloud endpoints and locally hosted engines:

| Provider | Type | Default Model | Context Support | Key Features |
| :--- | :--- | :--- | :--- | :--- |
| **Groq** | Cloud | `qwen/qwen3.8-27b` | Up to 131k tokens | Fast token generation speed |
| **Google Gemini** | Cloud | `gemini-3.8-flash` | Up to 1M+ tokens | Thought signature preservation, native tools |
| **Anthropic** | Cloud | `claude-3-7-sonnet-20250219` | Up to 200k tokens | Structured prompt caching, tool use |
| **OpenAI** | Cloud | `gpt-4o` | Up to 128k tokens | Streaming function calling |
| **OpenRouter** | Cloud | Configurable | Varies by model | Unified gateway for open & closed models |
| **llama.cpp** | Local | Configurable (`.gguf`) | Up to 262k tokens | Custom KV-cache profiles, zero timeout |
| **Ollama** | Local | `qwen2.5-coder:7b` | Varies | Local inference via Ollama server |

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v20 or higher
- An API key for cloud providers, or a running local runtime (such as Ollama or llama.cpp)

### Installation

```bash
git clone https://github.com/octavia-23/locode.git
cd locode
npm install
npm run build
```

### Configuration

Create a `.env` file in the project directory or in your home directory (`~/.locode/.env`):

```bash
cp .env.example .env
```

Add your API keys to the `.env` file:

```env
# Google Gemini
GEMINI_API_KEY="your-gemini-key"

# Anthropic Claude
ANTHROPIC_API_KEY="your-anthropic-key"

# Groq
GROQ_API_KEY="your-groq-key"

# OpenAI
OPENAI_API_KEY="your-openai-key"

# OpenRouter
OPENROUTER_API_KEY="your-openrouter-key"

# Optional defaults
LOCODE_PROVIDER="groq"
LOCODE_MODEL="qwen/qwen3.8-27b"
```

Locode loads environment variables in the following order:
1. Workspace `.env`
2. Global configuration in `~/.locode/.env`
3. System environment variables

---

## Usage

### Interactive Mode

Start the interactive terminal interface:

```bash
npm start
# or after running npm run build:
node dist/cli.js
```

### Autonomous / Non-Interactive Mode

Execute a specific task directly from the command line without interactive approval prompts:

```bash
node dist/cli.js --auto "Fix failing tests in tests/auth.test.ts"
```

### Command Line Options

```text
Usage: locode [options] [prompt...]

Arguments:
  prompt                     Initial instruction to execute

Options:
  -p, --provider <type>      Provider: gemini | anthropic | openai | openrouter | groq | llamacpp | ollama
  -m, --model <name>         Model identifier
  -c, --ctx <size>           Context window override (e.g. 16k, 32k, 64k, 128k, 262k)
  -y, --yes, --auto          Auto-approve tool executions without manual confirmation
  -f, --file <path>          Read instructions from a text or markdown file
  -d, --dir <path>           Set target workspace directory (default: current working directory)
  --profile <name>           Inference profile: ultra-context | performance | large-context | balanced
  --api-base <url>           Base URL for OpenAI-compatible endpoints
  --api-key <key>            API key override
  --host <url>               Ollama host URL (default: http://127.0.0.1:11434)
  --model-path <path>        Path to local .gguf model file for llama.cpp
  -h, --help                 Display CLI help
  -V, --version              Output version number
```

### REPL Commands

Within interactive mode, use slash commands to inspect state or modify settings on the fly:

| Command | Description |
| :--- | :--- |
| `/provider [name]` | Switch provider (`gemini`, `anthropic`, `groq`, `openai`, `llamacpp`, `ollama`) |
| `/model [name]` | Change active model identifier |
| `/auto` | Toggle permissionless auto-approval mode |
| `/verify [cmd]` | Run project linters or test commands |
| `/undo` | Roll back workspace changes to the state before the last agent turn |
| `/diff` | Display uncommitted git changes generated by the agent |
| `/commit [msg]` | Stage changes and create a git commit (auto-generates conventional message if omitted) |
| `/stats` | View token usage, duration, and generation speed metrics |
| `/context [size]` | Set context window limit (e.g. `16k`, `64k`, `128k`) |
| `/profile [name]` | Switch local inference profile (`ultra-context`, `performance`, `balanced`) |
| `/hardware` | Display host CPU, GPU, and VRAM telemetry |
| `/mcp` | List connected Model Context Protocol (MCP) servers and tools |
| `/tools` | List registered internal agent tools |
| `/memory` | Inspect persisted session memory for the workspace |
| `/clear` | Clear active conversation history |
| `/help` | List available commands |
| `/exit` | Exit the application |

---

## Security Model

Locode runs commands and modifies files with the permissions of the current shell user. To mitigate unintended changes, the agent applies several containment mechanisms:

- **Path Containment:** File tools check paths using `resolveSafePath`, preventing read or write access outside the active workspace directory.
- **Pre-Execution Snapshots:** The checkpoint manager records file states prior to any write or edit, allowing clean rollback via `/undo`.
- **Command Filtering:** Detects and blocks known destructive system commands (e.g., recursive root deletions, format utilities).
- **Network Validation:** Web-fetching tools validate target URLs against private network ranges, loopback addresses, and cloud instance metadata addresses (`169.254.169.254`) to prevent Server-Side Request Forgery (SSRF).

---

## Testing

Locode contains an automated test suite verifying providers, parsing, file operations, error isolation, and circuit breakers:

```bash
# Run unit and integration tests (122 tests)
npm test

# Run TypeScript typecheck
npm run typecheck

# Build distribution bundle
npm run build
```

---

## License

Source-Available Non-Commercial License. Copyright (c) 2026 Akshat Yadav. All rights reserved. Free for personal, educational, research, and non-commercial development. Commercial use, redistribution, or deployment requires explicit permission (see [LICENSE](LICENSE)).
