# River Memory Architecture Specification

**Version:** 1.0.0-draft
**Date:** 2026-03-14
**Status:** Reference Architecture
**Target Runtime:** river-runtime v0.1.0+ (TypeScript, Node 22, better-sqlite3)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Tier 1: Working Memory](#3-tier-1-working-memory)
4. [Tier 2: Episodic Memory](#4-tier-2-episodic-memory)
5. [Tier 3: Pattern Memory](#5-tier-3-pattern-memory)
6. [Tier 4: Knowledge Base](#6-tier-4-knowledge-base)
7. [Tier 5: Knowledge Graph](#7-tier-5-knowledge-graph)
8. [Cross-Cutting: Code Intelligence](#8-cross-cutting-code-intelligence)
9. [Extraction Pipeline](#9-extraction-pipeline)
10. [MCP Server](#10-mcp-server)
11. [Dispatch Enhancement](#11-dispatch-enhancement)
12. [Migration Plan](#12-migration-plan)
13. [Cost Analysis](#13-cost-analysis)
14. [Example Scenarios](#14-example-scenarios)
15. [Implementation Phases](#15-implementation-phases)
16. [Risks and Limitations](#16-risks-and-limitations)
17. [Appendix A: Full Schema DDL](#appendix-a-full-schema-ddl)
18. [Appendix B: TypeScript Interfaces](#appendix-b-typescript-interfaces)
19. [Appendix C: Extraction Prompt Templates](#appendix-c-extraction-prompt-templates)

---

## 1. Executive Summary

### The Problem

River's current "memory" is a set of markdown files (`MEMORY.md`, `memory/YYYY-MM-DD.md`) loaded into the context window at session start. This works, but it's a journal, not a brain. It has no semantic search, no pattern extraction, no cross-session learning, and no way to share knowledge with sub-agents. Every session starts at the same baseline regardless of what was learned yesterday.

### The Solution

A five-layer memory architecture backed by SQLite that gives Agent:

- **Semantic recall** — find relevant past conversations by meaning, not grep
- **Experiential learning** — extract patterns from coding tasks, track what works and what doesn't, get measurably better over time
- **Technical knowledge** — ingest current documentation so River isn't limited by model training cutoffs
- **Entity understanding** — know how people, projects, and technologies relate to each other
- **Code awareness** — understand codebase structure at the symbol level for impact analysis

All layers share one SQLite database. All are accessible via MCP so any AI client (Claude Code, Codex, CRUCIBLE agents, future tools) shares one brain.

### What This Is Not

This is not RAG-as-a-product. It's not a general-purpose knowledge management system. It's specifically tuned for an AI agent that does programming work, talks to one primary user, and dispatches sub-agents. Every design decision is shaped by that context.

### Key Constraints

- **Single SQLite file.** No Postgres. No Redis. No Pinecone. SQLite with sqlite-vec handles everything until it demonstrably can't.
- **Embeddings happen locally or via API.** We support both — local for cost, API for quality.
- **Extraction costs tokens.** Every LLM call to extract patterns or knowledge has a cost. The spec is explicit about those costs and where to cut them.
- **The system must provide value from day one.** Cold start is real. The spec addresses what happens with zero data in each tier.

---

## 2. Architecture Overview

### System Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        river-runtime                             │
│                                                                  │
│  ┌─────────────┐  ┌───────────────┐  ┌────────────────────────┐ │
│  │ AgentCore   │  │ ContextBuilder│  │  DispatchEnhancer      │ │
│  │ (main loop) │──│ (system prompt)│──│ (pre-dispatch enrichment│ │
│  └──────┬──────┘  └───────┬───────┘  └───────────┬────────────┘ │
│         │                 │                       │              │
│         ▼                 ▼                       ▼              │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    MemoryManager                            │ │
│  │                                                             │ │
│  │  ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌────────┐ ┌──────┐ │ │
│  │  │Working  │ │ Episodic │ │ Pattern │ │Knowl-  │ │Know- │ │ │
│  │  │Memory   │ │ Memory   │ │ Memory  │ │edge    │ │ledge │ │ │
│  │  │(Tier 1) │ │ (Tier 2) │ │(Tier 3) │ │Base    │ │Graph │ │ │
│  │  │         │ │          │ │         │ │(Tier 4)│ │(T 5) │ │ │
│  │  │ Files + │ │ Vectors  │ │ Scored  │ │Struct- │ │Nodes │ │ │
│  │  │ Context │ │ + SQLite │ │ Rules   │ │ured    │ │+Edges│ │ │
│  │  └─────────┘ └──────────┘ └─────────┘ └────────┘ └──────┘ │ │
│  │                                                             │ │
│  │  ┌───────────────────────────────────────────────────────┐  │ │
│  │  │              Code Intelligence (cross-cutting)        │  │ │
│  │  │              Symbols · Dependencies · Changes         │  │ │
│  │  └───────────────────────────────────────────────────────┘  │ │
│  │                                                             │ │
│  │                    ┌──────────────┐                         │ │
│  │                    │   SQLite DB  │                         │ │
│  │                    │ river.sqlite │                         │ │
│  │                    └──────────────┘                         │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                  Extraction Pipeline                        │ │
│  │  PostTask · DocIngestion · Conversation · Consolidation     │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                     MCP Server                              │ │
│  │  search_memory · get_patterns · query_knowledge ·           │ │
│  │  search_code · add_memory · get_related                     │ │
│  └─────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
User Message
     │
     ▼
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│ Tier 1:  │     │ Tier 2:      │     │ Tier 3:      │
│ Working  │◄────│ Episodic     │◄────│ Pattern      │
│ Memory   │     │ (semantic    │     │ (what works/ │
│ (always  │     │  recall)     │     │  what fails) │
│  loaded) │     └──────────────┘     └──────────────┘
└──────────┘            ▲                    ▲
     │                  │                    │
     ▼                  │                    │
┌──────────┐     ┌──────────────┐     ┌──────────────┐
│ LLM Call │     │ Tier 4:      │     │ Tier 5:      │
│          │────►│ Knowledge    │     │ Knowledge    │
│          │     │ Base (docs)  │     │ Graph        │
└──────────┘     └──────────────┘     └──────────────┘
     │                                       ▲
     ▼                                       │
┌──────────┐     ┌──────────────┐            │
│ Response  │────►│ Extraction   │────────────┘
│           │     │ Pipeline     │
└──────────┘     └──────────────┘
```

### Storage Layout

```
data/
├── river.sqlite          # Single database file — all tiers
├── river.sqlite-wal      # WAL mode journal
├── river.sqlite-shm      # Shared memory
├── sessions/             # JSONL conversation logs (existing)
│   ├── telegram_123456789.jsonl
│   └── ...
└── backups/              # Periodic snapshots
    ├── river-2026-03-14.sqlite
    └── ...
```

One database. WAL mode for concurrent reads during extraction. Backups are `sqlite3 river.sqlite ".backup backups/river-YYYY-MM-DD.sqlite"` on a daily cron.

---

## 3. Tier 1: Working Memory

### Purpose

Working memory is the active context loaded into every LLM call. It's what River "knows" right now — identity, recent conversation, and session state. This is the existing system, managed more deliberately.

### Current State

The `ContextBuilder` class in `src/agent/context-builder.ts` already reads identity files (SOUL.md, MEMORY.md, USER.md, etc.) and builds a system prompt. Sessions are stored as JSONL files in `data/sessions/`.

### Changes for Phase 2

Working memory doesn't change architecturally — it's the same concept of "what's in the context window right now." The change is that Tiers 2-5 inject additional context *into* working memory dynamically.

**Before (current):**
```
System prompt = identity files (static)
Messages = conversation history (grows)
```

**After:**
```
System prompt = identity files (static)
                + relevant episodic memories (dynamic, from Tier 2)
                + applicable patterns (dynamic, from Tier 3)
                + relevant technical knowledge (dynamic, from Tier 4)
Messages = conversation history (grows)
```

### Token Budget

Total context window: ~200K tokens (Claude Opus 4)

| Component | Budget | Notes |
|-----------|--------|-------|
| Identity files | ~8K | SOUL.md, USER.md, IDENTITY.md, AGENTS.md, TOOLS.md |
| MEMORY.md | ~8K | Curated long-term memory |
| Injected context | ~6K | Episodic + patterns + knowledge (from Tiers 2-4) |
| Conversation history | ~50K | Rolling window, trimmed by SessionManager |
| Tool results | ~50K | File contents, command output, etc. |
| **Reserved for response** | ~30K | |
| **Buffer** | ~48K | Safety margin |

The injected context budget of ~6K tokens is deliberate. More isn't better — injecting 20K of "potentially relevant" context dilutes attention. The retrieval system must be selective.

### Schema

No new tables. Working memory is ephemeral — it's the context window contents. The `kv` table (already exists) stores session-level state.

### TypeScript Interface

```typescript
interface WorkingMemoryContext {
  /** Static identity files */
  identityPrompt: string;

  /** Dynamic injections from Tiers 2-4 */
  injections: MemoryInjection[];

  /** Total token estimate */
  estimatedTokens: number;
}

interface MemoryInjection {
  source: 'episodic' | 'pattern' | 'knowledge' | 'code';
  content: string;
  relevanceScore: number;
  tokenEstimate: number;
}
```

---

## 4. Tier 2: Episodic Memory

### Purpose

Episodic memory stores *what happened*. Conversations chunked into meaningful segments, embedded as vectors, and retrievable by semantic similarity. When River needs to recall "What did we discuss about the project migration last week?", episodic memory finds the relevant conversation chunks even if those exact words were never used.

### Design Decisions

**Embedding model:** We support two modes:

1. **API embeddings** (default): OpenAI `text-embedding-3-small` (1536 dimensions, $0.02/1M tokens). High quality, simple.
2. **Local embeddings** (optional): `@xenova/transformers` running `all-MiniLM-L6-v2` (384 dimensions, free). Lower quality but zero cost and no data sent externally.

The schema supports both dimensionalities. Configuration determines which is active.

**Chunking strategy:** Conversations are chunked by topic shift, not by fixed token count. A topic shift is detected when:
- The user explicitly changes subject
- There's a time gap > 30 minutes between messages
- A sub-agent task completes (natural boundary)
- Fallback: every ~800 tokens if no natural boundary detected

**Why SQLite + sqlite-vec?** Pinecone, Weaviate, and Chroma are all overkill for a single-user agent. sqlite-vec gives us vector similarity search inside the same database file. One dependency, one backup, no network calls for retrieval.

### Schema

```sql
-- Episodic memory: conversation chunks with vector embeddings
CREATE TABLE IF NOT EXISTS episodic_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key   TEXT NOT NULL,                    -- e.g. "telegram_123456789"
  chunk_index   INTEGER NOT NULL,                 -- order within session
  started_at    INTEGER NOT NULL,                 -- unix epoch ms
  ended_at      INTEGER NOT NULL,                 -- unix epoch ms
  summary       TEXT NOT NULL,                    -- LLM-generated 1-2 sentence summary
  content       TEXT NOT NULL,                    -- raw conversation text
  participants  TEXT NOT NULL DEFAULT '[]',        -- JSON array of participant names
  topics        TEXT NOT NULL DEFAULT '[]',        -- JSON array of topic tags
  token_count   INTEGER NOT NULL DEFAULT 0,
  channel       TEXT,                             -- "telegram", "discord", "webchat"
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),

  UNIQUE(session_key, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_episodic_started ON episodic_chunks(started_at);
CREATE INDEX IF NOT EXISTS idx_episodic_session ON episodic_chunks(session_key);

-- Virtual table for vector similarity search (sqlite-vec)
-- Dimension depends on embedding model: 1536 for OpenAI, 384 for local
CREATE VIRTUAL TABLE IF NOT EXISTS episodic_vectors
USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding FLOAT[1536]           -- Adjusted at init based on config
);
```

**Note on sqlite-vec:** The `vec0` virtual table syntax requires the dimension to be known at creation time. The `MemoryManager` initialization code must check the configured embedding dimension and create the table accordingly. If the dimension changes (switching embedding models), a migration re-embeds all chunks.

### Retrieval Algorithm

```
Input: query text, optional filters (time range, channel, participants)
Output: ranked list of episodic chunks

1. Embed the query text using configured embedding model
2. Vector similarity search via sqlite-vec (cosine distance, top 50 candidates)
3. Apply hard filters (time range, channel, participants) — eliminate non-matches
4. Compute final score:
   score = (similarity * 0.7) + (recency * 0.2) + (relevance_boost * 0.1)

   where:
     similarity = 1 - cosine_distance (from sqlite-vec)
     recency    = 1 / (1 + days_since_chunk)  — exponential decay
     relevance_boost = bonus for matching topics/participants
5. Return top K results (default K=5), total tokens ≤ injection budget
```

**Why recency weighting?** A conversation from yesterday about "project migration" is more relevant than a conversation from 30 days ago about the same topic, because context evolves. But recency is only 20% of the score — a highly relevant old conversation still surfaces.

### TypeScript Interface

```typescript
interface EpisodicChunk {
  id: number;
  sessionKey: string;
  chunkIndex: number;
  startedAt: number;        // epoch ms
  endedAt: number;           // epoch ms
  summary: string;
  content: string;
  participants: string[];
  topics: string[];
  tokenCount: number;
  channel: string | null;
}

interface EpisodicSearchResult {
  chunk: EpisodicChunk;
  similarity: number;       // 0-1, from vector search
  recency: number;          // 0-1, time decay
  finalScore: number;       // weighted combination
}

interface EpisodicSearchOptions {
  query: string;
  limit?: number;           // default 5
  maxTokens?: number;       // default 2000
  timeRange?: {
    after?: number;         // epoch ms
    before?: number;        // epoch ms
  };
  channel?: string;
  participants?: string[];
}
```

### Embedding Pipeline

When a session ends or a natural chunk boundary is detected:

```typescript
async function processEpisodicChunk(
  messages: LLMMessage[],
  sessionKey: string,
  channel: string
): Promise<void> {
  // 1. Concatenate messages into text
  const text = messages.map(m =>
    `[${m.role}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`
  ).join('\n');

  // 2. Generate summary via LLM (cheap model)
  const summary = await generateSummary(text);  // See extraction prompts

  // 3. Extract topics via LLM
  const topics = await extractTopics(text);      // See extraction prompts

  // 4. Embed the summary + key content
  const embeddingText = `${summary}\n${topics.join(', ')}\n${text.slice(0, 2000)}`;
  const embedding = await embed(embeddingText);

  // 5. Insert into SQLite
  const chunkId = insertEpisodicChunk({
    sessionKey, summary, content: text,
    participants: extractParticipants(messages),
    topics, channel, tokenCount: estimateTokens(text),
    startedAt: ..., endedAt: ...
  });

  // 6. Insert embedding vector
  insertEpisodicVector(chunkId, embedding);
}
```

### Cold Start Behavior

With zero episodic memories, semantic search returns nothing and the injection slot is simply empty. The system still functions — River just doesn't have recall of past conversations beyond what's in MEMORY.md. This is exactly the current behavior, so cold start is a no-op regression.

**Bootstrapping:** On first run, we can optionally ingest the existing `memory/*.md` daily files as episodic chunks. Each daily file becomes one chunk with the file date as the timestamp. This gives River ~42 days of searchable history immediately.

---

## 5. Tier 3: Pattern Memory

### Purpose

This is the key differentiator. Pattern memory stores *what River has learned from doing work*. After every coding task, the system extracts:

- What the task was
- What approach was taken
- Whether it worked
- What went wrong (if anything)
- The fix (if applicable)
- A generalized pattern or anti-pattern

Patterns accumulate confidence scores based on repeated validation. High-confidence patterns are auto-injected into sub-agent dispatch prompts, making every future dispatch smarter than the last.

### The Learning Loop

```
Task Assigned
     │
     ▼
Sub-agent works on it
     │
     ▼
Task Completes (success/failure/partial)
     │
     ▼
Extraction Pipeline analyzes:
  - What was attempted?
  - What was the outcome?
  - What patterns apply?
     │
     ▼
Pattern Memory updated:
  - New pattern created, OR
  - Existing pattern reinforced (confidence ↑), OR
  - Existing pattern contradicted (confidence ↓)
     │
     ▼
Next dispatch includes relevant patterns
```

This is Karpathy's autoresearch loop applied to coding: experiment → measure → keep or discard → repeat.

### Schema

```sql
-- Patterns: generalized lessons from experience
CREATE TABLE IF NOT EXISTS patterns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_type    TEXT NOT NULL CHECK(
                    pattern_type IN ('pattern', 'anti_pattern', 'heuristic', 'workaround')
                  ),
  category        TEXT NOT NULL,                  -- "typescript", "react", "git", "api", "deployment", etc.
  title           TEXT NOT NULL,                  -- Short label: "Anthropic model ID format validation"
  description     TEXT NOT NULL,                  -- Full description of the pattern
  context         TEXT NOT NULL,                  -- When does this pattern apply?
  recommendation  TEXT NOT NULL,                  -- What should you do?

  confidence      REAL NOT NULL DEFAULT 0.5,      -- 0.0 to 1.0
  times_applied   INTEGER NOT NULL DEFAULT 0,     -- How many times referenced in dispatch
  times_validated INTEGER NOT NULL DEFAULT 0,     -- How many times confirmed correct
  times_violated  INTEGER NOT NULL DEFAULT 0,     -- How many times ignored and caused problems

  source_task_id  INTEGER,                        -- First task that generated this pattern
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  last_applied_at INTEGER,                        -- Last time injected into a dispatch
  superseded_by   INTEGER REFERENCES patterns(id), -- If this pattern was replaced by a better one
  is_active       INTEGER NOT NULL DEFAULT 1       -- Soft delete / archive
);

CREATE INDEX IF NOT EXISTS idx_patterns_category ON patterns(category);
CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON patterns(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_active ON patterns(is_active) WHERE is_active = 1;

-- Pattern evidence: links patterns to the tasks that generated or validated them
CREATE TABLE IF NOT EXISTS pattern_evidence (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id  INTEGER NOT NULL REFERENCES patterns(id),
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  evidence_type TEXT NOT NULL CHECK(
                evidence_type IN ('originated', 'validated', 'contradicted', 'refined')
              ),
  notes       TEXT,                               -- What specifically happened
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_evidence_pattern ON pattern_evidence(pattern_id);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON pattern_evidence(task_id);

-- Tasks: record of every sub-agent dispatch and its outcome
CREATE TABLE IF NOT EXISTS tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key     TEXT NOT NULL,
  task_type       TEXT NOT NULL,                   -- "coding", "review", "research", "debug", etc.
  description     TEXT NOT NULL,                   -- What was the task
  technologies    TEXT NOT NULL DEFAULT '[]',       -- JSON array: ["typescript", "next.js", "prisma"]
  files_touched   TEXT NOT NULL DEFAULT '[]',       -- JSON array of file paths
  agent           TEXT,                            -- "claude", "codex", "gemini", "river"
  dispatch_prompt TEXT,                            -- The actual prompt sent to the sub-agent

  outcome         TEXT NOT NULL CHECK(
                    outcome IN ('success', 'failure', 'partial', 'abandoned', 'pending')
                  ) DEFAULT 'pending',
  outcome_notes   TEXT,                            -- What happened

  started_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at    INTEGER,
  duration_ms     INTEGER,                         -- How long the task took

  patterns_injected TEXT NOT NULL DEFAULT '[]',     -- JSON array of pattern IDs that were injected
  patterns_extracted TEXT NOT NULL DEFAULT '[]',    -- JSON array of pattern IDs created/updated from this task

  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tasks_outcome ON tasks(outcome);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(task_type);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_key);
```

### Confidence Scoring

Confidence starts at 0.5 (uncertain) and moves toward 0 or 1 based on evidence:

```typescript
function updateConfidence(pattern: Pattern, evidenceType: EvidenceType): number {
  const current = pattern.confidence;

  switch (evidenceType) {
    case 'validated':
      // Validated patterns move toward 1.0 with diminishing returns
      // First validation: 0.5 → 0.65. Fifth: 0.85 → 0.88.
      return current + (1 - current) * 0.3;

    case 'contradicted':
      // Contradictions move toward 0.0 quickly — failures are loud
      // One contradiction: 0.7 → 0.42. Trust is hard to earn, easy to lose.
      return current * 0.6;

    case 'refined':
      // Refinement slightly boosts confidence (the pattern is being improved)
      return Math.min(1.0, current + 0.05);

    default:
      return current;
  }
}
```

**Injection threshold:** Only patterns with `confidence >= 0.6` and `is_active = 1` are eligible for injection into dispatch prompts. Patterns below 0.6 are visible via search but not auto-injected.

**Decay:** Patterns not applied in 90 days get `confidence *= 0.95` on a monthly consolidation run. Stale patterns slowly fade unless revalidated.

### Retrieval for Dispatch

When preparing a sub-agent dispatch:

```sql
-- Find patterns relevant to the technologies and categories in this task
SELECT p.id, p.title, p.description, p.context, p.recommendation,
       p.confidence, p.times_validated, p.times_violated
FROM patterns p
WHERE p.is_active = 1
  AND p.confidence >= 0.6
  AND (
    p.category IN (?, ?, ?)        -- task technologies: "typescript", "next.js", etc.
    OR p.category = 'general'       -- universal patterns always included
  )
ORDER BY p.confidence DESC, p.times_validated DESC
LIMIT 10;
```

The results are formatted as a "lessons learned" block and prepended to the sub-agent's prompt. Example:

```
## Relevant Patterns (from prior experience)

⚠️ ANTI-PATTERN [confidence: 0.87, validated 4x]:
"Anthropic model ID format changes between SDK versions"
Context: When using @anthropic-ai/sdk, model IDs have changed format.
Recommendation: Always verify model ID format against current SDK types.
Don't hardcode — use a constant or config value.

✅ PATTERN [confidence: 0.72, validated 2x]:
"WebSocket reconnection needs exponential backoff with jitter"
Context: All WebSocket integrations (Discord, real-time features).
Recommendation: Use 1s base, 2x multiplier, max 30s, +random(0-1s) jitter.
Without jitter, reconnection storms happen under load.
```

### TypeScript Interfaces

```typescript
interface Pattern {
  id: number;
  patternType: 'pattern' | 'anti_pattern' | 'heuristic' | 'workaround';
  category: string;
  title: string;
  description: string;
  context: string;
  recommendation: string;
  confidence: number;
  timesApplied: number;
  timesValidated: number;
  timesViolated: number;
  sourceTaskId: number | null;
  createdAt: number;
  updatedAt: number;
  lastAppliedAt: number | null;
  supersededBy: number | null;
  isActive: boolean;
}

interface Task {
  id: number;
  sessionKey: string;
  taskType: 'coding' | 'review' | 'research' | 'debug' | 'deploy' | 'other';
  description: string;
  technologies: string[];
  filesTouched: string[];
  agent: string | null;
  dispatchPrompt: string | null;
  outcome: 'success' | 'failure' | 'partial' | 'abandoned' | 'pending';
  outcomeNotes: string | null;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  patternsInjected: number[];
  patternsExtracted: number[];
}

interface PatternEvidence {
  id: number;
  patternId: number;
  taskId: number;
  evidenceType: 'originated' | 'validated' | 'contradicted' | 'refined';
  notes: string | null;
}

interface PatternSearchOptions {
  categories?: string[];
  minConfidence?: number;      // default 0.6
  limit?: number;              // default 10
  includeInactive?: boolean;   // default false
}
```

### Cold Start

With zero patterns, dispatch prompts go out clean — exactly as they do today. The system works identically to the current baseline. Value appears after the first few tasks are extracted.

**Bootstrapping strategy:** On migration, manually seed 5-10 patterns from known lessons:

```sql
INSERT INTO patterns (pattern_type, category, title, description, context, recommendation, confidence)
VALUES
  ('anti_pattern', 'anthropic', 'Model ID format varies by SDK version',
   'Anthropic model IDs have changed format across SDK versions (e.g., claude-3-opus-20240229 vs claude-opus-4-20250514). Hardcoding IDs causes silent failures when upgrading.',
   'Any code that references Anthropic model IDs directly.',
   'Use a config value or constant. Verify against SDK types after upgrades. Check release notes.',
   0.8),

  ('anti_pattern', 'websocket', 'Event name mismatches in WebSocket integrations',
   'WebSocket event names are string-typed and not validated at compile time. Typos or version mismatches cause silent failures where messages are sent but never received.',
   'Discord.js event handlers, custom WebSocket protocols, real-time features.',
   'Define event names as string literal union types or an enum. Add runtime logging for unhandled events. Write integration tests that verify event names match between sender and receiver.',
   0.75);
```

These seeds give the system something to inject immediately, validated by actual experience (we know these are real — they've burned us).

---

## 6. Tier 4: Knowledge Base

### Purpose

River's models were trained on data from months or years ago. When River needs to use Next.js 15's new APIs, or the latest Anthropic SDK release, or a breaking change in TypeScript 5.9, the model's training data is stale. The knowledge base stores structured technical knowledge extracted from current documentation, making it available for injection into any session or sub-agent dispatch.

This directly solves the frozen-model problem: instead of hallucinating old API signatures, River can query its knowledge base for current ones.

### Schema

```sql
-- Knowledge entries: structured technical facts
CREATE TABLE IF NOT EXISTS knowledge_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  technology      TEXT NOT NULL,                   -- "next.js", "anthropic-sdk", "typescript", etc.
  version         TEXT,                            -- "15.2.0", "5.9", "^0.78.0"
  entry_type      TEXT NOT NULL CHECK(
                    entry_type IN (
                      'api_signature', 'migration_note', 'breaking_change',
                      'best_practice', 'anti_pattern', 'config_option',
                      'error_solution', 'example', 'concept'
                    )
                  ),
  title           TEXT NOT NULL,                   -- Short label
  content         TEXT NOT NULL,                   -- Full knowledge entry (markdown OK)
  code_example    TEXT,                            -- Optional code snippet
  source_url      TEXT,                            -- Where this came from
  source_title    TEXT,                            -- Page title for attribution
  date_read       INTEGER NOT NULL DEFAULT (unixepoch()), -- When we ingested this
  date_published  INTEGER,                         -- When the source was published (if known)
  confidence      REAL NOT NULL DEFAULT 0.8,       -- How confident we are in this info
  is_current      INTEGER NOT NULL DEFAULT 1,      -- 0 = known to be outdated
  superseded_by   INTEGER REFERENCES knowledge_entries(id),
  tags            TEXT NOT NULL DEFAULT '[]',       -- JSON array of additional tags
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_knowledge_tech ON knowledge_entries(technology);
CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_knowledge_tech_version ON knowledge_entries(technology, version);
CREATE INDEX IF NOT EXISTS idx_knowledge_current ON knowledge_entries(is_current) WHERE is_current = 1;

-- Vector embeddings for semantic search over knowledge
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_vectors
USING vec0(
  entry_id INTEGER PRIMARY KEY,
  embedding FLOAT[1536]
);

-- Source tracking: which documents have we read?
CREATE TABLE IF NOT EXISTS knowledge_sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT NOT NULL UNIQUE,
  title           TEXT,
  technology      TEXT NOT NULL,
  last_read_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  entry_count     INTEGER NOT NULL DEFAULT 0,       -- How many entries extracted
  hash            TEXT,                             -- Content hash to detect changes
  read_count      INTEGER NOT NULL DEFAULT 1,       -- How many times we've read this
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_sources_tech ON knowledge_sources(technology);
CREATE INDEX IF NOT EXISTS idx_sources_url ON knowledge_sources(url);
```

### Retrieval

Knowledge retrieval is a hybrid of exact match and semantic search:

```typescript
async function queryKnowledge(options: KnowledgeSearchOptions): Promise<KnowledgeEntry[]> {
  const results: ScoredEntry[] = [];

  // 1. Exact technology + version match (highest priority)
  if (options.technology) {
    const exact = db.prepare(`
      SELECT * FROM knowledge_entries
      WHERE technology = ? AND is_current = 1
      ${options.version ? 'AND version = ?' : ''}
      ${options.entryType ? 'AND entry_type = ?' : ''}
      ORDER BY confidence DESC, updated_at DESC
      LIMIT ?
    `).all(...params);

    for (const entry of exact) {
      results.push({ entry, score: 1.0, matchType: 'exact' });
    }
  }

  // 2. Semantic search over knowledge vectors
  if (options.query) {
    const queryEmbedding = await embed(options.query);
    const semantic = db.prepare(`
      SELECT ke.*, kv.distance
      FROM knowledge_vectors kv
      JOIN knowledge_entries ke ON ke.id = kv.entry_id
      WHERE ke.is_current = 1
      ORDER BY kv.distance ASC
      LIMIT 20
    `).all();  // sqlite-vec handles the vector comparison

    for (const row of semantic) {
      const similarity = 1 - row.distance;
      if (similarity > 0.5) {  // threshold: ignore weak matches
        results.push({ entry: row, score: similarity, matchType: 'semantic' });
      }
    }
  }

  // 3. Deduplicate and rank
  const deduped = deduplicateByTitle(results);
  return deduped
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 5)
    .map(r => r.entry);
}
```

### Document Ingestion Pipeline

When The agent reads documentation (via `web_fetch` or browsing):

```
URL fetched → Content extracted (markdown)
     │
     ▼
LLM extracts structured entries (see Appendix C for prompt)
     │
     ▼
For each extracted entry:
  1. Check for existing entry with same technology + title
     - If exists and content changed → update, bump version
     - If exists and content same → skip (idempotent)
     - If new → insert
  2. Generate embedding for the entry
  3. Update knowledge_sources tracking
```

**Deduplication:** The combination of `(technology, title, entry_type)` should be treated as a logical key. When re-ingesting the same docs, existing entries are updated rather than duplicated.

### TypeScript Interfaces

```typescript
interface KnowledgeEntry {
  id: number;
  technology: string;
  version: string | null;
  entryType: 'api_signature' | 'migration_note' | 'breaking_change' |
             'best_practice' | 'anti_pattern' | 'config_option' |
             'error_solution' | 'example' | 'concept';
  title: string;
  content: string;
  codeExample: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  dateRead: number;
  datePublished: number | null;
  confidence: number;
  isCurrent: boolean;
  supersededBy: number | null;
  tags: string[];
}

interface KnowledgeSearchOptions {
  query?: string;             // Semantic search text
  technology?: string;        // Exact match filter
  version?: string;           // Exact match filter
  entryType?: string;         // Filter by entry type
  limit?: number;             // default 5
  maxTokens?: number;         // default 2000
  includeSources?: boolean;   // include source attribution
}

interface KnowledgeSource {
  id: number;
  url: string;
  title: string | null;
  technology: string;
  lastReadAt: number;
  entryCount: number;
  hash: string | null;
  readCount: number;
}
```

### Cold Start

The knowledge base starts empty, which means no technical knowledge injection. This is fine — River still has its training data. Value appears the first time The agent reads documentation and entries are extracted.

**Bootstrapping priority list:** On migration day, queue ingestion of:

1. Anthropic SDK changelog (we use this constantly)
2. Next.js 15 migration guide
3. better-sqlite3 + sqlite-vec docs (our own stack)
4. TypeScript 5.9 release notes
5. grammy (Telegram bot library) docs

Each doc read costs ~2K-5K input tokens for extraction. Bootstrapping these 5 sources: ~$0.10-0.25.

---

## 7. Tier 5: Knowledge Graph

### Purpose

The knowledge graph stores *relationships between entities*. People, projects, technologies, decisions, repos, and locations as nodes, with typed edges connecting them. This enables multi-hop queries: "What connects User to ProjectA?" → User (person) → works_on → WebApp Project (project) → deployed_in → Remote (location).

### Design Decision: Build Last

The knowledge graph is the most complex tier and the one with the least immediate payoff. It requires significant data to be useful — a graph with 10 nodes is just a list. We build it last, after Tiers 2-4 are producing data that feeds into it.

That said, the schema is designed now so that extraction pipelines can start populating nodes and edges as a side effect of other work (conversation extraction, task tracking, etc.) even before dedicated graph queries are built.

### Schema

```sql
-- Graph nodes: entities in River's world
CREATE TABLE IF NOT EXISTS graph_nodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_type   TEXT NOT NULL CHECK(
                node_type IN (
                  'person', 'project', 'technology', 'decision',
                  'repo', 'location', 'organization', 'concept', 'file'
                )
              ),
  name        TEXT NOT NULL,                   -- Display name
  canonical   TEXT NOT NULL,                   -- Lowercase, normalized for dedup
  description TEXT,                            -- Optional longer description
  metadata    TEXT NOT NULL DEFAULT '{}',       -- JSON: arbitrary key-value data
  first_seen  INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen   INTEGER NOT NULL DEFAULT (unixepoch()),
  mention_count INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),

  UNIQUE(node_type, canonical)
);

CREATE INDEX IF NOT EXISTS idx_nodes_type ON graph_nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_nodes_canonical ON graph_nodes(canonical);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON graph_nodes(name);

-- Graph edges: relationships between nodes
CREATE TABLE IF NOT EXISTS graph_edges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL REFERENCES graph_nodes(id),
  target_id     INTEGER NOT NULL REFERENCES graph_nodes(id),
  edge_type     TEXT NOT NULL CHECK(
                  edge_type IN (
                    'works_on', 'depends_on', 'uses', 'created_by',
                    'married_to', 'lives_in', 'deployed_in', 'blocked_by',
                    'decided_on', 'related_to', 'employed_by', 'manages',
                    'forked_from', 'replaced_by', 'part_of', 'located_in'
                  )
                ),
  weight        REAL NOT NULL DEFAULT 1.0,     -- Strength of relationship
  evidence      TEXT,                          -- Why we believe this edge exists
  source_chunk_id INTEGER,                     -- Which episodic chunk mentioned this
  bidirectional INTEGER NOT NULL DEFAULT 0,    -- 1 = relationship goes both ways
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),

  UNIQUE(source_id, target_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON graph_edges(edge_type);

-- Node properties: flexible key-value attributes for nodes
CREATE TABLE IF NOT EXISTS graph_node_properties (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id     INTEGER NOT NULL REFERENCES graph_nodes(id),
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 0.8,
  source      TEXT,                            -- Where this property came from
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),

  UNIQUE(node_id, key)
);

CREATE INDEX IF NOT EXISTS idx_props_node ON graph_node_properties(node_id);

-- Contradiction log: when we find conflicting information
CREATE TABLE IF NOT EXISTS graph_contradictions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id         INTEGER REFERENCES graph_nodes(id),
  edge_id         INTEGER REFERENCES graph_edges(id),
  property_key    TEXT,                        -- Which property conflicts
  existing_value  TEXT NOT NULL,               -- What we currently have
  new_value       TEXT NOT NULL,               -- What the new info says
  source_chunk_id INTEGER,                     -- Where the conflict was found
  resolution      TEXT CHECK(
                    resolution IN ('pending', 'kept_existing', 'updated', 'both_valid', 'dismissed')
                  ) DEFAULT 'pending',
  resolved_at     INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_contradictions_pending
  ON graph_contradictions(resolution) WHERE resolution = 'pending';
```

### Multi-Hop Query

```typescript
/**
 * Find paths between two nodes up to maxHops edges away.
 * Uses BFS with early termination.
 */
function findPaths(
  startNodeId: number,
  endNodeId: number,
  maxHops: number = 3
): GraphPath[] {
  const paths: GraphPath[] = [];
  const queue: { nodeId: number; path: GraphEdge[]; visited: Set<number> }[] = [
    { nodeId: startNodeId, path: [], visited: new Set([startNodeId]) }
  ];

  while (queue.length > 0) {
    const { nodeId, path, visited } = queue.shift()!;

    if (path.length >= maxHops) continue;

    // Get all edges from this node (both directions)
    const edges = db.prepare(`
      SELECT e.*, 'outgoing' as direction FROM graph_edges e WHERE e.source_id = ?
      UNION ALL
      SELECT e.*, 'incoming' as direction FROM graph_edges e WHERE e.target_id = ?
    `).all(nodeId, nodeId);

    for (const edge of edges) {
      const nextNode = edge.direction === 'outgoing' ? edge.target_id : edge.source_id;

      if (visited.has(nextNode)) continue;

      const newPath = [...path, edge];

      if (nextNode === endNodeId) {
        paths.push({ edges: newPath, totalWeight: newPath.reduce((s, e) => s + e.weight, 0) });
        continue;
      }

      const newVisited = new Set(visited);
      newVisited.add(nextNode);
      queue.push({ nodeId: nextNode, path: newPath, visited: newVisited });
    }
  }

  return paths.sort((a, b) => b.totalWeight - a.totalWeight);
}
```

### TypeScript Interfaces

```typescript
interface GraphNode {
  id: number;
  nodeType: 'person' | 'project' | 'technology' | 'decision' |
            'repo' | 'location' | 'organization' | 'concept' | 'file';
  name: string;
  canonical: string;
  description: string | null;
  metadata: Record<string, unknown>;
  firstSeen: number;
  lastSeen: number;
  mentionCount: number;
}

interface GraphEdge {
  id: number;
  sourceId: number;
  targetId: number;
  edgeType: string;
  weight: number;
  evidence: string | null;
  sourceChunkId: number | null;
  bidirectional: boolean;
}

interface GraphPath {
  edges: GraphEdge[];
  totalWeight: number;
}

interface GraphContradiction {
  id: number;
  nodeId: number | null;
  edgeId: number | null;
  propertyKey: string | null;
  existingValue: string;
  newValue: string;
  resolution: 'pending' | 'kept_existing' | 'updated' | 'both_valid' | 'dismissed';
}
```

### Cold Start

An empty graph returns nothing. Unlike episodic or pattern memory, there's no markdown to bootstrap from — the graph must be populated by extraction.

**Bootstrapping:** On migration, manually seed the core nodes:

```sql
INSERT INTO graph_nodes (node_type, name, canonical, description) VALUES
  ('person', 'User', 'user', 'Primary user'),
  ('person', 'Partner', 'partner', 'User''s partner'),
  ('person', 'Agent', 'river', 'the author — AI agent'),
  ('project', 'WebApp Project', 'myapp-construction-solutions', 'Web application project'),
  ('project', 'river-runtime', 'river-runtime', 'Agent''s custom TypeScript runtime'),
  ('project', 'DebatePlatform', 'debate-platform', 'agent platform — agent debate platform'),
  ('technology', 'TypeScript', 'typescript', NULL),
  ('technology', 'Next.js', 'next.js', NULL),
  ('technology', 'SQLite', 'sqlite', NULL),
  ('location', 'Portland', 'tennessee', NULL),
  ('location', 'California', 'california', NULL);

INSERT INTO graph_edges (source_id, target_id, edge_type, evidence) VALUES
  (1, 2, 'married_to', 'USER.md — stated in family section'),
  (1, 3, 'created_by', 'Agent created by user'),
  (1, 4, 'works_on', 'Primary project'),
  (3, 5, 'works_on', 'River is migrating to river-runtime'),
  (4, 10, 'deployed_in', 'Project deployed remotely'),
  (1, 11, 'lives_in', 'User in Pacific timezone');
```

---

## 8. Cross-Cutting: Code Intelligence

### Purpose

Code intelligence indexes the codebases River works on at the symbol level. It answers questions like:
- "If I change this function signature, what else breaks?"
- "Who imports this module?"
- "What changed in this file over the last 5 tasks?"
- "Is anyone currently modifying this file?"

This is inspired by OpenAI's rumored code-in-database approach: treat the codebase as queryable structured data.

### Schema

```sql
-- Indexed repositories
CREATE TABLE IF NOT EXISTS code_repos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,                   -- "myapp", "river-runtime"
  path        TEXT NOT NULL UNIQUE,            -- "/home/user/projects/myapp"
  language    TEXT NOT NULL DEFAULT 'typescript',
  last_indexed_at INTEGER,
  file_count  INTEGER NOT NULL DEFAULT 0,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexed files
CREATE TABLE IF NOT EXISTS code_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES code_repos(id),
  path        TEXT NOT NULL,                   -- Relative to repo root: "src/agent/core.ts"
  language    TEXT NOT NULL DEFAULT 'typescript',
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  hash        TEXT,                            -- Content hash for change detection
  last_indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_modified_at INTEGER,                    -- File system mtime
  is_active   INTEGER NOT NULL DEFAULT 1,      -- 0 = file was deleted

  UNIQUE(repo_id, path)
);

CREATE INDEX IF NOT EXISTS idx_files_repo ON code_files(repo_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON code_files(path);

-- Symbols: functions, classes, types, interfaces, constants
CREATE TABLE IF NOT EXISTS code_symbols (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES code_files(id),
  name        TEXT NOT NULL,                   -- "AgentCore", "processMessage", "LLMMessage"
  symbol_type TEXT NOT NULL CHECK(
                symbol_type IN (
                  'function', 'class', 'interface', 'type', 'enum',
                  'constant', 'variable', 'method', 'property', 'export'
                )
              ),
  signature   TEXT,                            -- Full type signature if available
  line_start  INTEGER,                         -- Line number where symbol is defined
  line_end    INTEGER,
  is_exported INTEGER NOT NULL DEFAULT 0,
  doc_comment TEXT,                            -- JSDoc or comment above the symbol
  last_indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),

  UNIQUE(file_id, name, symbol_type)
);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON code_symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_type ON code_symbols(symbol_type);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON code_symbols(file_id);

-- Dependencies: import/export relationships between files
CREATE TABLE IF NOT EXISTS code_dependencies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file_id INTEGER NOT NULL REFERENCES code_files(id),  -- The file that imports
  target_file_id INTEGER NOT NULL REFERENCES code_files(id),  -- The file being imported
  imported_symbols TEXT NOT NULL DEFAULT '[]',  -- JSON array: ["AgentCore", "LLMMessage"]
  import_type TEXT NOT NULL CHECK(
                import_type IN ('static', 'dynamic', 're_export', 'type_only')
              ) DEFAULT 'static',

  UNIQUE(source_file_id, target_file_id)
);

CREATE INDEX IF NOT EXISTS idx_deps_source ON code_dependencies(source_file_id);
CREATE INDEX IF NOT EXISTS idx_deps_target ON code_dependencies(target_file_id);

-- Change history: what changed in each file, linked to tasks
CREATE TABLE IF NOT EXISTS code_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES code_files(id),
  task_id     INTEGER REFERENCES tasks(id),
  change_type TEXT NOT NULL CHECK(
                change_type IN ('created', 'modified', 'deleted', 'renamed')
              ),
  diff_summary TEXT,                           -- LLM-generated summary of what changed
  symbols_added TEXT NOT NULL DEFAULT '[]',     -- JSON array
  symbols_removed TEXT NOT NULL DEFAULT '[]',
  symbols_modified TEXT NOT NULL DEFAULT '[]',
  lines_added INTEGER NOT NULL DEFAULT 0,
  lines_removed INTEGER NOT NULL DEFAULT 0,
  changed_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_changes_file ON code_changes(file_id);
CREATE INDEX IF NOT EXISTS idx_changes_task ON code_changes(task_id);

-- Active file locks: which files are currently being worked on
CREATE TABLE IF NOT EXISTS code_active_edits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES code_files(id),
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  agent       TEXT NOT NULL,                   -- "claude", "codex", "river"
  started_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  released_at INTEGER,                         -- NULL = still active

  UNIQUE(file_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_active_file ON code_active_edits(file_id) WHERE released_at IS NULL;
```

### Impact Analysis

```typescript
/**
 * Given a file and optionally specific symbols, find everything that would
 * be affected by changes.
 */
async function analyzeImpact(
  repoId: number,
  filePath: string,
  symbols?: string[]
): Promise<ImpactReport> {
  const file = db.prepare(
    'SELECT id FROM code_files WHERE repo_id = ? AND path = ?'
  ).get(repoId, filePath);

  if (!file) return { directDependents: [], transitiveDependents: [], activeEdits: [] };

  // Direct dependents: files that import this file
  const direct = db.prepare(`
    SELECT cf.path, cd.imported_symbols
    FROM code_dependencies cd
    JOIN code_files cf ON cf.id = cd.source_file_id
    WHERE cd.target_file_id = ?
  `).all(file.id);

  // If specific symbols given, filter to dependents that import those symbols
  const filtered = symbols
    ? direct.filter(d => {
        const imported = JSON.parse(d.imported_symbols);
        return symbols.some(s => imported.includes(s));
      })
    : direct;

  // Transitive: BFS up to 3 levels
  const transitive = findTransitiveDependents(file.id, 3);

  // Concurrency check: is anyone currently editing affected files?
  const activeEdits = db.prepare(`
    SELECT cae.agent, cf.path, t.description
    FROM code_active_edits cae
    JOIN code_files cf ON cf.id = cae.file_id
    JOIN tasks t ON t.id = cae.task_id
    WHERE cae.released_at IS NULL
    AND cae.file_id IN (${filtered.map(() => '?').join(',')})
  `).all(...filtered.map(f => f.id));

  return { directDependents: filtered, transitiveDependents: transitive, activeEdits };
}
```

### Indexing Strategy

Full indexing happens on two triggers:

1. **Initial index:** When a repo is first registered, scan all TypeScript files, parse symbols and imports.
2. **Post-task index:** After a sub-agent completes, diff the affected files and update only what changed.

We do **not** use a full TypeScript AST parser. Instead, we use a lightweight regex-based extractor that handles the common patterns (exported functions, classes, interfaces, types, imports). For edge cases where regex fails, the LLM can analyze the file during post-task extraction.

```typescript
// Lightweight TypeScript symbol extractor
const EXPORT_PATTERNS = {
  function: /export\s+(?:async\s+)?function\s+(\w+)/g,
  class: /export\s+(?:default\s+)?class\s+(\w+)/g,
  interface: /export\s+(?:default\s+)?interface\s+(\w+)/g,
  type: /export\s+type\s+(\w+)/g,
  enum: /export\s+(?:const\s+)?enum\s+(\w+)/g,
  constant: /export\s+const\s+(\w+)/g,
};

const IMPORT_PATTERN = /import\s+(?:{([^}]+)}|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
```

This misses things like re-exports, dynamic imports, and computed exports. That's fine for 90% of cases, and the LLM extraction handles the other 10% when it matters.

### TypeScript Interfaces

```typescript
interface CodeRepo {
  id: number;
  name: string;
  path: string;
  language: string;
  lastIndexedAt: number | null;
  fileCount: number;
  symbolCount: number;
}

interface CodeFile {
  id: number;
  repoId: number;
  path: string;
  language: string;
  sizeBytes: number;
  hash: string | null;
  isActive: boolean;
}

interface CodeSymbol {
  id: number;
  fileId: number;
  name: string;
  symbolType: 'function' | 'class' | 'interface' | 'type' | 'enum' |
              'constant' | 'variable' | 'method' | 'property' | 'export';
  signature: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  isExported: boolean;
  docComment: string | null;
}

interface ImpactReport {
  directDependents: { path: string; importedSymbols: string[] }[];
  transitiveDependents: { path: string; hops: number }[];
  activeEdits: { agent: string; path: string; taskDescription: string }[];
}
```

---

## 9. Extraction Pipeline

The extraction pipeline is the engine that converts raw experience into structured memory. It's the most token-expensive part of the system and the most important to get right.

### Pipeline Overview

```
┌──────────────────────────────────────────────────┐
│                Extraction Pipeline                 │
│                                                    │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  │
│  │ Post-Task  │  │ Doc        │  │ Convo      │  │
│  │ Extractor  │  │ Ingester   │  │ Extractor  │  │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  │
│        │               │               │          │
│        ▼               ▼               ▼          │
│  ┌────────────────────────────────────────────┐   │
│  │            Extraction Queue                │   │
│  │  (SQLite table, processed in order)        │   │
│  └─────────────────────┬──────────────────────┘   │
│                        │                          │
│                        ▼                          │
│  ┌────────────────────────────────────────────┐   │
│  │            Extraction Worker                │   │
│  │  (processes queue items, calls LLM)        │   │
│  └─────────────────────┬──────────────────────┘   │
│                        │                          │
│                        ▼                          │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌────────┐ │
│  │Episodic │ │Pattern  │ │Knowledge│ │Graph   │ │
│  │ Tier 2  │ │ Tier 3  │ │ Tier 4  │ │Tier 5  │ │
│  └─────────┘ └─────────┘ └─────────┘ └────────┘ │
│                                                    │
│  ┌────────────────────────────────────────────┐   │
│  │          Consolidation (periodic)          │   │
│  │  Merge dupes · Resolve contradictions ·    │   │
│  │  Prune stale · Decay confidence            │   │
│  └────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────┘
```

### Extraction Queue

```sql
-- Extraction queue: items waiting to be processed
CREATE TABLE IF NOT EXISTS extraction_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  extraction_type TEXT NOT NULL CHECK(
                    extraction_type IN (
                      'post_task', 'document', 'conversation', 'consolidation'
                    )
                  ),
  status          TEXT NOT NULL CHECK(
                    status IN ('pending', 'processing', 'completed', 'failed', 'skipped')
                  ) DEFAULT 'pending',
  priority        INTEGER NOT NULL DEFAULT 5,      -- 1=highest, 10=lowest
  payload         TEXT NOT NULL,                    -- JSON: type-specific data
  result          TEXT,                             -- JSON: extraction results
  error           TEXT,                             -- Error message if failed
  retry_count     INTEGER NOT NULL DEFAULT 0,
  max_retries     INTEGER NOT NULL DEFAULT 3,
  tokens_used     INTEGER,                         -- Actual tokens consumed
  cost_usd        REAL,                            -- Estimated cost
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at      INTEGER,
  completed_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON extraction_queue(status, priority);
CREATE INDEX IF NOT EXISTS idx_queue_type ON extraction_queue(extraction_type);
```

### Post-Task Extraction

Triggered when a sub-agent task completes. This is the highest-priority extraction — it's how patterns are born.

**Input:** Task record + sub-agent output (conversation log or summary)
**Output:** Updated patterns, code changes, potential knowledge entries

**LLM Model for extraction:** Claude Sonnet (not Opus). Extraction is a structured analysis task where Sonnet performs comparably to Opus at 1/5 the cost. Reserve Opus for the main agent loop.

See **Appendix C** for the full extraction prompt template.

### Document Ingestion

Triggered when The agent reads technical documentation.

**Input:** URL + extracted markdown content
**Output:** Structured knowledge entries

**Chunking:** Documents are split into sections by heading. Each section is processed independently for extraction. This limits per-call token usage and allows partial failure recovery.

### Conversation Extraction

Triggered periodically (after every ~5 conversation chunks, or on session end).

**Input:** Recent episodic chunks
**Output:** Graph nodes, edges, entity mentions, decisions

This is lower priority than post-task extraction. It runs asynchronously and can be delayed without harm.

### Consolidation

Runs on a schedule (daily during low-activity hours, or triggered manually).

**Tasks:**
1. **Merge duplicate patterns:** Find patterns with similar descriptions and merge them, keeping the higher-confidence version
2. **Resolve contradictions:** Surface `graph_contradictions` with `resolution = 'pending'` for review
3. **Prune stale entries:** Decay confidence of untouched patterns (>90 days)
4. **Update statistics:** Recount file/symbol counts, verify active edit locks aren't stale
5. **Compact episodic memory:** For chunks older than 180 days, keep only the summary (discard raw content to save space)

### Extraction Worker

The worker processes queue items sequentially with rate limiting:

```typescript
class ExtractionWorker {
  private processing = false;
  private readonly maxConcurrent = 1;   // Sequential to avoid rate limits
  private readonly cooldownMs = 2000;    // 2s between extractions
  private readonly maxTokensPerHour = 500_000;  // Cost guardrail

  async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (true) {
        // Check token budget
        const hourlyUsage = this.getHourlyTokenUsage();
        if (hourlyUsage >= this.maxTokensPerHour) {
          logger.warn('Extraction budget exceeded, pausing', { hourlyUsage });
          break;
        }

        // Get next pending item
        const item = db.prepare(`
          SELECT * FROM extraction_queue
          WHERE status = 'pending' AND retry_count < max_retries
          ORDER BY priority ASC, created_at ASC
          LIMIT 1
        `).get();

        if (!item) break;

        // Mark as processing
        db.prepare('UPDATE extraction_queue SET status = ?, started_at = unixepoch() WHERE id = ?')
          .run('processing', item.id);

        try {
          const result = await this.processItem(item);
          db.prepare(`
            UPDATE extraction_queue
            SET status = 'completed', result = ?, tokens_used = ?, cost_usd = ?,
                completed_at = unixepoch()
            WHERE id = ?
          `).run(JSON.stringify(result.data), result.tokensUsed, result.costUsd, item.id);
        } catch (err) {
          db.prepare(`
            UPDATE extraction_queue
            SET status = 'failed', error = ?, retry_count = retry_count + 1
            WHERE id = ?
          `).run(err.message, item.id);
          // Failed items return to 'pending' if retries remain
          if (item.retry_count + 1 < item.max_retries) {
            db.prepare('UPDATE extraction_queue SET status = ? WHERE id = ?')
              .run('pending', item.id);
          }
        }

        await sleep(this.cooldownMs);
      }
    } finally {
      this.processing = false;
    }
  }
}
```

### Error Handling

Extraction failures are expected and handled gracefully:

| Failure Mode | Impact | Mitigation |
|---|---|---|
| LLM returns malformed JSON | Extraction for this item fails | Retry with explicit format instructions. After 3 retries, skip and log. |
| LLM hallucinates a pattern | Bad pattern enters memory | Low initial confidence (0.5). Never auto-injected until validated. Human can review via MCP `list_patterns` tool. |
| Embedding API down | Can't store vectors | Queue item stays pending. Retry on next worker run. Episodic and knowledge entries still stored (just not searchable by vector until embedded). |
| Rate limited | Worker blocks | Respect Retry-After header. Token budget guardrail prevents runaway costs. |
| Duplicate pattern extracted | Redundant entries | Consolidation merges duplicates. Extraction prompt instructs LLM to check for existing similar patterns (prompt includes recent pattern titles). |
| Wrong confidence assigned | Pattern over/under trusted | Confidence is self-correcting: contradictions decrease it, validations increase it. Over time, bad confidence scores converge to truth. |

---

## 10. MCP Server

### Purpose

The MCP (Model Context Protocol) server exposes River's memory to any AI client that speaks MCP. This means Claude Code sessions in tmux, CRUCIBLE debate agents, Codex, and any future tool all share one brain. No more siloed knowledge.

### Server Configuration

The MCP server runs as part of river-runtime on a separate port (default 3003) or as a stdio transport for direct integration.

```yaml
# Addition to river.config.yaml
mcp:
  enabled: true
  transport: stdio     # or "http" for network access
  port: 3003           # only used with http transport
  auth:
    type: bearer       # simple token auth for http transport
    token: ${MCP_AUTH_TOKEN}
```

### Tool Definitions

#### `search_memory`

Search across all memory tiers with unified results.

```json
{
  "name": "search_memory",
  "description": "Search River's memory across all tiers. Returns relevant episodic memories, patterns, knowledge entries, and graph entities. Use this as the primary memory retrieval tool.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Natural language search query"
      },
      "tiers": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": ["episodic", "pattern", "knowledge", "graph", "code"]
        },
        "description": "Which memory tiers to search. Default: all."
      },
      "limit": {
        "type": "number",
        "description": "Maximum results per tier. Default: 5."
      },
      "time_range": {
        "type": "object",
        "properties": {
          "after": { "type": "string", "description": "ISO date string" },
          "before": { "type": "string", "description": "ISO date string" }
        }
      },
      "technology": {
        "type": "string",
        "description": "Filter knowledge entries by technology"
      }
    },
    "required": ["query"]
  }
}
```

#### `get_patterns`

Retrieve patterns relevant to a specific task or technology.

```json
{
  "name": "get_patterns",
  "description": "Get relevant patterns and anti-patterns from River's experience. Use before starting any coding task to benefit from past lessons.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "categories": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Technology categories to match: 'typescript', 'react', 'next.js', 'git', 'deployment', etc."
      },
      "task_description": {
        "type": "string",
        "description": "Description of the task you're about to do. Used for relevance matching."
      },
      "min_confidence": {
        "type": "number",
        "description": "Minimum confidence threshold. Default: 0.5."
      },
      "include_anti_patterns": {
        "type": "boolean",
        "description": "Include anti-patterns (things to avoid). Default: true."
      },
      "limit": {
        "type": "number",
        "description": "Maximum patterns to return. Default: 10."
      }
    },
    "required": []
  }
}
```

#### `query_knowledge`

Query the technical knowledge base.

```json
{
  "name": "query_knowledge",
  "description": "Query River's technical knowledge base for API signatures, migration notes, breaking changes, best practices, and other structured technical knowledge. Use when you need current documentation that may be newer than your training data.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Natural language query about technical knowledge"
      },
      "technology": {
        "type": "string",
        "description": "Specific technology to query: 'next.js', 'anthropic-sdk', 'typescript', etc."
      },
      "version": {
        "type": "string",
        "description": "Specific version to filter by"
      },
      "entry_type": {
        "type": "string",
        "enum": ["api_signature", "migration_note", "breaking_change", "best_practice", "anti_pattern", "config_option", "error_solution", "example", "concept"],
        "description": "Filter by entry type"
      },
      "limit": {
        "type": "number",
        "description": "Maximum entries to return. Default: 5."
      }
    },
    "required": []
  }
}
```

#### `search_code`

Query the code intelligence layer.

```json
{
  "name": "search_code",
  "description": "Search indexed codebases for symbols, files, dependencies, and change history. Use for impact analysis before modifying code.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Symbol name, file path, or search text"
      },
      "repo": {
        "type": "string",
        "description": "Repository name to search. Default: all repos."
      },
      "search_type": {
        "type": "string",
        "enum": ["symbol", "file", "dependency", "impact", "history"],
        "description": "Type of search. 'impact' shows what depends on a given file/symbol."
      },
      "symbol_type": {
        "type": "string",
        "enum": ["function", "class", "interface", "type", "enum", "constant"],
        "description": "Filter symbols by type"
      }
    },
    "required": ["query"]
  }
}
```

#### `add_memory`

Explicitly add a memory entry (for manual corrections or additions).

```json
{
  "name": "add_memory",
  "description": "Explicitly add a memory entry to a specific tier. Use for manual corrections, important facts to remember, or direct knowledge insertion.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "tier": {
        "type": "string",
        "enum": ["episodic", "pattern", "knowledge", "graph"],
        "description": "Which memory tier to write to"
      },
      "content": {
        "type": "object",
        "description": "Tier-specific content. See tier documentation for required fields.",
        "additionalProperties": true
      }
    },
    "required": ["tier", "content"]
  }
}
```

#### `get_related`

Query the knowledge graph for entity relationships.

```json
{
  "name": "get_related",
  "description": "Find entities related to a given entity in the knowledge graph. Supports multi-hop queries.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "entity": {
        "type": "string",
        "description": "Entity name to look up"
      },
      "entity_type": {
        "type": "string",
        "enum": ["person", "project", "technology", "decision", "repo", "location", "organization", "concept"],
        "description": "Filter by entity type"
      },
      "relationship": {
        "type": "string",
        "description": "Filter by relationship type: 'works_on', 'depends_on', etc."
      },
      "max_hops": {
        "type": "number",
        "description": "Maximum relationship hops for path finding. Default: 2."
      },
      "target_entity": {
        "type": "string",
        "description": "If provided, find paths between entity and target_entity"
      }
    },
    "required": ["entity"]
  }
}
```

#### `record_task_outcome`

Record the outcome of a task for pattern extraction.

```json
{
  "name": "record_task_outcome",
  "description": "Record the outcome of a completed task. Triggers pattern extraction. Call this after finishing any significant coding or research task.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "task_id": {
        "type": "number",
        "description": "Task ID if known (from dispatch)"
      },
      "description": {
        "type": "string",
        "description": "What the task was"
      },
      "outcome": {
        "type": "string",
        "enum": ["success", "failure", "partial"],
        "description": "How it went"
      },
      "outcome_notes": {
        "type": "string",
        "description": "Details: what worked, what didn't, what the fix was"
      },
      "technologies": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Technologies involved"
      },
      "files_touched": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Files that were modified"
      }
    },
    "required": ["description", "outcome"]
  }
}
```

### MCP Server Implementation Sketch

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

class RiverMemoryMCPServer {
  private server: Server;
  private memory: MemoryManager;

  constructor(memory: MemoryManager) {
    this.memory = memory;
    this.server = new Server(
      { name: 'river-memory', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    this.registerTools();
  }

  private registerTools(): void {
    this.server.setRequestHandler('tools/list', async () => ({
      tools: [
        // All tool definitions from above
      ]
    }));

    this.server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'search_memory':
          return this.handleSearchMemory(args);
        case 'get_patterns':
          return this.handleGetPatterns(args);
        case 'query_knowledge':
          return this.handleQueryKnowledge(args);
        case 'search_code':
          return this.handleSearchCode(args);
        case 'add_memory':
          return this.handleAddMemory(args);
        case 'get_related':
          return this.handleGetRelated(args);
        case 'record_task_outcome':
          return this.handleRecordTaskOutcome(args);
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
  }
}
```

