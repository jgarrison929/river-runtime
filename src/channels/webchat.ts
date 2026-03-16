/**
 * Webchat channel adapter using Fastify WebSocket.
 * Provides a browser-based chat interface via WebSocket at /chat.
 * Each WebSocket connection is treated as a unique session.
 *
 * Features:
 * - Multiple chat sessions per connection (session_id routing)
 * - File upload via POST /api/upload (multipart/form-data)
 * - Brain stats via GET /api/brain-stats
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';
import type { ChatStore } from '../store/chats.js';
import type { StreamDeltaCallback, StreamDeltaEvent } from '../llm/types.js';
import { logger } from '../utils/logger.js';

interface WebSocketConnection {
  id: string;
  socket: import('@fastify/websocket').WebSocket;
  alive: boolean;
}

/** Optional dependency injection for brain stats. */
export interface BrainStatsDeps {
  episodicMemory: { getStats(): { totalEpisodes: number } };
  patternStore: { getStats(): { total: number; byType: Record<string, number>; averageConfidence: number } };
  knowledgeBase: { getStats(): { totalEntries: number; currentEntries: number } };
  knowledgeGraph: { getStats(): { nodeCount: number; edgeCount: number; nodesByType: Record<string, number> } };
  codeIndex: { getStats(): { symbols: number; repos: number; files: number } };
  lineageTracker?: { getStats(): { totalEvents: number; byType: Record<string, number> } };
}

export class WebchatAdapter implements ChannelAdapter {
  readonly name = 'webchat';
  private handler: ((message: InboundMessage) => Promise<void>) | null = null;
  private connections: Map<string, WebSocketConnection> = new Map();
  private connected = false;
  private server: FastifyInstance | null = null;
  private htmlContent: string;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private brainDeps: BrainStatsDeps | null = null;
  private chatStore: ChatStore | null = null;
  private uploadsDir: string;
  private sessionsDir: string | null = null;

  constructor() {
    // Load HTML at construction time
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const htmlPath = resolve(__dirname, '..', 'web', 'index.html');
    try {
      this.htmlContent = readFileSync(htmlPath, 'utf-8');
    } catch {
      // Fallback: try from src directory (dev mode with tsx)
      const devPath = resolve(__dirname, '..', '..', 'src', 'web', 'index.html');
      try {
        this.htmlContent = readFileSync(devPath, 'utf-8');
      } catch {
        logger.warn('Webchat HTML not found, using placeholder');
        this.htmlContent = '<html><body><h1>Webchat UI not found</h1></body></html>';
      }
    }

    // Ensure uploads directory
    this.uploadsDir = resolve(process.cwd(), 'data', 'uploads');
    mkdirSync(this.uploadsDir, { recursive: true });
  }

  /** Inject brain dependencies for the /api/brain-stats endpoint. */
  setBrainDeps(deps: BrainStatsDeps): void {
    this.brainDeps = deps;
  }

  /** Inject the chat persistence store. */
  setChatStore(store: ChatStore): void {
    this.chatStore = store;
  }

  /** Inject the sessions directory for telegram history. */
  setSessionsDir(dir: string): void {
    this.sessionsDir = dir;
  }

