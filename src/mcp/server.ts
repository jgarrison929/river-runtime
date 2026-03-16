/**
 * MCP Server — exposes River's brain to external tools via HTTP.
 *
 * Provides a simple JSON-RPC-style API mounted on the existing Fastify
 * health server at /mcp/*.  Any tool (Claude Code, Codex, external agents,
 * etc.) can call these endpoints with plain HTTP.
 *
 * Tools exposed:
 *   search_memory, get_patterns, query_knowledge, search_code,
 *   impact_analysis, query_graph, add_memory, record_task_outcome,
 *   get_brain_stats
 */

import type { FastifyInstance } from 'fastify';
import type { EpisodicMemory } from '../memory/episodic.js';
import type { PatternStore, Pattern } from '../memory/patterns.js';
import type { KnowledgeBase } from '../memory/knowledge.js';
import type { CodeIndex } from '../memory/code-index.js';
import type { KnowledgeGraph } from '../memory/graph.js';
import type { LineageTracker } from '../memory/lineage.js';
import { logger } from '../utils/logger.js';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface McpDeps {
  episodicMemory: EpisodicMemory;
  patternStore: PatternStore;
  knowledgeBase: KnowledgeBase;
  codeIndex: CodeIndex;
  knowledgeGraph: KnowledgeGraph;
  lineageTracker: LineageTracker;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolCallRequest {
  name: string;
  arguments: Record<string, unknown>;
}

interface ToolCallResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

// ────────────────────────────────────────────────────────────────────
// MCP Server
// ────────────────────────────────────────────────────────────────────

export class McpServer {
  private deps: McpDeps;
  private tools: Map<string, { definition: ToolDefinition; handler: ToolHandler }> = new Map();

  constructor(deps: McpDeps) {
    this.deps = deps;
    this.registerTools();
    logger.info('MCP server initialized', { toolCount: this.tools.size });
  }

  /** Mount routes on an existing Fastify instance. */
  mount(app: FastifyInstance): void {
    // POST /mcp/tools/list — list available tools
    app.post('/mcp/tools/list', async () => {
      const tools = Array.from(this.tools.values()).map((t) => t.definition);
      return { tools };
    });

    // POST /mcp/tools/call — call a specific tool
    app.post<{ Body: ToolCallRequest }>('/mcp/tools/call', async (request, reply) => {
      const { name, arguments: args } = request.body ?? {};

      if (!name || typeof name !== 'string') {
        reply.status(400);
        return { error: 'Missing required field: name' };
      }

      const tool = this.tools.get(name);
      if (!tool) {
        reply.status(404);
        return { error: `Unknown tool: ${name}` };
      }

      try {
        const result = await tool.handler(args ?? {});
        const response: ToolCallResponse = {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
        return response;
      } catch (err) {
        logger.error('MCP tool call failed', {
          tool: name,
          error: err instanceof Error ? err.message : String(err),
        });
        reply.status(500);
        const response: ToolCallResponse = {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
        return response;
      }
    });

    // GET /mcp/health — MCP-specific health check
    app.get('/mcp/health', async () => {
      return {
        status: 'ok',
        tools: this.tools.size,
        toolNames: Array.from(this.tools.keys()),
      };
    });

    logger.info('MCP routes mounted', { routes: ['/mcp/tools/list', '/mcp/tools/call', '/mcp/health'] });
  }

  // ──────────────────────────────────────────────────────────────────
  // Tool Registration
  // ──────────────────────────────────────────────────────────────────

  private registerTools(): void {
    this.registerSearchMemory();
    this.registerGetPatterns();
    this.registerQueryKnowledge();
    this.registerSearchCode();
    this.registerImpactAnalysis();
    this.registerQueryGraph();
    this.registerAddMemory();
    this.registerRecordTaskOutcome();
    this.registerGetBrainStats();
    this.registerGetPatternLineage();
    this.registerGetLineageStats();
  }

  // ── search_memory ────────────────────────────────────────────────

  private registerSearchMemory(): void {
    this.tools.set('search_memory', {
      definition: {
        name: 'search_memory',
        description: 'Semantic search across episodic memory. Returns past conversations and observations.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Max results (default: 10)' },
            min_similarity: { type: 'number', description: 'Minimum similarity 0-1 (default: 0.3)' },
          },
          required: ['query'],
        },
      },
      handler: async (args) => {
        const query = String(args['query'] ?? '');
        const limit = typeof args['limit'] === 'number' ? args['limit'] : 10;
        const minSimilarity = typeof args['min_similarity'] === 'number' ? args['min_similarity'] : 0.3;

        const results = await this.deps.episodicMemory.search(query, limit, minSimilarity);
        return {
          results: results.map((r) => ({
            content: r.episode.content.length > 1000
              ? r.episode.content.slice(0, 1000) + '...'
              : r.episode.content,
            summary: r.episode.summary,
            similarity: Math.round(r.similarity * 100) / 100,
            created_at: r.episode.createdAt,
          })),
        };
      },
    });
  }

  // ── get_patterns ─────────────────────────────────────────────────

  private registerGetPatterns(): void {
    this.tools.set('get_patterns', {
      definition: {
        name: 'get_patterns',
        description: 'Get relevant coding patterns for a task, filtered by technology.',
        inputSchema: {
          type: 'object',
          properties: {
            technologies: {
              type: 'array',
              items: { type: 'string' },
              description: 'Technologies to filter by',
            },
            task_description: { type: 'string', description: 'Description of the task' },
            limit: { type: 'number', description: 'Max patterns (default: 20)' },
          },
        },
      },
      handler: async (args) => {
        const technologies = Array.isArray(args['technologies'])
          ? (args['technologies'] as string[])
          : [];
        const taskDescription = typeof args['task_description'] === 'string'
          ? args['task_description']
          : '';
        const limit = typeof args['limit'] === 'number' ? args['limit'] : 20;

        let patterns: Pattern[];
        if (technologies.length > 0 || taskDescription) {
          patterns = this.deps.patternStore.getRelevantPatterns(technologies, taskDescription);
        } else {
          patterns = this.deps.patternStore.getTopPatterns(limit);
        }

        // Filter to only active patterns with decent confidence
        patterns = patterns
          .filter((p) => {
            const row = this.getPatternStatus(p.id);
            return row !== 'disputed' && row !== 'archived';
          })
          .filter((p) => p.confidence >= 0.3)
          .slice(0, limit);

        return {
          patterns: patterns.map((p) => ({
            title: p.title,
            description: p.description,
            type: p.type,
            confidence: p.confidence,
            correct_approach: p.correct_approach,
            incorrect_approach: p.incorrect_approach,
          })),
        };
      },
    });
  }

  /** Helper: get pattern status from the DB (handles column not existing). */
  private getPatternStatus(id: string): string {
    try {
      const row = this.deps.patternStore['db']
        .prepare('SELECT status FROM patterns WHERE id = ?')
        .get(id) as { status: string } | undefined;
      return row?.status ?? 'active';
    } catch {
      // Column doesn't exist yet — treat all as active
      return 'active';
    }
  }

  // ── query_knowledge ──────────────────────────────────────────────

  private registerQueryKnowledge(): void {
    this.tools.set('query_knowledge', {
      definition: {
        name: 'query_knowledge',
        description: 'Search the technical knowledge base for API signatures, breaking changes, best practices.',
        inputSchema: {
          type: 'object',
          properties: {
            technology: { type: 'string', description: 'Technology name (e.g. "react", "typescript")' },
            query: { type: 'string', description: 'Optional text search within the technology' },
            entry_type: { type: 'string', description: 'Filter by type: api_signature, migration_note, breaking_change, best_practice, anti_pattern, concept, example' },
            version: { type: 'string', description: 'Filter by version' },
          },
          required: ['technology'],
        },
      },
      handler: async (args) => {
        const technology = String(args['technology'] ?? '');
        const version = typeof args['version'] === 'string' ? args['version'] : undefined;
        const entryType = typeof args['entry_type'] === 'string'
          ? args['entry_type'] as 'api_signature' | 'migration_note' | 'breaking_change' | 'best_practice' | 'anti_pattern' | 'concept' | 'example'
          : undefined;

        const entries = this.deps.knowledgeBase.findEntries(technology, version, entryType);

        return {
          entries: entries.map((e) => ({
            title: e.title,
            content: e.content,
            code_example: e.code_example,
            entry_type: e.entry_type,
            version: e.version,
            confidence: e.confidence,
          })),
        };
      },
    });
  }

  // ── search_code ──────────────────────────────────────────────────

  private registerSearchCode(): void {
    this.tools.set('search_code', {
      definition: {
        name: 'search_code',
        description: 'Search the code index for symbols, files, and dependencies.',
        inputSchema: {
          type: 'object',
          properties: {
            symbol_name: { type: 'string', description: 'Symbol name to find' },
            file_path: { type: 'string', description: 'File path to inspect' },
            repo: { type: 'string', description: 'Repository name filter' },
          },
        },
      },
      handler: async (args) => {
        const symbolName = typeof args['symbol_name'] === 'string' ? args['symbol_name'] : undefined;
        const filePath = typeof args['file_path'] === 'string' ? args['file_path'] : undefined;

        const result: {
          symbols: Array<{ name: string; type: string; file: string; signature: string | null; exported: boolean }>;
          dependencies: Array<{ target: string; imports: string[] }>;
          dependents: Array<{ path: string }>;
        } = {
          symbols: [],
          dependencies: [],
          dependents: [],
        };

        if (symbolName) {
          const symbols = this.deps.codeIndex.findSymbol(symbolName);
          result.symbols = symbols.map((s) => ({
            name: s.name,
            type: s.type,
            file: s.filePath,
            signature: s.signature,
            exported: s.exported,
          }));
        }

        if (filePath) {
          const symbols = this.deps.codeIndex.getFileSymbols(filePath);
          for (const s of symbols) {
            result.symbols.push({
              name: s.name,
              type: s.type,
              file: filePath,
              signature: s.signature,
              exported: s.exported,
            });
          }

          const deps = this.deps.codeIndex.getDependencies(filePath);
          result.dependencies = deps.map((d) => ({
            target: d.targetPath,
            imports: d.importNames,
          }));

          const dependents = this.deps.codeIndex.getDependents(filePath);
          result.dependents = dependents.map((d) => ({ path: d.path }));
        }

        return result;
      },
    });
  }

  // ── impact_analysis ──────────────────────────────────────────────

  private registerImpactAnalysis(): void {
    this.tools.set('impact_analysis', {
      definition: {
        name: 'impact_analysis',
        description: 'Analyze the impact of changing specific files. Returns affected files, symbols, and risk level.',
        inputSchema: {
          type: 'object',
          properties: {
            file_paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'File paths being changed',
            },
            repo: { type: 'string', description: 'Repository name' },
          },
          required: ['file_paths'],
        },
      },
      handler: async (args) => {
        const filePaths = Array.isArray(args['file_paths'])
          ? (args['file_paths'] as string[])
          : [];

        if (filePaths.length === 0) {
          return { affected_files: [], affected_symbols: [], risk_level: 'none' };
        }

        const impact = this.deps.codeIndex.getImpactAnalysis(filePaths);

        const totalAffected =
          impact.directDependents.length + impact.transitiveDependents.length;

        let riskLevel: string;
        if (totalAffected === 0) {
          riskLevel = 'low';
        } else if (totalAffected <= 5) {
          riskLevel = 'medium';
        } else if (totalAffected <= 15) {
          riskLevel = 'high';
        } else {
          riskLevel = 'critical';
        }

        return {
          affected_files: [
            ...impact.directDependents.map((f) => ({ path: f, level: 'direct' })),
            ...impact.transitiveDependents.map((f) => ({ path: f, level: 'transitive' })),
          ],
          affected_symbols: impact.affectedSymbols,
          risk_level: riskLevel,
        };
      },
    });
  }

  // ── query_graph ──────────────────────────────────────────────────

  private registerQueryGraph(): void {
    this.tools.set('query_graph', {
      definition: {
        name: 'query_graph',
        description: 'Query the knowledge graph for entities and their relationships.',
        inputSchema: {
          type: 'object',
          properties: {
            entity: { type: 'string', description: 'Entity name to query' },
            relationship: { type: 'string', description: 'Optional relationship type filter' },
            depth: { type: 'number', description: 'How many hops to traverse (default: 1)' },
          },
          required: ['entity'],
        },
      },
      handler: async (args) => {
        const entity = String(args['entity'] ?? '');
        const relationship = typeof args['relationship'] === 'string' ? args['relationship'] : undefined;
        const depth = typeof args['depth'] === 'number' ? args['depth'] : 1;

        const node = this.deps.knowledgeGraph.getNode(entity);
        if (!node) {
          return { node: null, neighbors: [], paths: [] };
        }

        const neighbors = this.deps.knowledgeGraph.getNeighbors(entity, depth);

        // If a relationship filter is specified, also get related entities
        const related = relationship
          ? this.deps.knowledgeGraph.getRelated(entity, relationship)
          : [];

        return {
          node: {
            name: node.name,
            type: node.type,
            properties: node.properties,
            importance: node.importance,
            mentionCount: node.mentionCount,
          },
          neighbors: neighbors.map((n) => ({
            name: n.name,
            type: n.type,
            importance: n.importance,
          })),
          edges: node.edges.map((e) => ({
            relationship: e.relationship,
            target: e.connectedNode.name,
            targetType: e.connectedNode.type,
            confidence: e.confidence,
          })),
          related: related.map((r) => ({
            name: r.node.name,
            type: r.node.type,
            relationship: r.relationship,
            direction: r.direction,
          })),
        };
      },
    });
  }

  // ── add_memory ───────────────────────────────────────────────────

  private registerAddMemory(): void {
    this.tools.set('add_memory', {
      definition: {
        name: 'add_memory',
        description: 'Store a new memory, observation, pattern, or knowledge entry.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Content to store' },
            type: {
              type: 'string',
              enum: ['episode', 'pattern', 'knowledge'],
              description: 'Type of memory to store',
            },
            metadata: {
              type: 'object',
              description: 'Additional metadata (technology, tags, importance, etc.)',
            },
          },
          required: ['content', 'type'],
        },
      },
      handler: async (args) => {
        const content = String(args['content'] ?? '');
        const type = String(args['type'] ?? 'episode');
        const metadata = (args['metadata'] ?? {}) as Record<string, unknown>;

        let id: string;

        switch (type) {
          case 'episode': {
            id = await this.deps.episodicMemory.addEpisode({
              sessionKey: (metadata['session_key'] as string) ?? 'mcp:external',
              content,
              summary: metadata['summary'] as string | undefined,
              participant: metadata['participant'] as string | undefined,
              channel: metadata['channel'] as string | undefined,
              topics: metadata['topics'] as string[] | undefined,
              importance: typeof metadata['importance'] === 'number' ? metadata['importance'] : 0.5,
            });
            break;
          }
          case 'pattern': {
            id = this.deps.patternStore.addPattern({
              type: (metadata['pattern_type'] as 'pattern' | 'anti_pattern' | 'lesson') ?? 'lesson',
              title: (metadata['title'] as string) ?? content.slice(0, 100),
              description: content,
              technology: metadata['technology'] as string | undefined,
              context: metadata['context'] as string | undefined,
              correct_approach: metadata['correct_approach'] as string | undefined,
              incorrect_approach: metadata['incorrect_approach'] as string | undefined,
              confidence: typeof metadata['confidence'] === 'number' ? metadata['confidence'] : 0.5,
              tags: metadata['tags'] as string[] | undefined,
            });
            break;
          }
          case 'knowledge': {
            id = this.deps.knowledgeBase.addEntry({
              technology: (metadata['technology'] as string) ?? 'general',
              entry_type: (metadata['entry_type'] as 'concept') ?? 'concept',
              title: (metadata['title'] as string) ?? content.slice(0, 100),
              content,
              version: metadata['version'] as string | undefined,
              code_example: metadata['code_example'] as string | undefined,
              confidence: typeof metadata['confidence'] === 'number' ? metadata['confidence'] : 0.7,
              tags: metadata['tags'] as string[] | undefined,
            });
            break;
          }
          default:
            throw new Error(`Unknown memory type: ${type}`);
        }

        return { id, stored: true };
      },
    });
  }

  // ── record_task_outcome ──────────────────────────────────────────

  private registerRecordTaskOutcome(): void {
    this.tools.set('record_task_outcome', {
      definition: {
        name: 'record_task_outcome',
        description: 'Record the result of a coding task for pattern extraction.',
        inputSchema: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Task description' },
            outcome: {
              type: 'string',
              enum: ['success', 'partial', 'failure'],
              description: 'Task outcome',
            },
            approach: { type: 'string', description: 'What approach was taken' },
            issues: { type: 'string', description: 'Issues encountered' },
            fix: { type: 'string', description: 'What fixed the issues' },
            technologies: {
              type: 'array',
              items: { type: 'string' },
              description: 'Technologies used',
            },
          },
          required: ['task', 'outcome', 'approach'],
        },
      },
      handler: async (args) => {
        const task = String(args['task'] ?? '');
        const outcome = String(args['outcome'] ?? 'partial') as 'success' | 'partial' | 'failure';
        const approach = String(args['approach'] ?? '');
        const issues = typeof args['issues'] === 'string' ? args['issues'] : undefined;
        const fix = typeof args['fix'] === 'string' ? args['fix'] : undefined;
        const technologies = Array.isArray(args['technologies'])
          ? (args['technologies'] as string[])
          : [];

        const id = this.deps.patternStore.addTaskOutcome({
          task_description: task,
          approach,
          technologies,
          outcome,
          issues,
          fix,
        });

        // Count patterns that might be extractable (rough heuristic)
        const patternsExtracted = outcome === 'failure' && issues ? 1 : 0;

        return { id, patterns_extracted: patternsExtracted };
      },
    });
  }

  // ── get_brain_stats ──────────────────────────────────────────────

  private registerGetBrainStats(): void {
    this.tools.set('get_brain_stats', {
      definition: {
        name: 'get_brain_stats',
        description: 'Get overview stats for all memory tiers (episodes, patterns, knowledge, graph, code).',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => {
        const episodicStats = this.deps.episodicMemory.getStats();
        const patternStats = this.deps.patternStore.getStats();
        const knowledgeStats = this.deps.knowledgeBase.getStats();
        const codeStats = this.deps.codeIndex.getStats();
        const graphStats = this.deps.knowledgeGraph.getStats();
        const lineageStats = this.deps.lineageTracker.getStats();

        // Find the most impactful pattern name for the summary
        let mostImpactfulSummary: string | undefined;
        if (lineageStats.mostImpactful.length > 0) {
          const top = lineageStats.mostImpactful[0]!;
          const pattern = this.deps.patternStore.getById(top.patternId);
          if (pattern) {
            const rate = Math.round(top.successRate * 100);
            mostImpactfulSummary = `${pattern.title} (${top.totalInjections} injections, ${rate}% success)`;
          }
        }

        return {
          episodes: episodicStats.totalEpisodes,
          episodic: {
            total: episodicStats.totalEpisodes,
            dateRange: episodicStats.dateRange,
            byChannel: episodicStats.byChannel,
          },
          patterns: {
            total: patternStats.total,
            byType: patternStats.byType,
            averageConfidence: Math.round(patternStats.averageConfidence * 100) / 100,
          },
          knowledge_entries: {
            total: knowledgeStats.totalEntries,
            current: knowledgeStats.currentEntries,
            superseded: knowledgeStats.supersededEntries,
            byTechnology: knowledgeStats.byTechnology,
          },
          graph_nodes: graphStats.nodeCount,
          graph_edges: graphStats.edgeCount,
          graph: {
            nodes: graphStats.nodeCount,
            edges: graphStats.edgeCount,
            nodesByType: graphStats.nodesByType,
          },
          code_symbols: codeStats.symbols,
          code: {
            repos: codeStats.repos,
            files: codeStats.files,
            symbols: codeStats.symbols,
            dependencies: codeStats.dependencies,
          },
          task_outcomes: patternStats.totalOutcomes,
          lineage: {
            totalEvents: lineageStats.totalEvents,
            extractions: lineageStats.byType['extracted'] ?? 0,
            injections: lineageStats.byType['injected'] ?? 0,
            validations: (lineageStats.byType['validated'] ?? 0) + (lineageStats.byType['contradicted'] ?? 0),
            mostImpactful: mostImpactfulSummary,
          },
        };
      },
    });
  }

  // ── get_pattern_lineage ──────────────────────────────────────────

  private registerGetPatternLineage(): void {
    this.tools.set('get_pattern_lineage', {
      definition: {
        name: 'get_pattern_lineage',
        description: 'Get the provenance chain for a pattern — where it came from, what it influenced, and its success rate.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern_id: { type: 'string', description: 'Pattern ID to trace' },
            depth: { type: 'number', description: 'How deep to follow the chain (default: 3)' },
            include_stats: { type: 'boolean', description: 'Include impact statistics' },
          },
          required: ['pattern_id'],
        },
      },
      handler: async (args) => {
        const patternId = String(args['pattern_id'] ?? '');
        const depth = typeof args['depth'] === 'number' ? args['depth'] : 3;
        const includeStats = args['include_stats'] === true;

        const chain = this.deps.lineageTracker.getPatternChain(patternId, depth);
        if (!chain) {
          return { error: `Pattern not found: ${patternId}` };
        }

        const result: Record<string, unknown> = {
          pattern: chain.pattern,
          events: chain.events,
          children: chain.children.map((c) => ({
            pattern: c.pattern,
            eventCount: c.events.length,
          })),
          parents: chain.parents.map((p) => ({
            pattern: p.pattern,
            eventCount: p.events.length,
          })),
        };

        if (includeStats) {
          result['impact'] = this.deps.lineageTracker.getPatternImpact(patternId);
        }

        return result;
      },
    });
  }

  // ── get_lineage_stats ────────────────────────────────────────────

  private registerGetLineageStats(): void {
    this.tools.set('get_lineage_stats', {
      definition: {
        name: 'get_lineage_stats',
        description: 'Get an overview of pattern lineage — total events, breakdown by type, most impactful patterns, recent activity.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => {
        const stats = this.deps.lineageTracker.getStats();

        // Enrich mostImpactful with pattern titles
        const enriched = stats.mostImpactful.map((impact) => {
          const pattern = this.deps.patternStore.getById(impact.patternId);
          return {
            ...impact,
            patternTitle: pattern?.title ?? 'Unknown',
          };
        });

        return {
          totalEvents: stats.totalEvents,
          byType: stats.byType,
          mostImpactful: enriched,
          recentActivity: stats.recentActivity.slice(0, 10),
        };
      },
    });
  }
}