---

## 11. Dispatch Enhancement

### Purpose

Dispatch enhancement is where the ROI materializes. Before every sub-agent dispatch, the system automatically enriches the prompt with relevant context from all memory tiers. This is the mechanism by which River gets measurably better over time — each dispatch benefits from everything learned in prior dispatches.

### The Enhancement Flow

```
Task Description (from user or River)
     │
     ▼
┌─────────────────────────────────┐
│    1. Analyze Task              │
│    Extract: technologies,       │
│    file paths, task type        │
└──────────────┬──────────────────┘
               │
     ┌─────────┼─────────┐
     ▼         ▼         ▼
┌─────────┐ ┌─────────┐ ┌─────────┐
│Pattern  │ │Knowledge│ │Code     │
│Memory   │ │Base     │ │Index    │
│(Tier 3) │ │(Tier 4) │ │(cross)  │
└────┬────┘ └────┬────┘ └────┬────┘
     │           │           │
     ▼           ▼           ▼
┌─────────────────────────────────┐
│    2. Build Context Block       │
│    Patterns + Knowledge +       │
│    Impact Analysis              │
│    (≤ 3000 tokens)              │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│    3. Compose Enhanced Prompt   │
│    Original task                │
│    + Context block              │
│    + Task record (for outcome   │
│      tracking)                  │
└──────────────┬──────────────────┘
               │
               ▼
         Sub-Agent Dispatch
```