  /**
   * Mount webchat routes on the Fastify server.
   * Must be called before start().
   */
  async mount(server: FastifyInstance): Promise<void> {
    this.server = server;

    // Register @fastify/websocket plugin
    const websocketPlugin = await import('@fastify/websocket');
    await server.register(websocketPlugin.default);

    // Register @fastify/multipart plugin for file uploads
    const multipartPlugin = await import('@fastify/multipart');
    await server.register(multipartPlugin.default, {
      limits: {
        fileSize: 50 * 1024 * 1024, // 50MB
        files: 50,
      },
    });

    // Serve the HTML UI
    server.get('/', async (_request, reply) => {
      reply.type('text/html').send(this.htmlContent);
    });

    server.get('/chat', async (_request, reply) => {
      reply.type('text/html').send(this.htmlContent);
    });

    // ── REST API: Brain Stats ──────────────────────────────────────
    server.get('/api/brain-stats', async (_request, _reply) => {
      if (!this.brainDeps) {
        return { error: 'Brain stats not available' };
      }
      try {
        const ep = this.brainDeps.episodicMemory.getStats();
        const pat = this.brainDeps.patternStore.getStats();
        const kb = this.brainDeps.knowledgeBase.getStats();
        const graph = this.brainDeps.knowledgeGraph.getStats();
        const code = this.brainDeps.codeIndex.getStats();
        const lineage = this.brainDeps.lineageTracker?.getStats();
        return {
          patterns: pat.total,
          patternsByType: pat.byType,
          patternConfidence: Math.round(pat.averageConfidence * 100) / 100,
          graphNodes: graph.nodeCount,
          graphEdges: graph.edgeCount,
          graphNodesByType: graph.nodesByType,
          episodes: ep.totalEpisodes,
          knowledgeEntries: kb.totalEntries,
          knowledgeCurrent: kb.currentEntries,
          codeSymbols: code.symbols,
          codeRepos: code.repos,
          codeFiles: code.files,
          lineageEvents: lineage?.totalEvents ?? 0,
        };
      } catch (err) {
        logger.error('Failed to get brain stats', {
          error: err instanceof Error ? err.message : String(err),
        });
        return { error: 'Failed to retrieve brain stats' };
      }
    });

    // ── REST API: Telegram History ──────────────────────────────────
    server.get('/api/telegram-history', async (_request, reply) => {
      if (!this.sessionsDir) {
        return reply.code(503).send({ error: 'Sessions directory not configured' });
      }

      try {
        // Find telegram session files
        const files = readdirSync(this.sessionsDir).filter(f => f.startsWith('telegram:') && f.endsWith('.jsonl'));
        if (files.length === 0) {
          return [];
        }

        const messages: Array<{ ts: number; role: string; userName: string; text: string }> = [];

        for (const file of files) {
          const filePath = join(this.sessionsDir, file);
          const raw = readFileSync(filePath, 'utf-8');
          const lines = raw.trim().split('\n').filter(Boolean);

          for (const line of lines) {
            try {
              const entry = JSON.parse(line) as { ts: number; role: string; content: unknown };

              // Extract clean text from content (may be string or array of content blocks)
              let text = '';
              let userName = '';

              if (typeof entry.content === 'string') {
                // User messages often have "[UserName]: message" format
                const match = entry.content.match(/^\[([^\]]+)\]:\s*([\s\S]*)$/);
                if (match) {
                  userName = match[1];
                  text = match[2];
                } else {
                  text = entry.content;
                }
              } else if (Array.isArray(entry.content)) {
                // Content blocks array — extract text from text blocks
                for (const block of entry.content as Array<{ type?: string; text?: string }>) {
                  if (block.type === 'text' && block.text) {
                    text += (text ? '\n' : '') + block.text;
                  }
                }
              }

              if (!userName) {
                userName = entry.role === 'user' ? 'User' : 'River';
              }

              messages.push({
                ts: entry.ts,
                role: entry.role,
                userName,
                text: text || String(entry.content),
              });
            } catch {
              // Skip malformed lines
            }
          }
        }

        // Sort by timestamp
        messages.sort((a, b) => a.ts - b.ts);
        return messages;
      } catch (err) {
        logger.error('Failed to read telegram history', {
          error: err instanceof Error ? err.message : String(err),
        });
        return reply.code(500).send({ error: 'Failed to read telegram history' });
      }
    });

    // ── REST API: File Upload ──────────────────────────────────────
    server.post('/api/upload', async (request, reply) => {
      try {
        const parts = request.parts();
        const results: Array<{ path: string; filename: string; size: number; mimeType: string }> = [];

        for await (const part of parts) {
          if (part.type === 'file') {
            const ext = extname(part.filename) || '';
            const safeName = part.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
            const timestamp = Date.now();
            const storedName = `${timestamp}-${safeName}`;
            const filePath = join(this.uploadsDir, storedName);

            // Read the file buffer
            const chunks: Buffer[] = [];
            for await (const chunk of part.file) {
              chunks.push(chunk as Buffer);
            }
            const buffer = Buffer.concat(chunks);

            // Check if file was truncated (exceeded size limit)
            if ((part.file as any).truncated) {
              reply.code(413).send({ error: `File ${part.filename} exceeds 50MB limit` });
              return;
            }

            writeFileSync(filePath, buffer);

            results.push({
              path: filePath,
              filename: part.filename,
              size: buffer.length,
              mimeType: part.mimetype || 'application/octet-stream',
            });

            logger.info('File uploaded via webchat', {
              filename: part.filename,
              size: buffer.length,
              path: filePath,
            });
          }
        }

        if (results.length === 0) {
          reply.code(400).send({ error: 'No files provided' });
          return;
        }

        return { files: results };
      } catch (err) {
        logger.error('File upload error', {
          error: err instanceof Error ? err.message : String(err),
        });
        reply.code(500).send({ error: 'Upload failed' });
      }
    });

