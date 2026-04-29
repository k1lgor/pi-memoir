# 🧠 pi-memoir (_/paɪ mɛmˈwɑːr/_)

> **Pronunciation:** pi-mem-wahr (French _mémoire_ = memory)

![pi-memoir Hero](docs/assets/logo.png)

**Project-wide persistent memory for [pi](https://pi.dev) — the LLM queries the memoir instead of reading all files, saving ~90%+ tokens.**

Pi-memoir builds a structured knowledge base of your project. Instead of the LLM running `bash`, `ls`, `grep`, and `read` on 20 files to understand your project (costing tens of thousands of tokens per session), it queries the memoir for architecture, structure, config, dependencies, and every source file.

Inspired by [MemPalace](https://github.com/mempalace/mempalace) (verbatim memory with semantic retrieval) and [Graphify](https://github.com/safishamsi/graphify) (knowledge graph extraction).

## How It Saves Tokens

| Approach                                      | Token Cost                        |
| --------------------------------------------- | --------------------------------- |
| LLM runs `ls`, `find`, `grep`, reads 10 files | ~15,000–30,000 tokens per session |
| LLM queries the memoir via `memo_search`      | **~200–500 tokens** per session   |
| **Savings**                                   | **~95–98% per session**           |

The key insight: **project knowledge doesn't change often.** Harvest once, query forever.

## How It Works

```
<your-project>/
└── .pi/memoir/
    └── memories.jsonl    ← Append-only JSONL storage (per-project)
```

The extension injects a **system prompt instruction** at the start of every turn via `before_agent_start`:

```
=== PI-MEMOIRE: DON'T USE BASH — USE THE MEMOIRE ===
CRITICAL: Before running ANY bash/ls/find/grep/wc/read commands
to explore the project, you MUST call memo_search first.
• "what's the architecture?" → memo_search({ query: "architecture" })
• "what files?" → memo_search({ tags: "project:structure" })
• "dependencies?" → memo_search({ query: "package", tags: "project:manifest" })
...
If memo_search returns nothing, THEN fall back to bash/read.
```

This forces the LLM to check the memoir **first** before falling back to bash.

## What Gets Harvested

On `/memo harvest` (or `memo_harvest` tool), the harvester walks **every file** in your project and stores:

| Memory                | Tag                         | What it contains                                                |
| --------------------- | --------------------------- | --------------------------------------------------------------- |
| Project README        | `project:readme`            | Title, first heading, line count                                |
| Package manifest      | `project:manifest`          | Name, version, deps, scripts, detected language                 |
| Directory tree        | `project:structure`         | Recursive tree (4 levels deep, 80 lines max)                    |
| Entry points          | `project:entry`             | `index.ts`, `main.ts`, `src/index.ts`, etc.                     |
| Config files          | `project:config`            | `tsconfig.json`, `vite.config.ts`, `.eslintrc`, etc.            |
| **Every source file** | `project:file`, `file:path` | **All files** with source extensions (128 extensions supported) |

### Source file harvesting

The harvester captures individual memories for every source file in the project:

- **128 file extensions** supported (`.ts`, `.js`, `.py`, `.rs`, `.md`, `.json`, `.vue`, `.svelte`, `.css`, `.sh`, `.java`, `.cpp`, `.go`, `.rb`, `.php` — and 100+ more)
- **200 file cap** — prevents bloat on large projects (covers 90%+ of GitHub repos fully)
- **20KB limit** — skips large generated/bundled files
- **Smart summaries** — code files show first import/export, JSON shows top-level keys, Markdown shows first heading
- Skips `node_modules`, `.git`, `dist`, `build`, `.cache`, `target`, `vendor` and other non-source dirs

### Auto-Capture

On session shutdown, key moments (edited files, decisions) are automatically condensed and stored with `"auto"` source tag.

## Installation

### Via git (recommended)

```bash
pi install git:github.com/k1lgor/pi-memoir
```

### Local path (development)

```bash
pi install ./path/to/pi-memoir
```

### Quick test (no install)

```bash
pi --extension ./index.ts
```

## Usage

### Quick Start

```text
User: "/memo harvest"
LLM: calls memo_harvest → scans every file
→ "✅ Harvested 38 memories about this project."

User: "What's the architecture?"
LLM: calls memo_search({ query: "architecture", tags: "project:structure" })
→ "Project structure: 12 files, 3 dirs
     📁 src/ → 📁 api/ → routes.ts, middleware.ts
     📁 src/ → 📁 components/ → Header.tsx
     📄 README.md, package.json, ..."
```

### Tools (LLM can call these)

| Tool           | Description                                                            |
| -------------- | ---------------------------------------------------------------------- |
| `memo_harvest` | **Scan the entire project** — walks every file, stores memories        |
| `memo_search`  | **REPLACES bash/ls/read** — query project knowledge by keywords + tags |
| `memo_store`   | Store additional ad-hoc facts and decisions                            |

### Commands

| Command                             | Description                                 |
| ----------------------------------- | ------------------------------------------- |
| `/memo harvest`                     | Scan project and build knowledge base       |
| `/memo search <query> [--tags t1]`  | Search stored memories                      |
| `/memo list [--tags t1]`            | List recent memories (shows in widget)      |
| `/memo store <text> [--tags t1,t2]` | Store a memory manually                     |
| `/memo delete <number>`             | Delete by number from list                  |
| `/memo delete --all` or `-a`        | **Delete ALL memories** (with confirmation) |
| `/memo stats`                       | Show memory count and storage path          |
| `/memo path`                        | Show storage file path                      |

### Benchmark

A standalone benchmark script (`bench.mjs`) compares token costs:

```bash
# Quick benchmark (common key files)
node bench.mjs .

# Full benchmark — every source file in the project
node bench.mjs . --all

# Specific files
node bench.mjs . README.md package.json
```

Sample output against the TypeScript compiler repo (41K source files):

```
📈 Summary
  Files scanned:    40,877 (142 with memoir, 40,735 without)
  Read files:       ~36,362,143 tokens
  Query memoir:    ~19,293 tokens
  Savings:          ~36,342,850 tokens (99.9%)
```

## Architecture

```
pi-memoir/
├── index.ts       ← Entry point. Inits storage, wires tools/hooks/commands.
│                      Injects "DON'T USE BASH" rule at end of system prompt
│                      via before_agent_start (only if memories exist).
├── storage.ts     ← MemoryStore class. JSONL file at .pi/memoir/memories.jsonl.
│                      store(), search(), list(), delete(), deleteByIndex().
│                      Keyword search with TF scoring. Singleton exported.
├── harvester.ts   ← Project scanner. Walks entire directory tree, creates
│                      structured memories for every source file (128 extensions,
│                      200 cap, <20KB limit, smart summaries per file type).
├── tools.ts       ← Three LLM-callable tools:
│                      • memo_harvest — scan entire project
│                      • memo_search  — REPLACES bash for project exploration
│                      • memo_store   — save ad-hoc facts
├── hooks.ts       ← Lifecycle hooks:
│                      • agent_start → clears stale memo widgets
│                      • session_start → warns if not harvested
│                      • session_shutdown → auto-stores key decisions
├── commands.ts    ← /memo command with subcommands:
│                      list, search, store, delete (with --all/-a), harvest,
│                      stats, path. Uses setWidget() with auto-refresh.
├── bench.mjs      ← Standalone Node.js benchmark (zero deps).
│                      Compares token cost: read file vs query memoir.
│                      Usage: node bench.mjs . --all
├── package.json   ← Extension metadata for pi auto-discovery
└── README.md      ← This file
```

**Zero external dependencies. Pure TypeScript.** Only runtime dep is `typebox` (bundled with pi).

## Real-world benchmarks

Tested against 6 repos ranging from tiny to massive to show real token savings:

| Repository                                                                | Files         | Size   | Memories | Read Cost  | Memoir Cost | Savings   |
| ------------------------------------------------------------------------- | ------------- | ------ | -------- | ---------- | ----------- | --------- |
| [microsoft/VibeVoice](https://github.com/microsoft/VibeVoice)             | 53 source     | 264 MB | 45       | ~246K tok  | ~10K tok    | **96%**   |
| [rtk-ai/rtk](https://github.com/rtk-ai/rtk)                               | 258 source    | 4.5 MB | 231      | ~826K tok  | ~41K tok    | **95%**   |
| [thedotmack/claude-mem](https://github.com/thedotmack/claude-mem)         | 679 source    | 104 MB | 506      | ~2.7M tok  | ~55K tok    | **98%**   |
| [Yeachan-Heo/oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex)     | 921 source    | 15 MB  | 508      | ~2.9M tok  | ~71K tok    | **98%**   |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | 2,538 source  | 64 MB  | 514      | ~12.2M tok | ~67K tok    | **99%**   |
| [microsoft/TypeScript](https://github.com/microsoft/TypeScript)           | 40,877 source | 548 MB | 505      | ~36M tok   | ~19K tok    | **~100%** |

**Key takeaways:**

- Cap raised from 200→500: coverage on medium repos jumped from ~67%→74% (rtk) and ~19%→47% (claude-mem)
- VibeVoice (53 files) and rtk (258 files) — **fully harvested**, didn't hit the cap
- All repos: **95–100% token savings** when LLM queries memoir instead of reading files
- Even TypeScript (41K files): orientation cost drops from ~36M tokens to ~19K tokens

## File reference

| File           | Lines | Role                                      |
| -------------- | ----- | ----------------------------------------- |
| `index.ts`     | 69    | Entry + system prompt injection           |
| `storage.ts`   | 226   | MemoryStore, JSONL CRUD, keyword search   |
| `harvester.ts` | 730   | Project scanner — walks every file        |
| `tools.ts`     | 190   | LLM tools (harvest, search, store)        |
| `hooks.ts`     | 126   | Lifecycle hooks (widgets, session events) |
| `commands.ts`  | 245   | User commands (/memo)                     |
| `bench.mjs`    | 285   | Standalone token cost benchmark           |
| `package.json` | 11    | Extension metadata                        |

**7 source files, 1,597 total lines, 0 npm dependencies.**

## Roadmap

- [x] Project harvester — scans every source file (128 extensions)
- [x] System prompt injection — LLM uses memoir before bash
- [x] Keyword search with TF scoring
- [x] Per-project persistence (`.pi/memoir/`)
- [x] LLM tools: harvest, search, store
- [x] Auto-capture on session shutdown
- [x] `--all/-a` delete flag with confirmation
- [x] Standalone benchmark script
- [x] Auto-harvest on first session start
- [ ] Semantic search via LLM re-ranking
- [ ] Knowledge graph from cross-file relationships
- [ ] Obsidian vault export

## License

MIT
