/**
 * river-runtime — Main daemon entry point.
 *
 * Starts the agent daemon:
 * 1. Load config from river.config.yaml
 * 2. Initialize components (LLM, tools, channels, sessions, memory)
 * 3. Wire everything together
 * 4. Start health server and channels
 * 5. Handle graceful shutdown
 */

import { loadConfig } from './config.js';
import { logger, setLogLevel } from './utils/logger.js';
import { createHealthServer, listenHealthServer, setHealthStatusProvider } from './utils/health.js';
import { ChannelRouter } from './channels/router.js';
import { TelegramAdapter } from './channels/telegram.js';
import { DiscordAdapter } from './channels/discord.js';
import { WebchatAdapter } from './channels/webchat.js';
import { LLMRouter } from './llm/router.js';
import { ToolRegistry } from './tools/registry.js';
import { createReadTool, createWriteTool, createEditTool } from './tools/filesystem.js';
import { createExecTool } from './tools/exec.js';
import { createWebSearchTool, createWebFetchTool } from './tools/web.js';
import { MemoryStore, createMemorySearchTool } from './memory/store.js';
import { PatternStore } from './memory/patterns.js';
import { KnowledgeBase } from './memory/knowledge.js';
import { DocumentIngestion } from './memory/ingestion.js';
import { ExtractionPipeline } from './memory/extraction.js';
import { seedPatterns } from './memory/seed-patterns.js';
import { CodeIndex } from './memory/code-index.js';
import { KnowledgeGraph } from './memory/graph.js';
import { seedGraph } from './memory/seed-graph.js';
import { createIngestDocsTool, createQueryKnowledgeTool } from './tools/knowledge-tool.js';
import {
  createScreenshotTool,
  createClickTool,
  createTypeTool,
  createPressKeyTool,
  createListWindowsTool,
  createFocusWindowTool,
  createMouseMoveTool,
  createMouseScrollTool,
} from './tools/computer-tools.js';
import { GitNexusBridge } from './tools/gitnexus-bridge.js';
import { createGitNexusTools } from './tools/gitnexus-tools.js';
import { createEmbeddingProvider } from './memory/embeddings.js';
import { EpisodicMemory } from './memory/episodic.js';
import { IndexingPipeline } from './memory/indexing.js';
import { MemoryConsolidation } from './memory/consolidation.js';
import { MemoryAging } from './memory/aging.js';
import { LineageTracker } from './memory/lineage.js';
import { McpServer } from './mcp/server.js';
import { ContextBuilder } from './agent/context-builder.js';
import { SessionManager } from './agent/session.js';
import { AgentCore } from './agent/core.js';
import { SubAgentManager } from './agent/subagent.js';
import { DispatchEnhancer } from './agent/dispatch.js';
import { ContextCompactor } from './agent/compaction.js';
import { ChatStore } from './store/chats.js';
import { CronScheduler } from './scheduler/cron.js';
import { registerHeartbeat, isHeartbeatOk, buildHeartbeatPrompt } from './scheduler/heartbeat.js';
import type { FastifyInstance } from 'fastify';

// --- Globals for shutdown ---
let healthServer: FastifyInstance | null = null;
let channelRouter: ChannelRouter | null = null;
let memoryStore: MemoryStore | null = null;
let sessionManager: SessionManager | null = null;
let cronScheduler: CronScheduler | null = null;
let gitNexusBridge: GitNexusBridge | null = null;
let shuttingDown = false;