    // ── REST API: Chat Persistence ───────────────────────────────
    // Projects
    server.get('/api/projects', async (_request, reply) => {
      if (!this.chatStore) return reply.code(503).send({ error: 'Chat store not available' });
      return this.chatStore.getProjects();
    });

    server.post('/api/projects', async (request, reply) => {
      if (!this.chatStore) return reply.code(503).send({ error: 'Chat store not available' });
      const body = request.body as { name?: string } | null;
      if (!body?.name?.trim()) return reply.code(400).send({ error: 'name is required' });
      return this.chatStore.createProject(body.name.trim());
    });

    server.patch('/api/projects/:id', async (request, reply) => {
      if (!this.chatStore) return reply.code(503).send({ error: 'Chat store not available' });
      const { id } = request.params as { id: string };
      const body = request.body as { name?: string } | null;
      if (!body?.name?.trim()) return reply.code(400).send({ error: 'name is required' });
      const ok = this.chatStore.updateProject(id, body.name.trim());
      if (!ok) return reply.code(404).send({ error: 'Project not found' });
      return { ok: true };
    });

    server.delete('/api/projects/:id', async (request, reply) => {
      if (!this.chatStore) return reply.code(503).send({ error: 'Chat store not available' });
      const { id } = request.params as { id: string };
      if (id === 'general') return reply.code(400).send({ error: 'Cannot delete the default project' });
      const ok = this.chatStore.deleteProject(id);
      if (!ok) return reply.code(404).send({ error: 'Project not found' });
      return { ok: true };
    });

    // Chats
    server.get('/api/chats', async (request, reply) => {
      if (!this.chatStore) return reply.code(503).send({ error: 'Chat store not available' });
      const { projectId } = request.query as { projectId?: string };
      return this.chatStore.getChats(projectId);
    });

    server.post('/api/chats', async (request, reply) => {
      if (!this.chatStore) return reply.code(503).send({ error: 'Chat store not available' });
      const body = request.body as { projectId?: string; title?: string } | null;
      const projectId = body?.projectId || 'general';
      return this.chatStore.createChat(projectId, body?.title);
    });

    server.patch('/api/chats/:id', async (request, reply) => {
      if (!this.chatStore) return reply.code(503).send({ error: 'Chat store not available' });
      const { id } = request.params as { id: string };
      const body = request.body as { title?: string; projectId?: string } | null;
      if (!body) return reply.code(400).send({ error: 'No updates provided' });
      const ok = this.chatStore.updateChat(id, { title: body.title, projectId: body.projectId });
      if (!ok) return reply.code(404).send({ error: 'Chat not found' });
      return { ok: true };
    });

    server.delete('/api/chats/:id', async (request, reply) => {
      if (!this.chatStore) return reply.code(503).send({ error: 'Chat store not available' });
      const { id } = request.params as { id: string };
      const ok = this.chatStore.deleteChat(id);
      if (!ok) return reply.code(404).send({ error: 'Chat not found' });
      return { ok: true };
    });

    // Messages
    server.get('/api/chats/:id/messages', async (request, reply) => {
      if (!this.chatStore) return reply.code(503).send({ error: 'Chat store not available' });
      const { id } = request.params as { id: string };
      const { limit, before } = request.query as { limit?: string; before?: string };
      const lim = Math.min(parseInt(limit || '50', 10) || 50, 200);
      const bef = before ? parseInt(before, 10) : undefined;
      return this.chatStore.getMessages(id, lim, bef);
    });