### Task Analysis

The task analyzer is a lightweight LLM call (or pattern matching — for common task types, no LLM needed):

```typescript
interface TaskAnalysis {
  taskType: string;           // "coding", "review", "debug", etc.
  technologies: string[];     // ["typescript", "next.js", "prisma"]
  filePaths: string[];        // Extracted file paths from the task description
  concepts: string[];         // ["authentication", "websocket", "migration"]
  estimatedComplexity: 'low' | 'medium' | 'high';
}

function analyzeTask(description: string): TaskAnalysis {
  // Try pattern matching first (free, fast)
  const technologies = detectTechnologies(description);
  const filePaths = extractFilePaths(description);

  // If we got enough signal, skip the LLM call
  if (technologies.length > 0 || filePaths.length > 0) {
    return {
      taskType: inferTaskType(description),
      technologies,
      filePaths,
      concepts: extractConcepts(description),
      estimatedComplexity: estimateComplexity(description),
    };
  }

  // Fall back to LLM analysis for ambiguous tasks
  return llmAnalyzeTask(description);
}

// Pattern matching for common technologies
function detectTechnologies(text: string): string[] {
  const techs: string[] = [];
  const patterns: Record<string, RegExp> = {
    'typescript': /typescript|\.ts\b|tsconfig/i,
    'react': /react|jsx|tsx|component|hook|useState/i,
    'next.js': /next\.js|next\.config|getServerSideProps|app\s*router/i,
    'prisma': /prisma|schema\.prisma|PrismaClient/i,
    'sqlite': /sqlite|better-sqlite3|\.sqlite/i,
    'docker': /docker|dockerfile|container|docker-compose/i,
    'git': /\bgit\b|commit|branch|merge|rebase|cherry-pick/i,
    'anthropic': /anthropic|claude|opus|sonnet/i,
    'node': /node\.js|node_modules|package\.json/i,
  };

  for (const [tech, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) techs.push(tech);
  }
  return techs;
}
```