async function main(): Promise<void> {
  const startTime = Date.now();

  // Set log level from env
  const logLevel = (process.env['LOG_LEVEL'] ?? 'info') as 'debug' | 'info' | 'warn' | 'error';
  setLogLevel(logLevel);

  logger.info('Starting river-runtime', { version: '0.1.0', pid: process.pid });

  // 1. Load config
  const config = loadConfig();
  logger.info('Config loaded', {
    workspace: config.daemon.workspace,
    port: config.daemon.port,
    primaryModel: `${config.llm.primary.provider}/${config.llm.primary.model}`,
  });

  // 2. Initialize memory store
  memoryStore = new MemoryStore(config.data.dir);

  // 2b. Initialize pattern memory (uses same SQLite DB)
  const patternStore = new PatternStore(memoryStore.getDb());
  seedPatterns(patternStore);
  const extractionPipeline = new ExtractionPipeline(patternStore); // lineage wired later

  // 2c. Initialize knowledge base (same SQLite DB)
  const knowledgeBase = new KnowledgeBase(memoryStore.getDb());
  const documentIngestion = new DocumentIngestion(knowledgeBase);
  const dispatchEnhancer = new DispatchEnhancer(patternStore, knowledgeBase);

  logger.info('Pattern memory initialized', { stats: patternStore.getStats() });
  logger.info('Knowledge base initialized', { stats: knowledgeBase.getStats() });

  // 2d. Initialize episodic memory with vector embeddings (same SQLite DB)
  const embeddingProvider = createEmbeddingProvider();
  const episodicMemory = new EpisodicMemory(memoryStore.getDb(), embeddingProvider);
  const indexingPipeline = new IndexingPipeline(episodicMemory);

  logger.info('Episodic memory initialized', {
    embeddingProvider: embeddingProvider.name,
    dimensions: embeddingProvider.dimensions,
    stats: episodicMemory.getStats(),
  });

  // 2e. Initialize code intelligence (same SQLite DB)
  const codeIndex = new CodeIndex(memoryStore.getDb());
  logger.info('Code index initialized', { stats: codeIndex.getStats() });

  // 2f. Initialize knowledge graph (same SQLite DB)
  const knowledgeGraph = new KnowledgeGraph(memoryStore.getDb());
  seedGraph(knowledgeGraph);
  logger.info('Knowledge graph initialized', { stats: knowledgeGraph.getStats() });

  // Register code repos on startup if they exist
  // Configure tracked repos via CODE_REPOS env var: "name:path,name2:path2"
  // Defaults to tracking river-runtime in the current directory
  const reposToTrack = (process.env['CODE_REPOS'] ?? `river-runtime:${process.cwd()}`)
    .split(',')
    .filter(Boolean)
    .map(entry => {
      const [name, ...pathParts] = entry.split(':');
      return { name: name!, path: pathParts.join(':') };
    });
  for (const repo of reposToTrack) {
    try {
      const { existsSync } = await import('node:fs');
      if (existsSync(repo.path)) {
        codeIndex.addRepo(repo.name, repo.path);
        logger.info('Code repo registered', { name: repo.name, path: repo.path });
      }
    } catch (err) {
      logger.warn('Failed to register code repo', {
        name: repo.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2g. Initialize pattern lineage tracker (same SQLite DB)
  const lineageTracker = new LineageTracker(memoryStore.getDb());
  lineageTracker.init();
  logger.info('Pattern lineage tracker initialized');

  // Wire lineage into extraction pipeline
  extractionPipeline.setLineageTracker(lineageTracker);

  // 2h-cont. Initialize memory consolidation and aging
  const memoryConsolidation = new MemoryConsolidation(
    memoryStore.getDb(),
    patternStore,
    knowledgeBase,
    episodicMemory,
    knowledgeGraph,
    lineageTracker
  );
  const memoryAging = new MemoryAging(memoryStore.getDb(), lineageTracker);

  logger.info('Memory maintenance modules initialized');

  // 2i. Initialize MCP server
  const mcpServer = new McpServer({
    episodicMemory,
    patternStore,
    knowledgeBase,
    codeIndex,
    knowledgeGraph,
    lineageTracker,
  });

  // 3. Initialize session manager
  sessionManager = new SessionManager(config.data.sessions_dir);

  // 4. Initialize LLM router
  const llm = new LLMRouter(config.llm);

  // 5. Initialize tool registry
  const tools = new ToolRegistry();

  // Register filesystem tools
  tools.register(createReadTool());
  tools.register(createWriteTool());
  tools.register(createEditTool());

  // Register exec tool
  if (config.tools.exec.enabled) {
    tools.register(createExecTool(config.tools.exec));
  }

  // Register web tools
  if (config.tools.web_search.enabled) {
    tools.register(createWebSearchTool(config.tools.web_search));
  }
  if (config.tools.web_fetch.enabled) {
    tools.register(createWebFetchTool());
  }

  // Register memory search tool (enhanced with episodic memory)
  tools.register(createMemorySearchTool(config.daemon.workspace, episodicMemory));

  // Register knowledge tools
  tools.register(createIngestDocsTool(knowledgeBase, documentIngestion));
  tools.register(createQueryKnowledgeTool(knowledgeBase));

  // Register computer control tools (Windows desktop via PowerShell interop)
  tools.register(createScreenshotTool());
  tools.register(createClickTool());
  tools.register(createTypeTool());
  tools.register(createPressKeyTool());
  tools.register(createListWindowsTool());
  tools.register(createFocusWindowTool());
  tools.register(createMouseMoveTool());
  tools.register(createMouseScrollTool());

  // Register GitNexus code intelligence tools (MCP bridge)
  gitNexusBridge = new GitNexusBridge();
  await gitNexusBridge.start(); // gracefully no-ops if gitnexus not installed
  const gitNexusTools = createGitNexusTools(gitNexusBridge);
  for (const handler of gitNexusTools) {
    tools.register(handler);
  }
  if (gitNexusTools.length > 0) {
    logger.info('GitNexus tools registered', { count: gitNexusTools.length });
  }

  logger.info('Tools registered', { count: tools.size });

  // 6. Initialize context builder (with episodic memory for enhanced prompts)
  const contextBuilder = new ContextBuilder({
    identity: config.identity,
    daemon: config.daemon,
    episodicMemory,
  });

  // Pre-build system prompt
  const systemPrompt = contextBuilder.buildSystemPrompt();
  logger.info('System prompt ready', { length: systemPrompt.length });

  // 7. Initialize sub-agent manager
  const subAgentManager = new SubAgentManager();

  // 8. Initialize context compactor
  const compactor = new ContextCompactor(
    {
      enabled: config.compaction.enabled,
      thresholdTokens: config.compaction.threshold_tokens,
      keepRecentMessages: config.compaction.keep_recent_messages,
      summaryModel: config.compaction.summary_model,
      archiveDir: `${config.data.dir}/archives`,
    },
    llm,
    sessionManager
  );

  // 9. Initialize agent core
  const agent = new AgentCore({
    llm,
    tools,
    contextBuilder,
    sessions: sessionManager,
  });

  // Wire sub-agent manager to agent core, pattern memory, and lineage tracker
  subAgentManager.setAgent(agent);
  subAgentManager.setPatternMemory(patternStore, dispatchEnhancer, extractionPipeline);
  subAgentManager.setLineageTracker(lineageTracker);

  // 10. Initialize channel router
  channelRouter = new ChannelRouter();

  // Register Telegram adapter if enabled
  const tgToken = config.channels.telegram.token;
  if (config.channels.telegram.enabled && tgToken && tgToken.length > 10) {
    const telegram = new TelegramAdapter(config.channels.telegram);
    channelRouter.register(telegram);
  } else if (config.channels.telegram.enabled) {
    logger.warn('Telegram enabled but token is missing or invalid — skipping');
  }

  // Register Discord adapter if enabled
  const discordToken = config.channels.discord.token;
  if (config.channels.discord.enabled && discordToken && discordToken.length > 10) {
    const discord = new DiscordAdapter(config.channels.discord);
    channelRouter.register(discord);
  } else if (config.channels.discord.enabled) {
    logger.warn('Discord enabled but token is missing or invalid — skipping');
  }

  // Register webchat adapter (always enabled — serves the browser UI)
  const webchat = new WebchatAdapter();
  webchat.setBrainDeps({ episodicMemory, patternStore, knowledgeBase, knowledgeGraph, codeIndex, lineageTracker });

  // Initialize chat persistence store (same SQLite DB)
  const chatStore = new ChatStore(memoryStore.getDb());
  chatStore.init();
  webchat.setChatStore(chatStore);
  webchat.setSessionsDir(config.data.sessions_dir);
  logger.info('Chat persistence store initialized');

  channelRouter.register(webchat);

  // Wire inbound messages to agent core
  channelRouter.onMessage(async (message) => {
    logger.info('Inbound message', {
      channel: message.channel,
      sessionKey: message.sessionKey,
      userId: message.userId,
      textLength: message.text.length,
    });

    try {
      // Check if session needs compaction before processing
      await compactor.maybeCompact(message.sessionKey);

      // For webchat, create a streaming callback to push deltas to the browser
      let streamCallback: ((event: import('./llm/types.js').StreamDeltaEvent) => void) | undefined;
      if (message.channel === 'webchat') {
        const parts = message.sessionKey.split(':');
        const sessionId = parts[1] ?? message.userId;
        const streamMessageId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        streamCallback = webchat.createStreamCallback(sessionId, streamMessageId);
      }

      const response = await agent.processMessage(message, streamCallback);

      // Extract target from session key based on channel type
      let target: string;
      if (message.channel === 'discord') {
        // For Discord: session key is "discord:guildId:channelId" or "discord:dm:userId"
        const parts = message.sessionKey.split(':');
        if (parts[1] === 'dm') {
          target = parts[2] ?? message.userId;
        } else {
          target = parts[2] ?? message.userId; // channel ID
        }
      } else {
        // For Telegram/webchat: session key is "channel:chatId"
        const parts = message.sessionKey.split(':');
        target = parts[1] ?? message.userId;
      }

      await channelRouter!.send({
        channel: message.channel,
        target,
        text: response.text,
        replyTo: message.id,
        thinking: response.thinking,
        thinkingTokens: response.thinkingTokens,
      });

      logger.info('Response sent', {
        channel: message.channel,
        sessionKey: message.sessionKey,
        responseLength: response.text.length,
        thinkingTokens: response.thinkingTokens,
      });

      // Background-index the conversation into episodic memory
      // This is fire-and-forget — never blocks message delivery
      try {
        const history = sessionManager!.getHistory(message.sessionKey);
        indexingPipeline.indexSession(
          message.sessionKey,
          history,
          message.channel,
          message.userName
        );
      } catch (indexErr) {
        logger.warn('Failed to trigger episodic indexing', {
          sessionKey: message.sessionKey,
          error: indexErr instanceof Error ? indexErr.message : String(indexErr),
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Failed to process message', {
        sessionKey: message.sessionKey,
        error: errorMsg,
      });

      // Send error response back to the user so they don't see infinite "thinking"
      try {
        const parts = message.sessionKey.split(':');
        const target = parts[1] ?? message.userId;
        await channelRouter!.send({
          channel: message.channel,
          target,
          text: `⚠️ Something went wrong: ${errorMsg.substring(0, 200)}`,
          replyTo: message.id,
        });
      } catch (sendErr) {
        logger.error('Failed to send error response', {
          sessionKey: message.sessionKey,
          error: sendErr instanceof Error ? sendErr.message : String(sendErr),
        });
      }
    }
  });

  // 11. Initialize cron scheduler
  const jobsFilePath = config.scheduler.jobs_file;
  cronScheduler = new CronScheduler(config.data.dir, jobsFilePath);

  // Wire agentTurn handler: runs agent in isolated session, routes result
  cronScheduler.onAgentTurn(async (prompt, sessionKey, resultChannel, resultTarget) => {
    // Build heartbeat-aware prompt (includes HEARTBEAT.md if this is the heartbeat job)
    const effectivePrompt = sessionKey === 'heartbeat:main'
      ? buildHeartbeatPrompt(prompt, config.daemon.workspace)
      : prompt;

    const fakeMessage = {
      id: `cron-${Date.now()}`,
      channel: 'webchat' as const,
      sessionKey,
      userId: 'system',
      userName: 'Cron Scheduler',
      text: effectivePrompt,
      timestamp: Date.now(),
    };

    const response = await agent.processMessage(fakeMessage);

    // For heartbeat: check if response is HEARTBEAT_OK (discard if so)
    if (sessionKey === 'heartbeat:main' && isHeartbeatOk(response.text)) {
      logger.info('Heartbeat OK — nothing to report');
      return response.text;
    }

    // Route result to the configured channel (if any)
    if (resultChannel && resultTarget && channelRouter) {
      try {
        await channelRouter.send({
          channel: resultChannel as 'telegram' | 'discord' | 'webchat',
          target: resultTarget,
          text: response.text,
        });
        logger.info('Cron result routed to channel', {
          channel: resultChannel,
          target: resultTarget,
          responseLength: response.text.length,
        });
      } catch (err) {
        logger.error('Failed to route cron result', {
          channel: resultChannel,
          target: resultTarget,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return response.text;
  });

  // Load jobs from file and register heartbeat
  cronScheduler.loadJobsFile();
  registerHeartbeat(cronScheduler, {
    enabled: config.scheduler.heartbeat.enabled,
    intervalMinutes: config.scheduler.heartbeat.interval_minutes,
    prompt: config.scheduler.heartbeat.prompt,
    notificationChannel: config.scheduler.heartbeat.notification_channel,
    workspace: config.daemon.workspace,
  });

  // Register memory consolidation (daily at 3:00 AM)
  cronScheduler.addInternalJob('memory-consolidation', '0 3 * * *', async () => {
    logger.info('Running scheduled memory consolidation');
    const report = await memoryConsolidation.runAll();
    logger.info('Scheduled memory consolidation complete', {
      patterns_merged: report.patterns_merged,
      knowledge_superseded: report.knowledge_superseded,
    });
  });

  // Register memory aging (weekly on Sunday at 4:00 AM)
  cronScheduler.addInternalJob('memory-aging', '0 4 * * 0', async () => {
    logger.info('Running scheduled memory aging');
    const report = await memoryAging.applyAgingRules();
    logger.info('Scheduled memory aging complete', {
      patterns_archived: report.patterns_archived,
      graph_nodes_pruned: report.graph_nodes_pruned,
    });
  });

  // 12. Start health server
  setHealthStatusProvider(() => ({
    status: 'ok',
    uptime: process.uptime(),
    version: '0.1.0',
    channels: channelRouter?.getStatus() ?? {},
    llm: llm.getPrimaryInfo(),
    scheduler: {
      jobs: cronScheduler?.listJobs().length ?? 0,
    },
    subAgents: {
      active: subAgentManager.listActive().length,
    },
    codeIndex: codeIndex.getStats(),
    knowledgeGraph: knowledgeGraph.getStats(),
    mcp: {
      endpoint: `/mcp/tools/call`,
      health: `/mcp/health`,
    },
  }));

  healthServer = createHealthServer();

  // 12b. Mount webchat routes (HTML UI + WebSocket) before server starts listening
  await webchat.mount(healthServer);

  // 12c. Mount MCP routes on the health server (same Fastify instance)
  mcpServer.mount(healthServer);

  // 12d. Start listening
  await listenHealthServer(healthServer, config.daemon.port);

  // 13. Start channels
  await channelRouter.startAll();

  // 14. Start cron scheduler
  cronScheduler.startAll();

  const elapsed = Date.now() - startTime;
  logger.info('river-runtime started', {
    elapsed: `${elapsed}ms`,
    port: config.daemon.port,
    channels: channelRouter.getStatus(),
  });
}

// --- Graceful Shutdown ---

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('Shutting down', { signal });

  try {
    // Stop cron scheduler first (stop triggering new work)
    if (cronScheduler) {
      cronScheduler.stopAll();
    }

    // Stop channels (stop receiving new messages)
    if (channelRouter) {
      await channelRouter.stopAll();
    }

    // Flush sessions
    if (sessionManager) {
      sessionManager.flush();
    }

    // Stop GitNexus bridge
    if (gitNexusBridge) {
      await gitNexusBridge.stop();
    }

    // Close memory store
    if (memoryStore) {
      memoryStore.close();
    }

    // Stop health server
    if (healthServer) {
      await healthServer.close();
    }

    logger.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', {
    error: err.message,
    stack: err.stack,
  });
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
  });
});

// --- Start ---
main().catch((err) => {
  logger.error('Fatal error during startup', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
