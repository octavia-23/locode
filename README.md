# Locode 🤖

> **Local-First Autonomous AI Software Engineer Engineered for Consumer Hardware**  
> Powered by **Node.js**, **TypeScript**, and local inference backends (**llama.cpp / TurboQuant**, **Ollama**, **LM Studio**, **vLLM**).  
> *A private, local-first autonomous developer designed to deliver continuous agentic execution and up to 262k context on consumer GPUs.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)
[![License: Non--Commercial](https://img.shields.io/badge/License-Non--Commercial-orange.svg)](#-license)
[![Tests: 50/50 Passing](https://img.shields.io/badge/Tests-50%2F50%20Passing-brightgreen.svg)](#-testing)
[![Context: Up to 262k](https://img.shields.io/badge/Context-Up%20to%20262k-purple.svg)](#-inference-profiles)

---

## 💡 The Problem Locode Solves

Running developer coding agents with local models on consumer laptops (such as an **NVIDIA RTX 4050 6GB / 16GB RAM**) traditionally faces four fatal roadblocks:

1. **The VRAM Spilling & Ingestion Timeout:** Ingesting massive codebases (30k+ tokens) on consumer hardware with hybrid CPU/GPU offloading takes minutes. Standard HTTP clients time out at 300s, killing the session mid-turn.
2. **The Passive Loop Trap:** Local models often fall into repetitive "research procrastination" loops—reading files repeatedly without ever modifying code.
3. **The 7B/14B/35B Verification Gap:** Local models frequently report tasks as "complete" while leaving syntax errors, broken imports, or failing tests behind.
4. **The Unsafe Workspace Risk:** Typical agent scripts risk destructive shell executions (`rm -rf`, disk wipes), directory traversal leaks, and unrecoverable workspace edits.

**Locode solves this with a purpose-built systems architecture:**
* **Infinite-Timeout Streaming Engine:** Bypasses Node.js socket timeouts with custom `undici` dispatching and real-time SSE chunked streaming—enabling stable multi-minute prefill for contexts up to **262,144 tokens**.
* **Autonomous Action Gate:** Detects passive exploration loops and temporarily withdraws read tools after 2 read turns to strictly enforce code modification (`edit_file`, `write_file`).
* **Dynamic Step Leash:** Starts with a 150-step budget and dynamically adds **+80 steps** on every successful file edit, allowing complex refactors to run unattended overnight.
* **Autonomous Verification Gate:** Runs background linters/typecheckers (`tsc`, `npm test`, `pytest`, `cargo check`) and traps compiler diagnostics for automated multi-attempt self-repair.
* **Hardened Security & Instant Git `/undo`:** Strict workspace boundary enforcement (`resolveSafePath`), SSRF protection, and file-level pre-edit snapshot tracking for instant rollback without losing uncommitted user work.

---

## 🏛️ System Architecture

```text
                             USER TASK / OBJECTIVE
                                       │
                                       ▼
                     ┌───────────────────────────────────┐
                     │ Hardware Telemetry & Profile Init │
                     │   (Ultra-Context 262k / Balanced) │
                     └─────────────────┬─────────────────┘
                                       │
                                       ▼
                     ┌───────────────────────────────────┐
                     │   Prefix-Stable Context Engine    │
                     │  (7-Layer Structured Memory)      │
                     └─────────────────┬─────────────────┘
                                       │
                                       ▼
                     ┌───────────────────────────────────┐
                     │   Active Streaming Engine         │ ◄─── (Zero-Timeout Fetch Dispatcher)
                     │   (llama.cpp TurboQuant / Ollama) │
                     └─────────────────┬─────────────────┘
                                       │
                        Tool Calls Requested?
                                       │
                        ┌──────────────┴──────────────┐
                        │                             │
                   [Tool Actions]                [Final Text]
                        │                             │
                        ▼                             ▼
       ┌─────────────────────────────────┐   ┌─────────────────┐
       │   Autonomous Action Gate        │   │ Clean Session   │
       │   (Blocks passive read traps)   │   │ Memory Save     │
       └────────────────┬────────────────┘   └─────────────────┘
                        │
                        ▼
       ┌─────────────────────────────────┐
       │   Sandboxed Tool Execution      │
       │   (Path Guard, SSRF Filter,     │
       │    Pre-Edit Snapshot Recorded)  │
       └────────────────┬────────────────┘
                        │
                        ▼
       ┌─────────────────────────────────┐
       │  Autonomous Verification Gate   │
       │  (tsc / npm test / pytest)      │
       └────────────────┬────────────────┘
                        │
                 Passes Verification?
                 ┌──────┴──────┐
                 │             │
              [YES]          [NO]
                 │             │
                 ▼             ▼
       ┌────────────────┐  ┌───────────────────────────────┐
       │ Dynamic Leash  │  │ Architect Root-Cause Diagnosis│
       │ +80 Steps      │  │ ➔ Direct Surgical Repair      │
       └────────────────┘  └───────────────────────────────┘
```

---

## ✨ Core Features & Innovations

### 1. ⚡ Ultra-Context Engine & Hardware Profiles (`/profile`)
Locode includes dedicated inference profiles tailored for varying VRAM and context demands:

| Profile | Context Window | Target Use Case | KV Cache Strategy |
| :--- | :---: | :--- | :---: |
| **`ultra-context`** *(Default)* | **262,144 tokens** | Full multi-file repository understanding | TurboQuant 4-bit / 3-bit |
| **`large-context`** | **65,536 tokens** | Large multi-file tasks with moderate VRAM | TurboQuant 4-bit |
| **`performance`** | **32,768 tokens** | High-speed single-turn edits | TurboQuant 4-bit |
| **`balanced`** | **16,384 tokens** | Compact memory footprint | Standard / Balanced |

### 2. 🌊 Zero-Timeout Streaming Pipeline
* Bypasses the default 300-second Node.js `headersTimeout` (`fetch failed`) during lengthy CPU/GPU prompt prefill on 30k+ token prompts.
* Employs live Server-Sent Events (SSE) streaming so tokens and tool invocations stream in real time with continuous tokens/second telemetry.

### 3. 🛡️ Autonomous Action Gate & Dynamic Leash
* **Anti-Procrastination Enforcement:** If a model spends 2 consecutive turns executing read-only tools (`view_file`, `search_code`) without modifying code, Locode temporarily withdraws passive inspection tools, making it impossible for the model to get stuck in read loops.
* **Overnight Execution Leash:** Starts with a 150-step budget and dynamically grants **+80 additional steps** whenever code is modified, preventing runaway execution while allowing long-running tasks to complete unattended.

### 4. 🧪 Autonomous Verification & Self-Repair Gate (`/verify`)
* Automatically detects project test and typecheck suites:
  * **TypeScript/Node.js:** `npm run typecheck`, `tsc --noEmit`, `npm test`
  * **Python:** `pytest`, `pytest.ini`, `python -m unittest`
  * **Rust / Go:** `cargo check`, `go test ./...`
* When errors occur, Locode extracts the relevant compiler diagnostic lines, strips build noise, and injects actionable repair directives back into the model context.

### 5. ⏪ Safe Multi-Turn Git Checkpointing & Instant `/undo`
* Preserves user uncommitted changes before turns begin.
* Automatically records file snapshots before `edit_file` or `write_file` execute.
* `/undo` surgically rolls back only the agent's edits without discarding pre-existing user drafts.

### 6. 🔒 Enterprise Security Sandboxing
* **Filesystem:** Strict workspace traversal prevention (`resolveSafePath`). Prevents accessing files outside the workspace root.
* **Terminal:** Dangerous command filter (`isDangerousCommand`) blocking destructive system actions (`rm -rf`, disk wipes, format commands).
* **Web Tools:** SSRF protection (`isSsrfSafeUrl`) blocking loopback addresses, private subnet ranges, and cloud metadata endpoints (`169.254.169.254`).

---

## 📊 Empirical Self-Repair Benchmark

Locode includes an end-to-end benchmark suite (`npm run benchmark`) testing genuine bug interception and autonomous repair across 5 categories:

| Seeded Bug Category | Benchmark Case Description | Initial Verifier Catch | Repair Resolution | Result |
| :--- | :--- | :---: | :---: | :---: |
| **TypeScript Type Error** | Interface property mismatch (`TS2339`) | Real node test failure | Surgical property alignment | **PASS** |
| **Function/API Contract** | Unhandled async Promise resolution | Real contract failure | Promise resolution handling | **PASS** |
| **Failing Unit Test** | Calculator logic error | Real assertion error | Logic parameter repair | **PASS** |
| **Missing Import** | Unresolved dependency (`ReferenceError`) | Real symbol failure | Targeted import inclusion | **PASS** |
| **Incorrect Return Value** | Authentication logic reversal | Real assertion error | Architect escalation + fix | **PASS** |

### Benchmark Scorecard (RTX 4050 Laptop GPU / Local Test Sandbox)
* **Total Cases:** 5
* **Successful Repairs:** 5 (100% success rate)
* **Average Repair Attempts:** 1.2
* **Average Verification Runs:** 3.0
* **Average Repair Time:** ~1,550 ms

---

## 🚀 Quick Start

### 1. Prerequisites
* [Node.js](https://nodejs.org/) v20 or higher
* A local model runtime:
  * **llama.cpp** (`llama-server.exe`) for native TurboQuant & ultra-context (recommended)
  * **Ollama** (`ollama pull qwen2.5-coder:7b`)
  * **LM Studio** / **vLLM** (OpenAI-compatible endpoint)

### 2. Installation
```bash
git clone https://github.com/octavia-23/locode.git
cd locode
npm install
npm run build
```

---

## 💻 Usage

### Interactive REPL Mode
```bash
npm start
# or after build:
node dist/cli.js
```

### Autonomous / Non-Interactive Mode
Run a one-shot coding task to completion without confirmation prompts:
```bash
node dist/cli.js --auto "Implement user authentication middleware and run npm test"
```

### Useful CLI Flags
```bash
# Autonomous mode (auto-approves all tool actions)
node dist/cli.js --auto

# Select an inference profile
node dist/cli.js --profile ultra-context   # 262,144 tokens
node dist/cli.js --profile performance     # 32,768 tokens
node dist/cli.js --profile balanced        # 16,384 tokens

# Explicit context override
node dist/cli.js --ctx 64k

# Target a specific model file or provider
node dist/cli.js --model-path "C:\models\qwen-35b.gguf"
node dist/cli.js --provider llamacpp
node dist/cli.js --provider ollama --model qwen2.5-coder:7b
node dist/cli.js --provider openai --api-base http://localhost:1234/v1
```

### Slash Commands in REPL
| Command | Action |
| :--- | :--- |
| `/auto` | ⚡ Toggle Autonomous Mode (permissionless execution) |
| `/hardware` | 🖥️ Inspect hardware telemetry, VRAM, and runtime stats |
| `/verify [cmd]` | 🧪 Run workspace verification (typechecker or test runner) |
| `/mode [worker\|architect]` | 🔀 Toggle fast worker lane vs deep architect lane |
| `/undo` | ⏪ Rollback workspace to state prior to the last agent turn |
| `/diff` | 📝 Inspect pending workspace modifications and git diffs |
| `/stats` | 📊 Display session token metrics, duration, and TPS |
| `/commit [msg]` | 🤖 Auto-generate or apply a conventional git commit |
| `/mcp` | 🔌 Inspect connected Model Context Protocol (MCP) servers |
| `/model [name]` | 🔄 Switch active model on the fly |
| `/clear` | 🧹 Reset conversation history and working memory |
| `/help` | ❓ Display all interactive commands and options |
| `/exit` | 🚪 Exit Locode CLI |

---

## 🧪 Testing

Locode is covered by a 50-test automated suite across unit, integration, and mock runtime flows:

```bash
# Run complete test suite (50 tests passing)
npm test

# Run TypeScript typecheck
npm run typecheck

# Run deterministic autonomous self-repair benchmark
npm run benchmark

# Production build
npm run build
```

---

## 📜 License
Source-Available Non-Commercial License. Copyright (c) 2026 Akshat Yadav. All rights reserved. Free for personal, educational, research, and non-commercial development. Commercial use, redistribution, or deployment requires explicit permission (see [LICENSE](LICENSE)).