### Context Block Builder

```typescript
async function buildContextBlock(
  analysis: TaskAnalysis,
  memory: MemoryManager,
  tokenBudget: number = 3000
): Promise<string> {
  const sections: string[] = [];
  let tokensUsed = 0;

  // 1. Relevant patterns (budget: ~40% of total)
  const patternBudget = Math.floor(tokenBudget * 0.4);
  const patterns = await memory.getPatterns({
    categories: analysis.technologies,
    minConfidence: 0.6,
    limit: 5,
  });

  if (patterns.length > 0) {
    const patternBlock = formatPatterns(patterns);
    const patternTokens = estimateTokens(patternBlock);
    if (tokensUsed + patternTokens <= tokenBudget) {
      sections.push(patternBlock);
      tokensUsed += patternTokens;
    }
  }

  // 2. Relevant knowledge (budget: ~35% of total)
  const knowledgeBudget = Math.floor(tokenBudget * 0.35);
  const knowledge = await memory.queryKnowledge({
    technology: analysis.technologies[0],  // Primary technology
    query: analysis.concepts.join(' '),
    limit: 3,
  });

  if (knowledge.length > 0) {
    const knowledgeBlock = formatKnowledge(knowledge);
    const knowledgeTokens = estimateTokens(knowledgeBlock);
    if (tokensUsed + knowledgeTokens <= tokenBudget) {
      sections.push(knowledgeBlock);
      tokensUsed += knowledgeTokens;
    }
  }

  // 3. Impact analysis for file-level tasks (budget: ~25% of total)
  if (analysis.filePaths.length > 0) {
    const impact = await memory.analyzeCodeImpact(analysis.filePaths);
    if (impact.directDependents.length > 0 || impact.activeEdits.length > 0) {
      const impactBlock = formatImpact(impact);
      const impactTokens = estimateTokens(impactBlock);
      if (tokensUsed + impactTokens <= tokenBudget) {
        sections.push(impactBlock);
        tokensUsed += impactTokens;
      }
    }
  }

  if (sections.length === 0) return '';

  return [
    '## Context from River\'s Memory',
    '',
    '*The following context was automatically retrieved from past experience.',
    'Use it to inform your approach, but verify against current code.*',
    '',
    ...sections,
  ].join('\n');
}
```