    server.post('/api/chats/:id/messages', async (request, reply) => {
      if (!this.chatStore) return reply.code(503).send({ error: 'Chat store not available' });
      const { id } = request.params as { id: string };
      const body = request.body as { role?: string; content?: string; thinking?: string; files?: Array<{ name: string; size: number; path?: string }> } | null;
      if (!body?.role || !body?.content) return reply.code(400).send({ error: 'role and content are required' });
      if (body.role !== 'user' && body.role !== 'assistant') return reply.code(400).send({ error: 'role must be user or assistant' });
      return this.chatStore.addMessage(id, body.role, body.content, body.thinking, body.files);
    });

    // Search
    server.get('/api/search', async (request, reply) => {
      if (!this.chatStore) return reply.code(503).send({ error: 'Chat store not available' });
      const { q, limit } = request.query as { q?: string; limit?: string };
      if (!q?.trim()) return reply.code(400).send({ error: 'q parameter is required' });
      const lim = Math.min(parseInt(limit || '20', 10) || 20, 100);
      return this.chatStore.searchMessages(q.trim(), lim);
    });

    // Bulk import (for localStorage migration)
    server.post('/api/import', async (request, reply) => {
      if (!this.chatStore) return reply.code(503).send({ error: 'Chat store not available' });
      const body = request.body as {
        projects: Array<{ id: string; name: string }>;
        chats: Record<string, {
          id: string;
          title: string;
          projectId: string;
          createdAt: string;
          messages: Array<{ role: string; content: string; files?: Array<{ name: string; size: number }>; thinking?: string }>;
        }>;
      } | null;

      if (!body?.projects || !body?.chats) return reply.code(400).send({ error: 'Invalid import data' });

      try {
        for (const project of body.projects) {
          const projectChats = Object.values(body.chats)
            .filter(c => c.projectId === project.id)
            .map(c => ({
              id: c.id,
              title: c.title,
              createdAt: new Date(c.createdAt).getTime(),
              messages: c.messages.map(m => ({
                role: m.role,
                content: m.content,
                files: m.files,
                thinking: m.thinking,
              })),
            }));
          this.chatStore.importProject(project, projectChats);
        }
        logger.info('Imported chat data from localStorage', {
          projects: body.projects.length,
          chats: Object.keys(body.chats).length,
        });
        return { ok: true, projects: body.projects.length, chats: Object.keys(body.chats).length };
      } catch (err) {
        logger.error('Import failed', { error: err instanceof Error ? err.message : String(err) });
        return reply.code(500).send({ error: 'Import failed' });
      }
    });

