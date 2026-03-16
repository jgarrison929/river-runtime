# river-runtime

Production-grade persistent runtime for autonomous coding agents.

> **Full 5-tier memory architecture spec →** [docs/architecture.md](docs/architecture.md)

## The Proof It Works

Powers a live production ERP that has shipped **382+ PRs**, passed **3,131 unit + 265 integration tests**, and maintains **134 frontend pages across 11 modules** — with zero human engineers writing code. The agent dispatches sub-agents, reviews their work, and deploys. This runtime is what makes that possible.

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
test/                # 120+ vitest tests
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

MIT