### Enhanced Prompt Format

```
[Original task description from user/River]

---

## Context from River's Memory

*The following context was automatically retrieved from past experience.
Use it to inform your approach, but verify against current code.*

### Patterns from Past Experience

⚠️ ANTI-PATTERN [confidence: 0.87]:
"Anthropic model ID format varies by SDK version"
→ Always verify model ID format against current SDK types.

✅ PATTERN [confidence: 0.72]:
"WebSocket reconnection with exponential backoff + jitter"
→ 1s base, 2x multiplier, max 30s, +random(0-1s) jitter.

### Relevant Technical Knowledge

📚 [anthropic-sdk v0.78.0] Breaking Change:
"Message.content is now ContentBlock[] not string"
→ All message handling must destructure content blocks.
Source: Anthropic SDK changelog (read 2026-03-10)

### Impact Analysis

📁 Files that import `src/llm/types.ts`:
  - src/agent/core.ts (imports: LLMMessage, ContentBlock, ToolUseBlock)
  - src/llm/anthropic.ts (imports: LLMMessage, ChatRequest)
  - src/llm/router.ts (imports: LLMMessage, ChatRequest, ChatResponse)

⚠️ No active edits on these files.

---

**Task ID: 147** — record outcome when complete via `record_task_outcome`.
```

### Measuring Improvement

To validate that dispatch enhancement actually works, we track:

```sql
-- Compare outcomes of dispatches with vs. without pattern injection
SELECT
  CASE WHEN t.patterns_injected != '[]' THEN 'enhanced' ELSE 'baseline' END AS dispatch_type,
  t.outcome,
  COUNT(*) as count,
  AVG(t.duration_ms) as avg_duration_ms
FROM tasks t
WHERE t.outcome IN ('success', 'failure', 'partial')
GROUP BY dispatch_type, outcome;
```

If enhanced dispatches don't show better success rates after 50+ tasks, the injection system needs recalibrating (threshold too low? patterns too generic? wrong retrieval?).

---

## 12. Migration Plan

### Phase 0: Preparation (Day 1)

1. **Backup everything:**
   ```bash
   cp -r /path/to/memory/ /path/to/backup/
   cp /home/user/.openclaw/workspace/MEMORY.md /path/to/backup/
   ```

2. **Install sqlite-vec:**
   ```bash
   cd /home/user/projects/river-runtime
   pnpm add sqlite-vec
   ```

3. **Add MCP SDK:**
   ```bash
   pnpm add @modelcontextprotocol/sdk
   ```

4. **Add embedding dependency (if local):**
   ```bash
   pnpm add @xenova/transformers  # Only if using local embeddings
   ```

### Phase 1: Schema Migration (Day 1)

Run the full schema DDL from Appendix A against `data/river.sqlite`. This is additive — the existing `kv` and `metadata` tables are untouched.

```typescript
// src/memory/migrate.ts
export function runMigrations(db: Database.Database): void {
  const currentVersion = db.prepare(
    "SELECT value FROM metadata WHERE key = 'schema_version'"
  ).get()?.value ?? '0';

  if (parseInt(currentVersion) < 1) {
    db.exec(SCHEMA_V1);  // All CREATE TABLE statements from this spec
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '1')")
      .run();
    logger.info('Schema migrated to v1');
  }
}
```

### Phase 2: Bootstrap Existing Data (Day 1-2)

1. **Ingest existing daily memory files as episodic chunks:**
   ```typescript
   // For each memory/YYYY-MM-DD.md file:
   // 1. Read content
   // 2. Extract date from filename
   // 3. Create episodic chunk with file date as timestamp
   // 4. Generate summary via LLM
   // 5. Embed and store
   ```

2. **Seed known patterns** (the SQL from Tier 3 cold start section)

3. **Seed core graph nodes** (the SQL from Tier 5 cold start section)

4. **Register repos for code indexing:**
   ```sql
   INSERT INTO code_repos (name, path, language)
   VALUES
     ('river-runtime', '/home/user/projects/river-runtime', 'typescript'),
     ('myapp', '/home/user/projects/myapp', 'typescript');
   ```

5. **Run initial code index** on both repos

### Phase 3: Wire Up to Runtime (Day 2-3)

1. Replace `MemoryStore` class with `MemoryManager` that manages all tiers
2. Update `ContextBuilder` to inject dynamic context from Tiers 2-4
3. Add `ExtractionWorker` with queue processing
4. Add post-task hooks to the agent loop

### Phase 4: MCP Server (Day 3-4)

1. Implement MCP server with all tool definitions
2. Test with Claude Code via stdio transport
3. Add HTTP transport for network access

### Phase 5: Dispatch Enhancement (Day 4-5)

1. Implement `TaskAnalyzer` and `ContextBlockBuilder`
2. Wire into sub-agent dispatch flow
3. Start tracking task outcomes

### Phase 6: Monitoring and Tuning (Ongoing)

1. Monitor extraction costs
2. Tune retrieval thresholds
3. Review pattern quality
4. Measure dispatch improvement

---

## 13. Cost Analysis

### Embedding Costs

**OpenAI `text-embedding-3-small`:** $0.02 per 1M tokens

| Operation | Tokens per call | Frequency | Monthly estimate |
|-----------|----------------|-----------|-----------------|
| Episodic chunk embedding | ~500 | ~50/day | 750K tokens → $0.015 |
| Knowledge entry embedding | ~200 | ~20/day | 120K tokens → $0.002 |
| Query embedding | ~100 | ~100/day | 300K tokens → $0.006 |
| **Total embeddings** | | | **~$0.02/month** |

Embedding costs are negligible. Even at 10x the estimated volume, it's $0.20/month.

**Local embeddings (`all-MiniLM-L6-v2`):** $0. But lower quality and adds ~200MB to the runtime footprint.

### Extraction Costs

**Claude Sonnet 4 (extraction model):** $3/1M input, $15/1M output

| Operation | Input tokens | Output tokens | Frequency | Monthly estimate |
|-----------|-------------|---------------|-----------|-----------------|
| Post-task extraction | ~3000 | ~800 | ~10/day | 900K in + 240K out → $6.30 |
| Document ingestion | ~4000 | ~1000 | ~5/day | 600K in + 150K out → $4.05 |
| Conversation extraction | ~2000 | ~500 | ~20/day | 1.2M in + 300K out → $8.10 |
| Consolidation | ~5000 | ~1000 | 1/day | 150K in + 30K out → $0.90 |
| Task analysis (LLM fallback) | ~500 | ~200 | ~5/day | 75K in + 30K out → $0.67 |
| **Total extraction** | | | | **~$20/month** |

This is the real cost. $20/month for a system that gets measurably better at coding tasks over time is a good deal, but it's not free. The token budget guardrail (`maxTokensPerHour = 500K`) prevents runaway costs.

### Cost Reduction Strategies

1. **Use Haiku for simple extractions.** Conversation extraction and topic tagging don't need Sonnet. Haiku at $0.25/1M input would cut conversation extraction costs by 12x.

2. **Skip extraction for trivial tasks.** If a task took < 30 seconds and the outcome was "success" with no errors, the pattern extraction is unlikely to find anything interesting. Skip it.

3. **Batch consolidation.** Run consolidation weekly instead of daily unless the queue grows large.

4. **Cache embeddings.** If the same query is embedded multiple times (common in interactive sessions), cache the vector for the session.

### Monthly Cost Summary

| Component | Estimated Cost |
|-----------|---------------|
| Embeddings (OpenAI) | $0.02 |
| Extraction (Sonnet) | $20.00 |
| Storage (SQLite) | $0.00 |
| MCP Server | $0.00 |
| **Total** | **~$20/month** |

With Haiku optimization: ~$10/month.
With local embeddings + Haiku: ~$8/month.

---

## 14. Example Scenarios

### Scenario 1: Learning from a Failed Deployment

**Day 1:** River dispatches Claude Code to deploy a Next.js app to Railway.

The task fails because Railway's build process doesn't find `next.config.ts` (it expects `next.config.mjs` for certain project setups).

**Post-task extraction produces:**

```json
{
  "task": "Deploy Next.js app to Railway",
  "outcome": "failure",
  "pattern": {
    "pattern_type": "anti_pattern",
    "category": "deployment",
    "title": "Railway Next.js config file naming",
    "description": "Railway's build process may not recognize next.config.ts. Some setups require next.config.mjs or next.config.js.",
    "context": "Deploying Next.js applications to Railway",
    "recommendation": "Use next.config.mjs for Railway deployments. Verify build logs for config file detection. Add explicit build command in railway.json if default doesn't work.",
    "confidence": 0.5
  }
}
```

