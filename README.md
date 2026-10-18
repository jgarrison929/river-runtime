# river-runtime

An experimental, always-on runtime for AI coding agents: persistent memory, pattern learning, an MCP server, and Telegram + webchat channels.

> **How this was built:** I designed the system architecture and directed AI coding agents to implement it. I don't hand-write the code; I write the specs, review the output, and decide what ships.

**Status:** No longer actively developed. I now work with frontier agent harnesses, and this repo stays up as a reference for the memory and orchestration design.

> **Full 5-tier memory architecture spec →** [docs/architecture.md](docs/architecture.md)

## Where It's Used

My main project built this way is [Pitbull](https://github.com/jgarrison929/pitbull), a construction ERP. You can see its full history in the [pull requests](https://github.com/jgarrison929/pitbull/pulls?q=is%3Apr+is%3Amerged).

---

Built for a personal AI agent that ships PRs, manages infrastructure, and maintains a live multi-module SaaS application. This is the daemon that makes it all work.

## What It Does

River-runtime is an always-on Node.js daemon that connects an LLM to the real world — Telegram, a web interface, tools, memory, and scheduled tasks. It's not a framework or library. It's a running system.

```
Telegram ──┐                    ┌── Tools (exec, file ops, web)
            ├── Message Router ──┤
Webchat  ──┘        │           └── Memory (5-tier architecture)
                    │
              Agent Core ←── Context Builder (identity files + episodic recall)
                    │
              LLM (Anthropic) ←── Dispatch Enhancer (pattern injection)
                    │
              Cron / Heartbeat ──→ Proactive behavior
```

### Core Features

- **5-tier memory architecture** — episodic vectors (sqlite-vec), experience-driven pattern learning with confidence/decay scoring, technical knowledge base, knowledge graph, symbol-level code intelligence
- **Post-task extraction loop** — after every task, patterns are extracted and stored, making future dispatches measurably smarter over time
- **MCP server** — exposes all memory tools over Model Context Protocol so Claude Code, Codex, and sub-agents share one evolving brain
- **Dispatch-time context enrichment** — relevant patterns, knowledge, and impact analysis injected into every LLM call (≤8K tokens)
- **Pattern lineage tracking** — full provenance chains: Conversation → Pattern → Dispatch → Outcome → New Pattern
- **Channel adapters** — Telegram (Grammy + runner + throttler) and webchat with real-time streaming
- **Adaptive thinking** — Anthropic extended thinking with automatic budget management
- **120+ tests** — vitest, covers memory tiers, pattern extraction, REST API, lineage, and CRUD

## Architecture

### Memory Tiers

| Tier | Storage | Purpose |
|------|---------|---------|
| **Working** | In-memory + JSONL | Current conversation context |
| **Episodic** | SQLite + sqlite-vec | Searchable conversation chunks with vector embeddings |
| **Pattern** | SQLite | Experience-driven learnings with confidence scoring and decay |
| **Knowledge Base** | SQLite + sqlite-vec | Ingested documents, chunked and searchable |
| **Knowledge Graph** | SQLite adjacency tables | Entity relationships and impact analysis |
| **Code Intelligence** | SQLite | Symbol-level index with dependency and change tracking |

### Agent Tools (24 total)

**Memory & Knowledge:** search_memory, get_patterns, query_knowledge, search_code, impact_analysis, query_graph, add_memory, record_task_outcome, get_brain_stats

**Computer Control:** take_screenshot, computer_click, computer_type, computer_press_key, list_windows, focus_window, mouse_move, mouse_scroll

**Code Intelligence:** list_repos, query, cypher, context, detect_changes, rename, impact

Tools are filtered per channel — Telegram gets conversational tools only, webchat gets everything.

> **⚠️ Safety: experimental, run in a VM or sandbox.** These tools give the model real control of the machine:
> - The computer-control tools only check that coordinates are numbers. They run PowerShell (`-ExecutionPolicy Bypass`) from WSL to move the mouse, click, type, press keys, and take screenshots of the Windows desktop. Nothing asks you to confirm an action first.
> - `exec` runs any shell command. It has a timeout and a short blocklist that mainly stops the agent from killing its own process. That blocklist is not a security boundary.
> - The file tools accept any path.
> - Telegram never gets exec, file, or computer-control tools (set `allowed_users` to limit who can message the bot). Webchat gets every tool and has no login. The server listens on `0.0.0.0`, so keep the port off any network you don't control.

## Quick Start

```bash
# Clone and install
git clone https://github.com/jgarrison929/river-runtime.git
cd river-runtime
pnpm install

# Configure
cp river.config.example.yaml river.config.yaml
cp .env.example .env
# Edit both files with your API keys and settings

# Build and run
pnpm build
node dist/index.js

# Run tests
pnpm test
```

### Requirements

- Node.js 22+
- pnpm
- Anthropic API key
- Telegram bot token (optional, for Telegram channel)
- OpenAI API key (optional, for embeddings)

## Configuration

See `river.config.example.yaml` for the full configuration reference. Key sections:

- **identity** — markdown files loaded into every LLM context (personality, memory, user info)
- **llm** — model selection, context window, max tokens
- **channels** — Telegram and webchat settings
- **memory** — extraction model, embedding model, consolidation schedules

## Project Structure

```
src/
├── agent/           # Core agent loop, session management, context builder, compaction
├── channels/        # Telegram (Grammy), webchat (Express + WebSocket)
├── llm/             # Anthropic SDK integration, streaming, tool loop
├── memory/          # All 5 tiers: episodic, patterns, knowledge, graph, code index
├── mcp/             # MCP server exposing memory tools
├── scheduler/       # Cron jobs, heartbeat
├── tools/           # exec, filesystem, web search/fetch, computer control
├── utils/           # Logger, health server
└── web/             # Webchat UI (single-file HTML, dark theme)
tests/               # 120+ vitest tests
```

## How It Works

1. **Message arrives** (Telegram or webchat) → routed to agent core
2. **Context built** — identity files + relevant episodic memories + pattern-enhanced dispatch
3. **LLM called** — Anthropic API with tool definitions filtered by channel
4. **Tool loop** — agent executes tools, observes results, continues until done
5. **Response sent** — back to originating channel
6. **Post-task extraction** — patterns extracted from the conversation, confidence updated, knowledge graph enriched

The agent gets smarter over time because patterns from past work inform future dispatches. A bug fix today becomes a "check for this pattern" hint tomorrow.

## License

[MIT](LICENSE)
