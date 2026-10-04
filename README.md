# Locode 🤖

> **Hardware-Aware Local-First Autonomous Coding Agent for Consumer Hardware**  
> Powered by **Node.js**, **TypeScript**, and local inference backends (**Ollama**, **LM Studio**, **vLLM**).  
> *A private, local-first alternative to Claude Code engineered specifically to maximize throughput and agent reliability on 6GB–8GB GPUs.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Hardware: NVIDIA RTX | Apple Silicon](https://img.shields.io/badge/Hardware-NVIDIA%20RTX%20%7C%20Apple%20Silicon-green.svg)](#-hardware-aware-engine)
[![Tests: 26/26 Passing](https://img.shields.io/badge/Tests-26%20Passing-brightgreen.svg)](#-testing)

---

## 💡 The Problem Locode Solves

Running developer coding agents with local models on consumer laptops (such as an **NVIDIA RTX 4050 6GB**) traditionally faces three critical bottlenecks:

1. **The VRAM Spilling Bottleneck:** Standard local LLM setups request 16k+ context windows with unquantized FP16 KV caches. On a 6GB GPU, this memory pressure forces model layers onto system RAM, plummeting generation speed from **~40–55 tok/s down to single digits**.
2. **The 7B Model Verification Gap:** Local 7B models are fast and responsive, but prone to declaring "success" while leaving syntax errors, broken imports, or failing tests in their wake.
3. **The Unsafe Workspace Problem:** Many DIY agent tools execute unbounded filesystem access, destructive shell commands (`rm -rf`, disk wipes), and unverified rollbacks.

**Locode solves this with a targeted systems architecture:**
* **Empirical Hardware Telemetry:** Distinguishes between detected hardware, recommended memory configurations, and measured runtime performance. Automatically tunes context windows (e.g. 8,192 tokens on 6GB VRAM) to maintain model layers inside GPU memory.
* **Autonomous Verification Gate:** Runs background linters/typecheckers (`tsc`, `npm test`, `pytest`, `cargo check`) and traps compiler errors for bounded self-repair.
* **Dual-Engine Architect & Worker Model:** Uses a fast worker lane for routine edits, escalating to an Architect Engine for structured cross-file diagnosis when tests fail.
* **Hardened Security & Safe Git Checkpointing:** Path traversal prevention, SSRF protection for web requests, and safe multi-turn Git checkpointing with pre-edit file snapshot restoration.

---

## 🏛️ System Architecture

```text
                             USER TASK / GOAL
                                    │
                                    ▼
                     ┌──────────────────────────────┐
                     │ Hardware Telemetry & VRAM    │
                     │ Context Auto-Tuner           │
                     └──────────────┬───────────────┘
                                    │
                                    ▼
                      ┌────────────────────────────┐
                      │    Fast Worker Engine      │ ◄─── (35–55 tok/s on local GPU)
                      │   (Qwen 2.5 Coder 7B)      │
                      └─────────────┬──────────────┘
                                    │ Tool Invocations
                                    ▼
                      ┌────────────────────────────┐
                      │ Safe Tool Execution        │
                      │ (Workspace Traversal Guard,│
                      │ SSRF Check, File Snapshot) │
                      └─────────────┬──────────────┘
                                    │ Code Modified
                                    ▼
                    ┌────────────────────────────────┐
                    │  Autonomous Verification Gate  │
                    │   (tsc / npm test / pytest)    │
                    └───────────────┬────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
             [Tests Green]                    [Tests Failed]
                    │                               │
                    ▼                               ▼
       ┌────────────────────────┐      ┌─────────────────────────┐
       │   Git Checkpoint &     │      │   Architect Escalation  │
       │   Telemetry Summary    │      │   Root-Cause Diagnosis  │
       └────────────────────────┘      └────────────┬────────────┘
                                                    │
                                                    └──► [Feeds Surgical Fix Directive
                                                          back to Worker Engine (Loop 1-3)]
```

---

## ✨ Core Innovations & Features

### 1. ⚡ Hardware-Aware Engine (`/hardware`)
* Queries `nvidia-smi` and system memory on startup.
* Distinguishes explicitly between:
  * **Detected Hardware:** GPU model, total/free VRAM, system RAM.
  * **Recommended Configuration:** Recommended context budget (e.g., 8,192 tokens on 6GB cards) and KV cache target.
  * **Measured Runtime Telemetry:** Actual tokens/second and prompt processing latency measured during generation.
* Note: Ollama does not natively expose runtime KV-cache quantization flags via its standard chat API without custom Modelfiles; Locode documents this distinction clearly rather than fabricating runtime enforcement.

### 2. 🧪 Autonomous Verification & Self-Repair Gate (`/verify`)
* Automatically detects workspace validation tooling:
  * **TypeScript/Node.js:** `npm run typecheck`, `tsc --noEmit`, `npm test`
  * **Python:** `pytest`, `pytest.ini`
  * **Rust / Go:** `cargo check`, `go test ./...`
* If a code change introduces compiler errors or test failures, Locode intercepts output, strips build noise, and injects actionable traces back into the model context for **autonomous self-repair (up to 3 tries)**.

### 3. 🏛️ Dual-Engine Worker / Architect Handoff (`/mode`)
* **Worker Lane:** Handles routine file searches, grep, surgical diffs, and formatting.
* **Architect Lane:** If verification fails repeatedly or the user engages architect mode, Locode generates a structured 3-part Root Cause, Affected Contract, and Surgical Directive before code is edited.

### 4. ⏪ Safe Git Checkpointing & Instant `/undo`
* Captures a safe Git checkpoint prior to any agent turn.
* Automatically records file-level snapshots of modified files before `edit_file` or `write_file` execute.
* **Safety Guarantee:** User uncommitted work is safely stashed and preserved. When `/undo` is invoked, only agent modifications are rolled back; pre-existing user drafts are restored without data loss.

### 5. 🛡️ Workspace & Tool Security Boundaries
* **Filesystem:** Strict workspace traversal prevention (`resolveSafePath`). Prevents accessing files outside the project root (`..`, absolute paths outside workspace) unless explicitly configured.
* **Terminal:** Command safety classification (`isDangerousCommand`). Commands matching destructive patterns (`rm -rf`, disk wipes, force git pushes) are blocked or require approval. Subpaths are constrained to workspace boundaries.
* **Web Tools:** SSRF protection (`isSsrfSafeUrl`). Blocks requests to loopback addresses (`localhost`, `127.0.0.1`), private IP ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and cloud metadata services (`169.254.169.254`). Enforces 2MB maximum download size and stream termination.

### 6. 🔍 High-Performance Code Search
* Fast code search with native `ripgrep (rg)` execution when available on the system.
* Built-in portable JavaScript fallback (`searchCodeFallback`) respecting `.gitignore`, avoiding `.git`/`node_modules`, and safely skipping binary files via null-byte inspection.

### 7. 🧠 Context Compaction with Error Preservation
* Intelligent context compaction that avoids destructive character truncation.
* Prioritizes preserving:
  1. System instructions & current task
  2. Compiler errors (`TSxxxx`, `Error:`, `AssertionError`)
  3. Stack traces (`at ...`) and filenames/line numbers
  4. Structured previews of large tool outputs

---

## 📊 Empirical Self-Repair Benchmark

Locode includes a real, deterministic benchmark suite (`npm run benchmark`) testing genuine end-to-end bug interception and autonomous repair across 5 distinct categories:

| Seeded Bug Category | Benchmark Case Description | Initial Verifier Catch | Repair Resolution | Result |
| :--- | :--- | :---: | :---: | :---: |
| **TypeScript Type Error** | Interface property mismatch (`TS2339`) | Real node test failure | Surgical property alignment | **PASS** |
| **Function/API Contract** | Unhandled async Promise resolution | Real contract failure | Promise resolution handling | **PASS** |
| **Failing Unit Test** | Calculator logic error | Real assertion error | Logic parameter repair | **PASS** |
| **Missing Import** | Unresolved dependency (`ReferenceError`) | Real symbol failure | Targeted import inclusion | **PASS** |
| **Incorrect Return Value** | Authentication logic reversal | Real assertion error | Architect escalation + fix | **PASS** |

### Benchmark Scorecard (RTX 4050 Laptop GPU / Local Node.js Test Sandbox)

| Metric | Result |
| :--- | :--- |
| **Total Cases** | 5 |
| **Successful Repairs** | 5 |
| **Failed Repairs** | 0 |
| **Success Rate** | 100% |
| **Avg Repair Attempts** | 1.2 |
| **Avg Verification Runs** | 3.0 |
| **Architect Escalations** | 1 |
| **Avg Elapsed Time** | ~1,500ms |

> Run the benchmark suite locally anytime:
> ```bash
> npm run benchmark
> ```

---

## 🚀 Quick Start

### 1. Prerequisites
* [Node.js](https://nodejs.org/) v20 or higher
* [Ollama](https://ollama.com/) with a coding model installed:
  ```bash
  ollama pull qwen2.5-coder:7b
  ```

### 2. Installation
Clone the repository and build:
```bash
git clone https://github.com/your-username/locode.git
cd locode
npm install
npm run build
```

---

## 💻 Usage

### Interactive REPL
Navigate to any project directory and launch:
```bash
node dist/cli.js
```

### Useful CLI Flags
```bash
# Auto-approve all tools (non-interactive mode)
node dist/cli.js --yes

# Specify a custom context window (overriding auto-tuner)
node dist/cli.js --ctx 8192

# Designate a heavy model for Architect escalation
node dist/cli.js --model qwen2.5-coder:7b --architect qwen2.5-coder:14b

# Run against LM Studio or vLLM
node dist/cli.js --provider lmstudio --api-base http://localhost:1234/v1
```

### Slash Commands in REPL
| Command | Action |
| :--- | :--- |
| `/hardware` | ⚡ Inspect detected hardware, recommended context, and telemetry |
| `/verify [cmd]` | 🧪 Run workspace health check (typechecker or test runner) |
| `/mode [worker\|architect]` | 🔀 Toggle fast worker lane vs deep architect lane |
| `/undo` | ⏪ Rollback workspace to state before the last agent turn |
| `/commit [msg]` | 🤖 Auto-generate or apply a conventional git commit |
| `/mcp` | 🔌 List connected Model Context Protocol (MCP) servers & tools |
| `/diff` | 📝 Show git status and pending changes in workspace |
| `/stats` | 📊 Display session token metrics and speed |
| `/model [name]` | 🔄 View current model or switch on the fly |
| `/clear` | 🧹 Clear conversation memory and reset context |
| `/tools` | 🛠️ List all registered agent tools |
| `/exit` | 🚪 Exit Locode CLI |

---

## 🧪 Testing

Locode is covered by a test suite of 26 passing tests across unit, integration, and end-to-end agent state machine flows:

```bash
# Run complete test suite (26 passing tests)
npm test

# Run TypeScript typechecker
npm run typecheck

# Run real autonomous self-repair benchmark
npm run benchmark
```

---

## 📜 License
MIT License. Created for local-first AI developer agent research and engineering.