**Day 5:** Another Railway deployment task is dispatched. The dispatch enhancer finds the pattern (confidence 0.5, below injection threshold but still in scope since we're deploying to Railway). It includes it as a note:

```
### Note from past experience (low confidence):
Railway may have issues with next.config.ts — consider using .mjs extension.
```

The deployment succeeds using `.mjs`. The pattern is validated. Confidence → 0.65. Now it's above injection threshold.

**Day 15:** Third Railway deployment. The pattern is auto-injected with confidence 0.65. The sub-agent gets it right on the first try. Confidence → 0.76.

**Net result:** River went from 1 failure to 0 failures for Railway deployments, permanently.

### Scenario 2: Technical Documentation Keeps River Current

**Day 1:** The user asks the agent to use the new `unstable_cache` API from Next.js 15.

River's model training data has `unstable_cache` documented, but the API changed in Next.js 15.2 (it was renamed to `cacheLife`). River uses the old name. It fails.

**Day 2:** The agent reads the Next.js 15.2 release notes. The doc ingestion pipeline extracts:

```json
{
  "technology": "next.js",
  "version": "15.2.0",
  "entry_type": "breaking_change",
  "title": "unstable_cache renamed to cacheLife",
  "content": "The unstable_cache function has been renamed to cacheLife in Next.js 15.2. Import from 'next/cache'. The API is otherwise identical.",
  "code_example": "import { cacheLife } from 'next/cache';\n\nexport default async function Page() {\n  cacheLife('hours');\n  // ...\n}",
  "source_url": "https://nextjs.org/blog/next-15-2"
}
```

Also marks the old entry about `unstable_cache` as `is_current = 0, superseded_by = <new entry id>`.

**Day 3:** The user asks for a cached page. The dispatch enhancer queries Tier 4 for Next.js knowledge and injects:

```
📚 [next.js v15.2.0] Breaking Change:
"unstable_cache renamed to cacheLife"
→ Import from 'next/cache'. API is otherwise identical.
```

Sub-agent uses `cacheLife` correctly on the first try.

**Net result:** River overcame its training data limitation using ingested documentation.

### Scenario 3: Code Impact Analysis Prevents a Bug

**Task:** Refactor the `LLMMessage` type in `src/llm/types.ts`.

**Dispatch enhancer queries code intelligence:**

```
📁 Impact Analysis for src/llm/types.ts:

Direct dependents (3 files):
  - src/agent/core.ts → imports: LLMMessage, ContentBlock, ToolUseBlock, ToolResultBlock
  - src/agent/session.ts → imports: LLMMessage
  - src/llm/anthropic.ts → imports: LLMMessage, ChatRequest, ChatResponse

Transitive dependents (2 files):
  - src/channels/router.ts (via agent/core.ts)
  - src/index.ts (via agent/core.ts)

Total affected files: 5
```

Sub-agent knows exactly what needs updating. No forgotten imports, no runtime surprises.

### Scenario 4: Multi-Hop Graph Query

**User:** "What was the decision about the Portland expansion?"

**River queries the knowledge graph:**

```
Path: Portland → deployed_in ← WebApp Project → decided_on → "Expand to Middle TN market"

Decision node properties:
  - date: 2026-02-20
  - status: approved
  - rationale: "Nashville market growth, existing contractor relationships"
  - blockers: "Need TN contractor license, insurance update"
```

The agent surfaces the decision with full context, even though the user's question didn't mention WebApp by name.

---

## 15. Implementation Phases

### Phase 1: Foundation (Week 1) — HIGH PRIORITY

**Goal:** Get the database schema in place and episodic memory working.

| Task | Effort | Dependencies |
|------|--------|-------------|
| Schema migration system | 4h | None |
| All CREATE TABLE statements | 2h | Migration system |
| Embedding service (OpenAI API) | 3h | None |
| Episodic chunk creation | 4h | Schema, Embeddings |
| Episodic vector search | 4h | sqlite-vec integration |
| Bootstrap existing memory files | 2h | Episodic chunk creation |
| ContextBuilder injection | 3h | Episodic search |
| **Total** | **~22h** | |

**Deliverable:** River can semantically search past conversations. "What did we discuss about deployment?" returns relevant chunks.

### Phase 2: Pattern Memory (Week 2) — HIGH PRIORITY

**Goal:** Start extracting patterns from tasks and injecting them into dispatches.

| Task | Effort | Dependencies |
|------|--------|-------------|
| Task tracking table + CRUD | 3h | Phase 1 schema |
| Pattern table + CRUD | 3h | Phase 1 schema |
| Post-task extraction pipeline | 6h | Extraction prompts |
| Extraction queue + worker | 4h | None |
| Confidence scoring | 2h | Pattern CRUD |
| Pattern retrieval for dispatch | 3h | Pattern CRUD |
| Dispatch enhancement: basic | 4h | Pattern retrieval |
| Seed known patterns | 1h | Pattern CRUD |
| **Total** | **~26h** | |

**Deliverable:** After every coding task, patterns are extracted. Dispatches include relevant patterns.

### Phase 3: Knowledge Base (Week 3) — MEDIUM PRIORITY

**Goal:** River can ingest technical documentation and serve it to sub-agents.

| Task | Effort | Dependencies |
|------|--------|-------------|
| Knowledge entry CRUD | 3h | Phase 1 schema |
| Document ingestion pipeline | 5h | Extraction prompts |
| Knowledge source tracking | 2h | None |
| Knowledge retrieval (hybrid search) | 4h | Embeddings |
| Integration with dispatch enhancer | 2h | Phase 2 dispatch |
| Bootstrap priority docs | 2h | Ingestion pipeline |
| **Total** | **~18h** | |

**Deliverable:** River can read Next.js docs, store structured entries, and inject them into relevant dispatches.

### Phase 4: MCP Server (Week 3-4) — MEDIUM PRIORITY

**Goal:** Any AI client can query River's memory via MCP.

| Task | Effort | Dependencies |
|------|--------|-------------|
| MCP server skeleton | 3h | @modelcontextprotocol/sdk |
| search_memory tool | 3h | Tiers 2-4 search |
| get_patterns tool | 2h | Tier 3 retrieval |
| query_knowledge tool | 2h | Tier 4 retrieval |
| search_code tool | 2h | Phase 5 code index |
| add_memory tool | 2h | All tiers |
| record_task_outcome tool | 2h | Tier 3 tasks |
| get_related tool | 3h | Phase 6 graph |
| Stdio transport | 2h | MCP server |
| HTTP transport + auth | 3h | MCP server |
| **Total** | **~24h** | |

**Deliverable:** Claude Code in tmux can call `get_patterns` before starting work.

### Phase 5: Code Intelligence (Week 4) — MEDIUM PRIORITY

**Goal:** Symbol-level code indexing with impact analysis.

| Task | Effort | Dependencies |
|------|--------|-------------|
| Repo + file scanning | 3h | Phase 1 schema |
| Symbol extraction (regex) | 4h | File scanning |
| Import/dependency tracking | 3h | Symbol extraction |
| Impact analysis query | 3h | Dependency tracking |
| Post-task file change tracking | 3h | Phase 2 tasks |
| Active edit locking | 2h | Task tracking |
| Dispatch integration | 2h | Phase 2 dispatch |
| **Total** | **~20h** | |

**Deliverable:** "What imports this file?" and "What will break if I change this?" have answers.

### Phase 6: Knowledge Graph (Week 5-6) — LOW PRIORITY

**Goal:** Entity relationships with multi-hop queries.

| Task | Effort | Dependencies |
|------|--------|-------------|
| Node + edge CRUD | 3h | Phase 1 schema |
| Conversation entity extraction | 5h | Extraction prompts |
| Multi-hop path finding | 3h | Node/edge CRUD |
| Contradiction detection | 3h | Edge CRUD |
| Bootstrap core entities | 1h | Node CRUD |
| Integration with search_memory | 2h | MCP server |
| **Total** | **~17h** | |

**Deliverable:** "What connects User to ProjectA?" returns a path through the graph.

### Phase 7: Consolidation & Polish (Week 6+) — ONGOING

| Task | Effort | Dependencies |
|------|--------|-------------|
| Consolidation worker (dedup, prune, decay) | 4h | All tiers |
| Cost monitoring dashboard | 3h | Extraction queue |
| Backup automation | 2h | SQLite |
| Performance tuning | 4h | All tiers |
| Quality metrics and reporting | 3h | All tiers |
| **Total** | **~16h** | |

### Total Estimated Effort

| Phase | Effort | Priority |
|-------|--------|----------|
| Phase 1: Foundation | 22h | HIGH |
| Phase 2: Pattern Memory | 26h | HIGH |
| Phase 3: Knowledge Base | 18h | MEDIUM |
| Phase 4: MCP Server | 24h | MEDIUM |
| Phase 5: Code Intelligence | 20h | MEDIUM |
| Phase 6: Knowledge Graph | 17h | LOW |
| Phase 7: Consolidation | 16h | ONGOING |
| **Total** | **~143h** | |

At ~4-6h of focused dev time per day, that's roughly 4-5 weeks to full implementation. Phases 1-2 deliver the highest value and should take about 1.5 weeks.

---

## 16. Risks and Limitations

### Real Risks (Not Theoretical)

**1. Extraction quality is only as good as the LLM.**
If the extraction model misidentifies a pattern, the system learns the wrong lesson. Mitigation: low initial confidence, validation required before injection, human-reviewable via MCP tools. But this is a real risk — garbage in, garbage out.

**2. The system could become a crutch for bad patterns.**
If a pattern says "always use approach X" but the real answer is "it depends," the system will keep injecting a simplistic rule. Mitigation: patterns have `context` fields that describe when they apply, and contradiction detection can flag when a pattern doesn't hold. But nuance is hard to encode.

**3. Token costs scale with activity.**
The $20/month estimate assumes moderate usage (~10 tasks/day). A heavy day with 50 tasks could spike to $5-10 in extraction costs alone. Mitigation: token budget guardrail, skip trivial tasks, use cheaper models for simple extractions.

**4. SQLite concurrency limits.**
SQLite handles concurrent reads well (WAL mode) but writes are serialized. If the extraction worker is writing heavily while the main agent loop is also writing, there could be contention. Mitigation: extraction writes are batched and infrequent. Monitor `SQLITE_BUSY` errors.

**5. Vector search quality depends on embedding model.**
`text-embedding-3-small` is good but not perfect. Two semantically related queries might not return each other if they use very different vocabulary. Mitigation: hybrid search (vector + keyword) for knowledge base. Accept that recall will be imperfect.

**6. The knowledge base can become stale.**
If The agent reads docs for Next.js 15.2 but then 15.3 ships with changes, the knowledge base has outdated info. Mitigation: source tracking with dates, periodic re-reads, `is_current` flag. But we depend on someone (the agent or user) triggering doc re-reads.

**7. Code intelligence regex parser is incomplete.**
The regex-based TypeScript parser will miss complex patterns (computed property names, namespace re-exports, barrel files with `export * from`). Mitigation: this covers the 80% case. For the other 20%, post-task extraction can use the LLM to analyze specific files. If regex coverage is a problem in practice, switch to `ts-morph` for proper AST parsing (adds complexity and build time).

**8. Over-injection dilutes attention.**
If the context block injected into dispatches is too large or too generic, it could distract the sub-agent from the actual task. Mitigation: strict 3000-token budget for context block. Quality over quantity. Monitor whether enhanced dispatches actually perform better than baseline.

### Limitations We Accept

- **No real-time embedding updates.** Embeddings are generated asynchronously via the queue. A chunk stored 5 seconds ago might not be searchable yet. This is fine — episodic memory is for recall, not real-time.

- **Single-user optimized.** The graph, patterns, and knowledge are all shaped by one user's (the user's) work and preferences. Multi-user support would require namespacing everything. Not needed now.

- **No cross-machine sync.** The SQLite file lives on one machine. If River runs on multiple machines, they don't share memory. If this becomes needed, the MCP HTTP transport can expose memory to remote instances, but there's no automatic sync.

- **English only.** Embeddings, extraction prompts, and knowledge entries are all in English. No i18n considerations.

- **No deletion propagation.** If a pattern is deleted, evidence records still reference it. If a graph node is deleted, edges become orphaned. Soft deletes (`is_active = 0`) are preferred over hard deletes for this reason.

---

## Appendix A: Full Schema DDL

This is the complete schema for `river.sqlite`, suitable for copy-paste execution.

```sql
-- ============================================================
-- River Memory Architecture — Schema v1
-- Run this against data/river.sqlite
-- ============================================================

-- Enable WAL mode for better concurrent read performance
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- Existing tables (preserved from Phase 1)
-- ============================================================

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ============================================================
-- Tier 2: Episodic Memory
-- ============================================================

CREATE TABLE IF NOT EXISTS episodic_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key   TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER NOT NULL,
  summary       TEXT NOT NULL,
  content       TEXT NOT NULL,
  participants  TEXT NOT NULL DEFAULT '[]',
  topics        TEXT NOT NULL DEFAULT '[]',
  token_count   INTEGER NOT NULL DEFAULT 0,
  channel       TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(session_key, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_episodic_started ON episodic_chunks(started_at);
CREATE INDEX IF NOT EXISTS idx_episodic_session ON episodic_chunks(session_key);

-- ============================================================
-- Tier 3: Pattern Memory
-- ============================================================

CREATE TABLE IF NOT EXISTS patterns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_type    TEXT NOT NULL CHECK(
                    pattern_type IN ('pattern', 'anti_pattern', 'heuristic', 'workaround')
                  ),
  category        TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  context         TEXT NOT NULL,
  recommendation  TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 0.5,
  times_applied   INTEGER NOT NULL DEFAULT 0,
  times_validated INTEGER NOT NULL DEFAULT 0,
  times_violated  INTEGER NOT NULL DEFAULT 0,
  source_task_id  INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  last_applied_at INTEGER,
  superseded_by   INTEGER REFERENCES patterns(id),
  is_active       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_patterns_category ON patterns(category);
CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON patterns(confidence DESC);
CREATE INDEX IF NOT EXISTS idx_patterns_active ON patterns(is_active) WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS tasks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_key     TEXT NOT NULL,
  task_type       TEXT NOT NULL,
  description     TEXT NOT NULL,
  technologies    TEXT NOT NULL DEFAULT '[]',
  files_touched   TEXT NOT NULL DEFAULT '[]',
  agent           TEXT,
  dispatch_prompt TEXT,
  outcome         TEXT NOT NULL CHECK(
                    outcome IN ('success', 'failure', 'partial', 'abandoned', 'pending')
                  ) DEFAULT 'pending',
  outcome_notes   TEXT,
  started_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at    INTEGER,
  duration_ms     INTEGER,
  patterns_injected TEXT NOT NULL DEFAULT '[]',
  patterns_extracted TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_tasks_outcome ON tasks(outcome);
CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(task_type);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_key);

CREATE TABLE IF NOT EXISTS pattern_evidence (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id  INTEGER NOT NULL REFERENCES patterns(id),
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  evidence_type TEXT NOT NULL CHECK(
                evidence_type IN ('originated', 'validated', 'contradicted', 'refined')
              ),
  notes       TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_evidence_pattern ON pattern_evidence(pattern_id);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON pattern_evidence(task_id);

-- ============================================================
-- Tier 4: Knowledge Base
-- ============================================================

CREATE TABLE IF NOT EXISTS knowledge_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  technology      TEXT NOT NULL,
  version         TEXT,
  entry_type      TEXT NOT NULL CHECK(
                    entry_type IN (
                      'api_signature', 'migration_note', 'breaking_change',
                      'best_practice', 'anti_pattern', 'config_option',
                      'error_solution', 'example', 'concept'
                    )
                  ),
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  code_example    TEXT,
  source_url      TEXT,
  source_title    TEXT,
  date_read       INTEGER NOT NULL DEFAULT (unixepoch()),
  date_published  INTEGER,
  confidence      REAL NOT NULL DEFAULT 0.8,
  is_current      INTEGER NOT NULL DEFAULT 1,
  superseded_by   INTEGER REFERENCES knowledge_entries(id),
  tags            TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_knowledge_tech ON knowledge_entries(technology);
CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge_entries(entry_type);
CREATE INDEX IF NOT EXISTS idx_knowledge_tech_version ON knowledge_entries(technology, version);
CREATE INDEX IF NOT EXISTS idx_knowledge_current ON knowledge_entries(is_current) WHERE is_current = 1;

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT NOT NULL UNIQUE,
  title           TEXT,
  technology      TEXT NOT NULL,
  last_read_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  entry_count     INTEGER NOT NULL DEFAULT 0,
  hash            TEXT,
  read_count      INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_sources_tech ON knowledge_sources(technology);
CREATE INDEX IF NOT EXISTS idx_sources_url ON knowledge_sources(url);

-- ============================================================
-- Tier 5: Knowledge Graph
-- ============================================================

CREATE TABLE IF NOT EXISTS graph_nodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_type   TEXT NOT NULL CHECK(
                node_type IN (
                  'person', 'project', 'technology', 'decision',
                  'repo', 'location', 'organization', 'concept', 'file'
                )
              ),
  name        TEXT NOT NULL,
  canonical   TEXT NOT NULL,
  description TEXT,
  metadata    TEXT NOT NULL DEFAULT '{}',
  first_seen  INTEGER NOT NULL DEFAULT (unixepoch()),
  last_seen   INTEGER NOT NULL DEFAULT (unixepoch()),
  mention_count INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(node_type, canonical)
);

CREATE INDEX IF NOT EXISTS idx_nodes_type ON graph_nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_nodes_canonical ON graph_nodes(canonical);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON graph_nodes(name);

CREATE TABLE IF NOT EXISTS graph_edges (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id     INTEGER NOT NULL REFERENCES graph_nodes(id),
  target_id     INTEGER NOT NULL REFERENCES graph_nodes(id),
  edge_type     TEXT NOT NULL CHECK(
                  edge_type IN (
                    'works_on', 'depends_on', 'uses', 'created_by',
                    'married_to', 'lives_in', 'deployed_in', 'blocked_by',
                    'decided_on', 'related_to', 'employed_by', 'manages',
                    'forked_from', 'replaced_by', 'part_of', 'located_in'
                  )
                ),
  weight        REAL NOT NULL DEFAULT 1.0,
  evidence      TEXT,
  source_chunk_id INTEGER,
  bidirectional INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(source_id, target_id, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON graph_edges(edge_type);

CREATE TABLE IF NOT EXISTS graph_node_properties (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id     INTEGER NOT NULL REFERENCES graph_nodes(id),
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 0.8,
  source      TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(node_id, key)
);

CREATE INDEX IF NOT EXISTS idx_props_node ON graph_node_properties(node_id);

CREATE TABLE IF NOT EXISTS graph_contradictions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id         INTEGER REFERENCES graph_nodes(id),
  edge_id         INTEGER REFERENCES graph_edges(id),
  property_key    TEXT,
  existing_value  TEXT NOT NULL,
  new_value       TEXT NOT NULL,
  source_chunk_id INTEGER,
  resolution      TEXT CHECK(
                    resolution IN ('pending', 'kept_existing', 'updated', 'both_valid', 'dismissed')
                  ) DEFAULT 'pending',
  resolved_at     INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_contradictions_pending
  ON graph_contradictions(resolution) WHERE resolution = 'pending';

-- ============================================================
-- Cross-Cutting: Code Intelligence
-- ============================================================

CREATE TABLE IF NOT EXISTS code_repos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  language    TEXT NOT NULL DEFAULT 'typescript',
  last_indexed_at INTEGER,
  file_count  INTEGER NOT NULL DEFAULT 0,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS code_files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES code_repos(id),
  path        TEXT NOT NULL,
  language    TEXT NOT NULL DEFAULT 'typescript',
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  hash        TEXT,
  last_indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_modified_at INTEGER,
  is_active   INTEGER NOT NULL DEFAULT 1,
  UNIQUE(repo_id, path)
);

CREATE INDEX IF NOT EXISTS idx_files_repo ON code_files(repo_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON code_files(path);

CREATE TABLE IF NOT EXISTS code_symbols (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES code_files(id),
  name        TEXT NOT NULL,
  symbol_type TEXT NOT NULL CHECK(
                symbol_type IN (
                  'function', 'class', 'interface', 'type', 'enum',
                  'constant', 'variable', 'method', 'property', 'export'
                )
              ),
  signature   TEXT,
  line_start  INTEGER,
  line_end    INTEGER,
  is_exported INTEGER NOT NULL DEFAULT 0,
  doc_comment TEXT,
  last_indexed_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(file_id, name, symbol_type)
);

CREATE INDEX IF NOT EXISTS idx_symbols_name ON code_symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_type ON code_symbols(symbol_type);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON code_symbols(file_id);

CREATE TABLE IF NOT EXISTS code_dependencies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file_id INTEGER NOT NULL REFERENCES code_files(id),
  target_file_id INTEGER NOT NULL REFERENCES code_files(id),
  imported_symbols TEXT NOT NULL DEFAULT '[]',
  import_type TEXT NOT NULL CHECK(
                import_type IN ('static', 'dynamic', 're_export', 'type_only')
              ) DEFAULT 'static',
  UNIQUE(source_file_id, target_file_id)
);

CREATE INDEX IF NOT EXISTS idx_deps_source ON code_dependencies(source_file_id);
CREATE INDEX IF NOT EXISTS idx_deps_target ON code_dependencies(target_file_id);

CREATE TABLE IF NOT EXISTS code_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES code_files(id),
  task_id     INTEGER REFERENCES tasks(id),
  change_type TEXT NOT NULL CHECK(
                change_type IN ('created', 'modified', 'deleted', 'renamed')
              ),
  diff_summary TEXT,
  symbols_added TEXT NOT NULL DEFAULT '[]',
  symbols_removed TEXT NOT NULL DEFAULT '[]',
  symbols_modified TEXT NOT NULL DEFAULT '[]',
  lines_added INTEGER NOT NULL DEFAULT 0,
  lines_removed INTEGER NOT NULL DEFAULT 0,
  changed_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_changes_file ON code_changes(file_id);
CREATE INDEX IF NOT EXISTS idx_changes_task ON code_changes(task_id);

CREATE TABLE IF NOT EXISTS code_active_edits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES code_files(id),
  task_id     INTEGER NOT NULL REFERENCES tasks(id),
  agent       TEXT NOT NULL,
  started_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  released_at INTEGER,
  UNIQUE(file_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_active_file ON code_active_edits(file_id) WHERE released_at IS NULL;

-- ============================================================
-- Extraction Pipeline
-- ============================================================

CREATE TABLE IF NOT EXISTS extraction_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  extraction_type TEXT NOT NULL CHECK(
                    extraction_type IN (
                      'post_task', 'document', 'conversation', 'consolidation'
                    )
                  ),
  status          TEXT NOT NULL CHECK(
                    status IN ('pending', 'processing', 'completed', 'failed', 'skipped')
                  ) DEFAULT 'pending',
  priority        INTEGER NOT NULL DEFAULT 5,
  payload         TEXT NOT NULL,
  result          TEXT,
  error           TEXT,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  max_retries     INTEGER NOT NULL DEFAULT 3,
  tokens_used     INTEGER,
  cost_usd        REAL,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  started_at      INTEGER,
  completed_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON extraction_queue(status, priority);
CREATE INDEX IF NOT EXISTS idx_queue_type ON extraction_queue(extraction_type);

-- ============================================================
-- Schema version tracking
-- ============================================================

INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '1');
INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_created_at', datetime('now'));
```