    // WebSocket endpoint
    server.get('/ws', { websocket: true }, (socket, _request) => {
      const connId = randomUUID().slice(0, 8);
      const conn: WebSocketConnection = { id: connId, socket, alive: true };
      this.connections.set(connId, conn);

      logger.info('Webchat client connected', { connId, total: this.connections.size });

      // Send welcome
      this.safeSend(socket, {
        type: 'connected',
        connectionId: connId,
        message: 'Connected to River 🌊',
      });

      socket.on('message', async (raw: Buffer | string) => {
        try {
          const data = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));

          if (data.type === 'message' && typeof data.content === 'string' && data.content.trim()) {
            // Use session_id from client if provided, otherwise fall back to connId
            const sessionId = data.session_id || connId;

            const message: InboundMessage = {
              id: `webchat-${Date.now()}-${connId}`,
              channel: 'webchat',
              sessionKey: `webchat:${sessionId}`,
              userId: `webchat-user-${connId}`,
              userName: data.userName || 'Web User',
              text: data.content.trim(),
              timestamp: Date.now(),
              thinking: data.thinking, // { enabled: boolean, budget_tokens: number }
            };

            // Persist user message to database
            if (this.chatStore) {
              try {
                this.chatStore.addMessage(sessionId, 'user', data.content.trim(), null, data.files || null);
              } catch (err) {
                logger.warn('Failed to persist user message', {
                  sessionId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }

            // Send "thinking" status with session_id for routing
            this.safeSend(socket, { type: 'status', status: 'thinking', session_id: sessionId });

            if (this.handler) {
              try {
                await this.handler(message);
              } catch (err) {
                logger.error('Error handling webchat message', {
                  connId,
                  sessionId,
                  error: err instanceof Error ? err.message : String(err),
                });
                this.safeSend(socket, {
                  type: 'error',
                  message: 'Something went wrong processing your message.',
                  session_id: sessionId,
                });
              }
            }
          } else if (data.type === 'ping') {
            conn.alive = true;
            this.safeSend(socket, { type: 'pong' });
          } else if (data.type === 'pong') {
            // Client responding to our ping — mark connection alive
            conn.alive = true;
          }
        } catch (err) {
          logger.warn('Invalid webchat message', {
            connId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

      socket.on('close', () => {
        this.connections.delete(connId);
        logger.info('Webchat client disconnected', { connId, total: this.connections.size });
      });

      socket.on('error', (err) => {
        logger.warn('Webchat socket error', {
          connId,
          error: err.message,
        });
        this.connections.delete(connId);
      });
    });

    logger.info('Webchat routes mounted (/, /chat, /ws, /api/brain-stats, /api/upload)');
  }

  async start(): Promise<void> {
    this.connected = true;

    // Heartbeat to detect stale connections
    this.heartbeatInterval = setInterval(() => {
      for (const [id, conn] of this.connections) {
        if (!conn.alive) {
          conn.socket.close();
          this.connections.delete(id);
          continue;
        }
        conn.alive = false;
        this.safeSend(conn.socket, { type: 'ping' });
      }
    }, 30_000);

    logger.info('Webchat adapter started');
  }

  async stop(): Promise<void> {
    this.connected = false;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close all connections
    for (const [id, conn] of this.connections) {
      try {
        conn.socket.close(1000, 'Server shutting down');
      } catch { /* ignore */ }
      this.connections.delete(id);
    }

    logger.info('Webchat adapter stopped');
  }

  async send(message: OutboundMessage): Promise<void> {
    // Target is the connection ID (extracted from session key "webchat:{connId}")
    // For multi-chat, the session key format is "webchat:{session_id}"
    // We need to find which connection owns this session
    const targetSessionId = message.target;

    const responsePayload: Record<string, unknown> = {
      type: 'response',
      content: message.text,
      session_id: targetSessionId,
    };

    // Include thinking data if present
    if (message.thinking) {
      responsePayload['thinking'] = message.thinking;
      if (message.thinkingTokens) {
        responsePayload['thinkingTokens'] = message.thinkingTokens;
      }
    }

    // Persist assistant message to database
    if (this.chatStore) {
      try {
        this.chatStore.addMessage(
          targetSessionId,
          'assistant',
          message.text,
          message.thinking || null
        );
      } catch (err) {
        logger.warn('Failed to persist assistant message', {
          sessionId: targetSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Try direct connection ID match first (backward compat)
    const directConn = this.connections.get(targetSessionId);
    if (directConn) {
      this.safeSend(directConn.socket, responsePayload);
      return;
    }

    // If not a direct connId, broadcast to all connections
    // (the client will filter by session_id)
    for (const [_id, conn] of this.connections) {
      this.safeSend(conn.socket, responsePayload);
    }
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Create a StreamDeltaCallback that forwards events to all connected WebSocket clients
   * for a given session. Used by the message handler to stream LLM responses in real-time.
   */
  createStreamCallback(sessionId: string, messageId: string): StreamDeltaCallback {
    return (event: StreamDeltaEvent) => {
      const payload: Record<string, unknown> = {
        type: `stream_${event.type.replace('_delta', '_delta').replace('text_delta', 'delta').replace('thinking_delta', 'delta')}`,
        session_id: sessionId,
        messageId,
      };

      switch (event.type) {
        case 'stream_start':
          payload['type'] = 'stream_start';
          break;
        case 'stream_end':
          payload['type'] = 'stream_end';
          break;
        case 'text_delta':
          payload['type'] = 'stream_delta';
          payload['delta'] = event.delta;
          payload['blockType'] = 'text';
          break;
        case 'thinking_delta':
          payload['type'] = 'stream_delta';
          payload['delta'] = event.delta;
          payload['blockType'] = 'thinking';
          break;
      }

      // Send to all connections (client-side filters by session_id)
      for (const [_id, conn] of this.connections) {
        this.safeSend(conn.socket, payload);
      }
    };
  }

  private safeSend(socket: import('@fastify/websocket').WebSocket, data: unknown): void {
    try {
      if (socket.readyState === 1) { // OPEN
        socket.send(JSON.stringify(data));
      }
    } catch (err) {
      logger.warn('Failed to send webchat message', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