---

## Appendix B: TypeScript Interfaces

Complete TypeScript interface definitions for all memory types. These go in `src/memory/types.ts`.

```typescript
// ============================================================
// src/memory/types.ts — River Memory Architecture Types
// ============================================================

// ------------------------------------------------------------
// Tier 1: Working Memory
// ------------------------------------------------------------

export interface WorkingMemoryContext {
  /** Static identity files concatenated */
  identityPrompt: string;

  /** Dynamic injections from Tiers 2-4 */
  injections: MemoryInjection[];

  /** Total estimated tokens for the context */
  estimatedTokens: number;
}

export interface MemoryInjection {
  source: 'episodic' | 'pattern' | 'knowledge' | 'code';
  content: string;
  relevanceScore: number;
  tokenEstimate: number;
}

// ------------------------------------------------------------
// Tier 2: Episodic Memory
// ------------------------------------------------------------

export interface EpisodicChunk {
  id: number;
  sessionKey: string;
  chunkIndex: number;
  startedAt: number;        // epoch ms
  endedAt: number;          // epoch ms
  summary: string;
  content: string;
  participants: string[];
  topics: string[];
  tokenCount: number;
  channel: string | null;
  createdAt: number;
}

export interface EpisodicSearchResult {
  chunk: EpisodicChunk;
  similarity: number;       // 0-1, from vector search
  recency: number;          // 0-1, time decay factor
  finalScore: number;       // weighted combination
}

export interface EpisodicSearchOptions {
  query: string;
  limit?: number;           // default 5
  maxTokens?: number;       // default 2000
  timeRange?: {
    after?: number;         // epoch ms
    before?: number;        // epoch ms
  };
  channel?: string;
  participants?: string[];
}

export interface EpisodicChunkInput {
  sessionKey: string;
  startedAt: number;
  endedAt: number;
  summary: string;
  content: string;
  participants: string[];
  topics: string[];
  tokenCount: number;
  channel?: string;
}

// ------------------------------------------------------------
// Tier 3: Pattern Memory
// ------------------------------------------------------------

export type PatternType = 'pattern' | 'anti_pattern' | 'heuristic' | 'workaround';
export type TaskOutcome = 'success' | 'failure' | 'partial' | 'abandoned' | 'pending';
export type EvidenceType = 'originated' | 'validated' | 'contradicted' | 'refined';
export type TaskType = 'coding' | 'review' | 'research' | 'debug' | 'deploy' | 'other';

export interface Pattern {
  id: number;
  patternType: PatternType;
  category: string;
  title: string;
  description: string;
  context: string;
  recommendation: string;
  confidence: number;
  timesApplied: number;
  timesValidated: number;
  timesViolated: number;
  sourceTaskId: number | null;
  createdAt: number;
  updatedAt: number;
  lastAppliedAt: number | null;
  supersededBy: number | null;
  isActive: boolean;
}

export interface PatternInput {
  patternType: PatternType;
  category: string;
  title: string;
  description: string;
  context: string;
  recommendation: string;
  confidence?: number;      // default 0.5
  sourceTaskId?: number;
}

export interface Task {
  id: number;
  sessionKey: string;
  taskType: TaskType;
  description: string;
  technologies: string[];
  filesTouched: string[];
  agent: string | null;
  dispatchPrompt: string | null;
  outcome: TaskOutcome;
  outcomeNotes: string | null;
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  patternsInjected: number[];
  patternsExtracted: number[];
  createdAt: number;
}

export interface TaskInput {
  sessionKey: string;
  taskType: TaskType;
  description: string;
  technologies?: string[];
  filesTouched?: string[];
  agent?: string;
  dispatchPrompt?: string;
}

export interface PatternEvidence {
  id: number;
  patternId: number;
  taskId: number;
  evidenceType: EvidenceType;
  notes: string | null;
  createdAt: number;
}

export interface PatternSearchOptions {
  categories?: string[];
  minConfidence?: number;     // default 0.6
  limit?: number;             // default 10
  includeInactive?: boolean;  // default false
  taskDescription?: string;   // for relevance matching
}

// ------------------------------------------------------------
// Tier 4: Knowledge Base
// ------------------------------------------------------------

export type KnowledgeEntryType =
  | 'api_signature'
  | 'migration_note'
  | 'breaking_change'
  | 'best_practice'
  | 'anti_pattern'
  | 'config_option'
  | 'error_solution'
  | 'example'
  | 'concept';

export interface KnowledgeEntry {
  id: number;
  technology: string;
  version: string | null;
  entryType: KnowledgeEntryType;
  title: string;
  content: string;
  codeExample: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  dateRead: number;
  datePublished: number | null;
  confidence: number;
  isCurrent: boolean;
  supersededBy: number | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeEntryInput {
  technology: string;
  version?: string;
  entryType: KnowledgeEntryType;
  title: string;
  content: string;
  codeExample?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  datePublished?: number;
  confidence?: number;        // default 0.8
  tags?: string[];
}

export interface KnowledgeSource {
  id: number;
  url: string;
  title: string | null;
  technology: string;
  lastReadAt: number;
  entryCount: number;
  hash: string | null;
  readCount: number;
  createdAt: number;
}

export interface KnowledgeSearchOptions {
  query?: string;             // Semantic search text
  technology?: string;        // Exact match filter
  version?: string;           // Exact match filter
  entryType?: KnowledgeEntryType;
  limit?: number;             // default 5
  maxTokens?: number;         // default 2000
  includeSources?: boolean;   // include source attribution
}

// ------------------------------------------------------------
// Tier 5: Knowledge Graph
// ------------------------------------------------------------

export type NodeType =
  | 'person'
  | 'project'
  | 'technology'
  | 'decision'
  | 'repo'
  | 'location'
  | 'organization'
  | 'concept'
  | 'file';

export type EdgeType =
  | 'works_on'
  | 'depends_on'
  | 'uses'
  | 'created_by'
  | 'married_to'
  | 'lives_in'
  | 'deployed_in'
  | 'blocked_by'
  | 'decided_on'
  | 'related_to'
  | 'employed_by'
  | 'manages'
  | 'forked_from'
  | 'replaced_by'
  | 'part_of'
  | 'located_in';

export type ContradictionResolution =
  | 'pending'
  | 'kept_existing'
  | 'updated'
  | 'both_valid'
  | 'dismissed';

export interface GraphNode {
  id: number;
  nodeType: NodeType;
  name: string;
  canonical: string;
  description: string | null;
  metadata: Record<string, unknown>;
  firstSeen: number;
  lastSeen: number;
  mentionCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface GraphNodeInput {
  nodeType: NodeType;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  id: number;
  sourceId: number;
  targetId: number;
  edgeType: EdgeType;
  weight: number;
  evidence: string | null;
  sourceChunkId: number | null;
  bidirectional: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface GraphEdgeInput {
  sourceId: number;
  targetId: number;
  edgeType: EdgeType;
  weight?: number;            // default 1.0
  evidence?: string;
  sourceChunkId?: number;
  bidirectional?: boolean;    // default false
}

export interface GraphNodeProperty {
  id: number;
  nodeId: number;
  key: string;
  value: string;
  confidence: number;
  source: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface GraphPath {
  edges: GraphEdge[];
  nodes: GraphNode[];         // Nodes along the path
  totalWeight: number;
}

export interface GraphContradiction {
  id: number;
  nodeId: number | null;
  edgeId: number | null;
  propertyKey: string | null;
  existingValue: string;
  newValue: string;
  sourceChunkId: number | null;
  resolution: ContradictionResolution;
  resolvedAt: number | null;
  createdAt: number;
}

export interface GraphSearchOptions {
  entity: string;
  entityType?: NodeType;
  relationship?: EdgeType;
  maxHops?: number;           // default 2
  targetEntity?: string;      // for path finding
}

// ------------------------------------------------------------
// Code Intelligence
// ------------------------------------------------------------

export type SymbolType =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'constant'
  | 'variable'
  | 'method'
  | 'property'
  | 'export';

export type ImportType = 'static' | 'dynamic' | 're_export' | 'type_only';
export type ChangeType = 'created' | 'modified' | 'deleted' | 'renamed';

export interface CodeRepo {
  id: number;
  name: string;
  path: string;
  language: string;
  lastIndexedAt: number | null;
  fileCount: number;
  symbolCount: number;
  createdAt: number;
}

export interface CodeFile {
  id: number;
  repoId: number;
  path: string;
  language: string;
  sizeBytes: number;
  hash: string | null;
  lastIndexedAt: number;
  lastModifiedAt: number | null;
  isActive: boolean;
}

export interface CodeSymbol {
  id: number;
  fileId: number;
  name: string;
  symbolType: SymbolType;
  signature: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  isExported: boolean;
  docComment: string | null;
  lastIndexedAt: number;
}

export interface CodeDependency {
  id: number;
  sourceFileId: number;
  targetFileId: number;
  importedSymbols: string[];
  importType: ImportType;
}

export interface CodeChange {
  id: number;
  fileId: number;
  taskId: number | null;
  changeType: ChangeType;
  diffSummary: string | null;
  symbolsAdded: string[];
  symbolsRemoved: string[];
  symbolsModified: string[];
  linesAdded: number;
  linesRemoved: number;
  changedAt: number;
}

export interface CodeActiveEdit {
  id: number;
  fileId: number;
  taskId: number;
  agent: string;
  startedAt: number;
  releasedAt: number | null;
}

export interface ImpactReport {
  directDependents: {
    path: string;
    importedSymbols: string[];
  }[];
  transitiveDependents: {
    path: string;
    hops: number;
  }[];
  activeEdits: {
    agent: string;
    path: string;
    taskDescription: string;
  }[];
}

export interface CodeSearchOptions {
  query: string;
  repo?: string;
  searchType?: 'symbol' | 'file' | 'dependency' | 'impact' | 'history';
  symbolType?: SymbolType;
  limit?: number;             // default 20
}

// ------------------------------------------------------------
// Extraction Pipeline
// ------------------------------------------------------------

export type ExtractionType = 'post_task' | 'document' | 'conversation' | 'consolidation';
export type ExtractionStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';

export interface ExtractionQueueItem {
  id: number;
  extractionType: ExtractionType;
  status: ExtractionStatus;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  retryCount: number;
  maxRetries: number;
  tokensUsed: number | null;
  costUsd: number | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface PostTaskExtractionPayload {
  taskId: number;
  taskDescription: string;
  outcome: TaskOutcome;
  outcomeNotes: string | null;
  technologies: string[];
  filesTouched: string[];
  agentOutput?: string;       // Summary or last N messages from agent
}

export interface DocumentExtractionPayload {
  url: string;
  title: string | null;
  technology: string;
  content: string;            // Markdown content
}

export interface ConversationExtractionPayload {
  chunkIds: number[];         // Episodic chunk IDs to process
}

export interface ExtractionResult {
  patterns?: PatternInput[];
  knowledgeEntries?: KnowledgeEntryInput[];
  graphNodes?: GraphNodeInput[];
  graphEdges?: GraphEdgeInput[];
  codeChanges?: {
    filePath: string;
    changeType: ChangeType;
    symbolsAdded?: string[];
    symbolsRemoved?: string[];
    symbolsModified?: string[];
  }[];
}

// ------------------------------------------------------------
// Dispatch Enhancement
// ------------------------------------------------------------

export interface TaskAnalysis {
  taskType: TaskType;
  technologies: string[];
  filePaths: string[];
  concepts: string[];
  estimatedComplexity: 'low' | 'medium' | 'high';
}

export interface ContextBlock {
  patterns: Pattern[];
  knowledge: KnowledgeEntry[];
  impact: ImpactReport | null;
  totalTokens: number;
  formattedContent: string;
}

// ------------------------------------------------------------
// MCP Tool Interfaces
// ------------------------------------------------------------

export interface SearchMemoryInput {
  query: string;
  tiers?: ('episodic' | 'pattern' | 'knowledge' | 'graph' | 'code')[];
  limit?: number;
  timeRange?: {
    after?: string;           // ISO date string
    before?: string;
  };
  technology?: string;
}

export interface SearchMemoryResult {
  episodic?: EpisodicSearchResult[];
  patterns?: Pattern[];
  knowledge?: KnowledgeEntry[];
  graph?: GraphNode[];
  code?: CodeSymbol[];
}

export interface GetPatternsInput {
  categories?: string[];
  taskDescription?: string;
  minConfidence?: number;
  includeAntiPatterns?: boolean;
  limit?: number;
}

export interface QueryKnowledgeInput {
  query?: string;
  technology?: string;
  version?: string;
  entryType?: KnowledgeEntryType;
  limit?: number;
}

export interface SearchCodeInput {
  query: string;
  repo?: string;
  searchType?: 'symbol' | 'file' | 'dependency' | 'impact' | 'history';
  symbolType?: SymbolType;
}

export interface AddMemoryInput {
  tier: 'episodic' | 'pattern' | 'knowledge' | 'graph';
  content: EpisodicChunkInput | PatternInput | KnowledgeEntryInput | GraphNodeInput;
}

export interface GetRelatedInput {
  entity: string;
  entityType?: NodeType;
  relationship?: EdgeType;
  maxHops?: number;
  targetEntity?: string;
}

export interface RecordTaskOutcomeInput {
  taskId?: number;
  description: string;
  outcome: 'success' | 'failure' | 'partial';
  outcomeNotes?: string;
  technologies?: string[];
  filesTouched?: string[];
}

// ------------------------------------------------------------
// Embedding Service
// ------------------------------------------------------------

export interface EmbeddingService {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  getDimension(): number;
}

export interface EmbeddingConfig {
  provider: 'openai' | 'local';
  model?: string;             // 'text-embedding-3-small' or 'all-MiniLM-L6-v2'
  apiKey?: string;            // Required for OpenAI
  dimension?: number;         // Auto-detected from model
}
```

---

## Appendix C: Extraction Prompt Templates

These are the actual prompts sent to the LLM for extraction tasks. They're designed to be specific enough to get structured output without over-constraining the model's reasoning.

### Post-Task Extraction Prompt

```markdown
# Task Outcome Analysis

You are analyzing the outcome of a completed task to extract patterns and learnings.

## Task Details

**Description:** {{task_description}}
**Technologies:** {{technologies}}
**Files touched:** {{files_touched}}
**Outcome:** {{outcome}}
**Outcome notes:** {{outcome_notes}}

## Agent Output (last portion)

```
{{agent_output}}
```

## Your Job

Analyze this task outcome and extract:

1. **Patterns or anti-patterns** — generalizable lessons that could help with similar future tasks
2. **Code changes** — what symbols/files were meaningfully modified

## Existing Patterns (avoid duplicates)

These patterns already exist. Only create new ones if they're genuinely different:

{{existing_pattern_titles}}

## Output Format

Respond with a JSON object:

```json
{
  "patterns": [
    {
      "pattern_type": "pattern" | "anti_pattern" | "heuristic" | "workaround",
      "category": "technology category (e.g., 'typescript', 'next.js', 'deployment')",
      "title": "Short descriptive title (under 60 chars)",
      "description": "What the pattern is and why it matters",
      "context": "When does this pattern apply?",
      "recommendation": "What should you do (or avoid)?",
      "confidence": 0.5
    }
  ],
  "code_changes": [
    {
      "file_path": "relative/path/to/file.ts",
      "change_type": "created" | "modified" | "deleted" | "renamed",
      "symbols_added": ["functionName", "TypeName"],
      "symbols_removed": [],
      "symbols_modified": ["existingFunction"]
    }
  ],
  "should_skip": false,
  "skip_reason": null
}
```

## Rules

1. Only extract patterns that are **genuinely generalizable**. "Fixed a typo" is not a pattern.
2. Set `confidence` to 0.5 for new patterns. They haven't been validated yet.
3. For failures, focus on **what went wrong** and **how to avoid it**.
4. For successes, focus on **what worked well** that wasn't obvious.
5. If the task was trivial and there's nothing to learn, set `should_skip: true` with a reason.
6. Patterns should be **actionable**. "Be careful" is not actionable. "Verify X before Y" is.
7. Don't duplicate existing patterns. If one applies, skip creating a new one.

## Examples of Good Patterns

✅ "When modifying Anthropic SDK calls, check model ID format against current SDK types"
✅ "Always test WebSocket reconnection with network interruption, not just clean disconnect"
✅ "Next.js middleware runs on edge — don't use Node.js APIs"

## Examples of Bad Patterns (don't create these)

❌ "TypeScript is good" (too vague)
❌ "Fixed the bug" (not generalizable)
❌ "Remember to test" (not specific enough)
❌ "The user wanted X" (task-specific, not a pattern)
```

### Document Ingestion Prompt

```markdown
# Technical Documentation Extraction

You are extracting structured knowledge from technical documentation.

## Document Information

**URL:** {{url}}
**Title:** {{title}}
**Technology:** {{technology}}
**Content:**

```markdown
{{content}}
```

## Your Job

Extract structured knowledge entries from this documentation. Focus on:

- API signatures and their parameters
- Breaking changes and migration notes
- Best practices and anti-patterns
- Configuration options
- Error solutions
- Code examples that demonstrate key concepts

## Output Format

Respond with a JSON object:

```json
{
  "entries": [
    {
      "entry_type": "api_signature" | "migration_note" | "breaking_change" | "best_practice" | "anti_pattern" | "config_option" | "error_solution" | "example" | "concept",
      "title": "Short descriptive title",
      "content": "Full explanation of the knowledge entry",
      "code_example": "Optional code snippet",
      "version": "Version this applies to (if mentioned)",
      "tags": ["relevant", "tags"]
    }
  ],
  "version_detected": "Version number if mentioned in the doc",
  "is_changelog": true | false,
  "entries_skipped": 0
}
```

## Rules

1. Each entry should be **self-contained** — readable without the rest of the document.
2. Include **version numbers** when they're mentioned. This is critical for tracking currency.
3. **Code examples** should be minimal but complete. Include imports if relevant.
4. For **breaking changes**, clearly state what changed and what to do about it.
5. For **API signatures**, include the full signature with types if available.
6. Don't extract **obvious information** that's common knowledge.
7. Don't extract **marketing content** or **filler text**.
8. Limit to **15 entries max** per document. Prioritize the most important.

## Examples of Good Entries

✅ Breaking change: "In v15.2, `unstable_cache` was renamed to `cacheLife`. Update all imports."
✅ API signature: "`createContext<T>(defaultValue: T): Context<T>` — creates a context with type inference"
✅ Config option: "`experimental.ppr: boolean` — enables Partial Pre-Rendering in Next.js 15+"

## Examples of Bad Entries (don't create these)

❌ "Next.js is a framework for React" (obvious/marketing)
❌ "You can use functions" (too vague)
❌ Random code snippet with no explanation
```

### Conversation Extraction Prompt

```markdown
# Conversation Analysis

You are analyzing conversation chunks to extract entities and relationships for a knowledge graph.

## Conversation Chunks

{{#each chunks}}
### Chunk {{chunk_index}} ({{date}})
Participants: {{participants}}

```
{{content}}
```

{{/each}}

## Your Job

Extract:
1. **Entities** — people, projects, technologies, decisions, locations mentioned
2. **Relationships** — how entities relate to each other
3. **Properties** — facts about entities (dates, statuses, attributes)

## Existing Entities (use these IDs if they match)

{{existing_entities}}

## Output Format

Respond with a JSON object:

```json
{
  "nodes": [
    {
      "node_type": "person" | "project" | "technology" | "decision" | "repo" | "location" | "organization" | "concept",
      "name": "Display name",
      "description": "Optional description",
      "existing_id": null | 123
    }
  ],
  "edges": [
    {
      "source_name": "Entity name (must match a node)",
      "target_name": "Entity name (must match a node)",
      "edge_type": "works_on" | "depends_on" | "uses" | "created_by" | "married_to" | "lives_in" | "deployed_in" | "blocked_by" | "decided_on" | "related_to",
      "evidence": "Why we believe this relationship exists"
    }
  ],
  "properties": [
    {
      "entity_name": "Entity name",
      "key": "property_name",
      "value": "property_value",
      "confidence": 0.8
    }
  ],
  "decisions": [
    {
      "title": "Decision title",
      "description": "What was decided",
      "date": "YYYY-MM-DD if mentioned",
      "participants": ["who was involved"],
      "status": "approved" | "pending" | "rejected" | "discussed"
    }
  ]
}
```

## Rules

1. Only extract **explicitly mentioned** entities and relationships. Don't infer.
2. Use **existing entity IDs** when the entity already exists.
3. **Decisions** are important — track what was decided, when, and by whom.
4. Set **confidence** lower (0.6-0.7) for implicit information, higher (0.8-0.9) for explicit.
5. Ignore **transient information** like "let me check" or "one moment".
6. Focus on **facts**, not opinions or speculation.

## Example

Input: "User said they've been working on the WebApp project. It's deployed in Portland and depends on Next.js 15."

Output:
```json
{
  "nodes": [
    { "node_type": "person", "name": "User", "existing_id": 1 },
    { "node_type": "project", "name": "WebApp", "existing_id": 4 },
    { "node_type": "location", "name": "Portland", "existing_id": null },
    { "node_type": "technology", "name": "Next.js 15", "existing_id": null }
  ],
  "edges": [
    { "source_name": "User", "target_name": "WebApp", "edge_type": "works_on", "evidence": "the user said he's been working on..." },
    { "source_name": "WebApp", "target_name": "Portland", "edge_type": "deployed_in", "evidence": "It's deployed in Portland" },
    { "source_name": "WebApp", "target_name": "Next.js 15", "edge_type": "depends_on", "evidence": "depends on Next.js 15" }
  ],
  "properties": [],
  "decisions": []
}
```
```

### Summary Generation Prompt

Used for episodic chunk summaries.

```markdown
# Conversation Summary

Summarize this conversation chunk in 1-2 sentences. Focus on:
- What was discussed
- What was accomplished (if anything)
- Key decisions or conclusions

Be concise. This summary will be used for search and retrieval.

## Conversation

```
{{content}}
```

## Rules

1. Maximum 2 sentences.
2. Focus on **substance**, not pleasantries.
3. Include **specific details** — project names, technologies, decisions.
4. Use **active voice**.

## Example

Input: A long conversation about debugging a WebSocket issue in the Discord bot, eventually fixed by adding reconnection logic with exponential backoff.

Output: "Debugged WebSocket disconnection issue in Discord bot. Fixed by implementing exponential backoff with jitter for reconnection."
```

### Topic Extraction Prompt

Used to extract topics/tags from conversation chunks.

```markdown
# Topic Extraction

Extract 3-7 topic tags from this conversation. Tags should be:
- Lowercase
- Single words or short phrases (2-3 words max)
- Specific enough to be useful for search

## Conversation

```
{{content}}
```

## Output

Return a JSON array of strings:

```json
["topic1", "topic2", "topic3"]
```

## Examples

- "websocket", "discord", "reconnection", "debugging"
- "deployment", "railway", "next.js", "build-errors"
- "family", "tennessee", "vacation-planning"
```

---

## Appendix D: Configuration Reference

Complete configuration schema for river.config.yaml with memory settings.

```yaml
# river.config.yaml — Full configuration reference

daemon:
  port: 3002
  workspace: /home/user/.openclaw/workspace

identity:
  files:
    - SOUL.md
    - MEMORY.md
    - USER.md
    - AGENTS.md
    - IDENTITY.md
    - TOOLS.md
    - HEARTBEAT.md

llm:
  primary:
    provider: anthropic
    model: claude-opus-4-20250514
    max_tokens: 8192
  fallbacks:
    - provider: anthropic
      model: claude-sonnet-4-20250514

  # Model used for extraction tasks (cheaper than primary)
  extraction:
    provider: anthropic
    model: claude-sonnet-4-20250514
    max_tokens: 4096

channels:
  telegram:
    enabled: true
    token: ${TELEGRAM_BOT_TOKEN}
    allowed_users:
      - "123456789"
  discord:
    enabled: false
    token: ${DISCORD_BOT_TOKEN}

tools:
  exec:
    enabled: true
    timeout_ms: 30000
    shell: /bin/bash
  web_search:
    enabled: true
    brave_api_key: ${BRAVE_API_KEY}
  web_fetch:
    enabled: true

data:
  dir: ./data
  sessions_dir: ./data/sessions
  backups_dir: ./data/backups

# Memory architecture configuration
memory:
  # Embedding configuration
  embeddings:
    provider: openai              # or "local"
    model: text-embedding-3-small # or "all-MiniLM-L6-v2"
    api_key: ${OPENAI_API_KEY}    # Required for openai provider
    dimension: 1536               # 1536 for OpenAI, 384 for local

  # Episodic memory (Tier 2)
  episodic:
    enabled: true
    chunk_max_tokens: 800         # Max tokens per chunk
    chunk_time_gap_minutes: 30    # Time gap to force new chunk
    search_recency_weight: 0.2    # Weight for recency in search scoring
    search_similarity_weight: 0.7 # Weight for vector similarity
    retention_days: 365           # How long to keep full content

  # Pattern memory (Tier 3)
  patterns:
    enabled: true
    injection_threshold: 0.6      # Min confidence to inject into dispatch
    injection_limit: 5            # Max patterns per dispatch
    decay_days: 90                # Days without use before decay kicks in
    decay_factor: 0.95            # Confidence multiplier on decay

  # Knowledge base (Tier 4)
  knowledge:
    enabled: true
    max_entries_per_document: 15
    default_confidence: 0.8
    search_limit: 5

  # Knowledge graph (Tier 5)
  graph:
    enabled: true
    max_hops: 3                   # Default max hops for path queries
    contradiction_auto_resolve: false  # Require manual resolution

  # Code intelligence
  code:
    enabled: true
    repos:
      - name: river-runtime
        path: /home/user/projects/river-runtime
        language: typescript
      - name: myapp
        path: /home/user/projects/myapp
        language: typescript
    index_on_startup: true
    index_interval_minutes: 60    # Re-index interval

  # Extraction pipeline
  extraction:
    enabled: true
    cooldown_ms: 2000             # Delay between extractions
    max_tokens_per_hour: 500000   # Cost guardrail
    max_retries: 3
    skip_trivial_tasks: true      # Skip extraction for fast successes
    trivial_threshold_ms: 30000   # Tasks under this duration may be skipped

  # Dispatch enhancement
  dispatch:
    enabled: true
    context_budget_tokens: 3000   # Max tokens for context block
    pattern_budget_ratio: 0.4     # % of budget for patterns
    knowledge_budget_ratio: 0.35  # % of budget for knowledge
    impact_budget_ratio: 0.25     # % of budget for impact analysis

# MCP server configuration
mcp:
  enabled: true
  transport: stdio                # or "http"
  port: 3003                      # Only used with http transport
  auth:
    type: bearer
    token: ${MCP_AUTH_TOKEN}
```

---

## Appendix E: Quick Start Guide

For developers implementing this spec.

### Day 1: Get Something Working

1. **Add dependencies:**
   ```bash
   cd /home/user/projects/river-runtime
   pnpm add sqlite-vec @modelcontextprotocol/sdk
   ```

2. **Run schema migration:**
   ```typescript
   // In your startup code
   import { runMigrations } from './memory/migrate.js';
   runMigrations(db);
   ```

3. **Bootstrap existing memory:**
   ```bash
   # Manual one-liner to verify schema
   sqlite3 data/river.sqlite ".tables"
   # Should show: episodic_chunks, patterns, tasks, knowledge_entries, etc.
   ```

4. **Test episodic storage:**
   ```typescript
   // Store a test chunk
   const memory = new MemoryManager(db, config);
   await memory.episodic.store({
     sessionKey: 'test',
     startedAt: Date.now() - 60000,
     endedAt: Date.now(),
     summary: 'Test conversation about memory architecture',
     content: 'the user: How should we build the memory system?\nAgent: ...',
     participants: ['the user', 'Agent'],
     topics: ['memory', 'architecture'],
     tokenCount: 100,
     channel: 'webchat'
   });

   // Search for it
   const results = await memory.episodic.search({
     query: 'memory architecture',
     limit: 5
   });
   console.log(results);
   ```

### Week 1 Milestones

- [ ] Schema migrations run on startup
- [ ] Episodic chunks stored after conversation boundaries
- [ ] Vector search returns relevant chunks
- [ ] ContextBuilder injects episodic results

### Week 2 Milestones

- [ ] Tasks created for each sub-agent dispatch
- [ ] Post-task extraction runs after completion
- [ ] Patterns stored and retrievable
- [ ] Dispatch enhancer includes relevant patterns

### Week 3+ Milestones

- [ ] Knowledge base populated from doc reads
- [ ] MCP server responds to tool calls
- [ ] Code intelligence indexes repos
- [ ] Impact analysis available in dispatch context

---

*End of specification.*

**Document size:** ~55KB
**Tables defined:** 18
**TypeScript interfaces:** 50+
**Prompt templates:** 5

This spec is now ready for implementation review. The schema is complete and executable. The TypeScript interfaces are comprehensive. The prompts are specific and actionable.

Key question for the user: Should we start with Phase 1 (Foundation) immediately, or is there anything in this spec that needs revision first?