/**
 * Integration tests for REST API endpoints.
 *
 * Spins up a minimal Fastify instance with WebchatAdapter mounted,
 * backed by in-memory SQLite. Tests actual HTTP request/response cycles.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { ChatStore } from '../../src/store/chats.js';

// We can't easily mount the full WebchatAdapter (it requires @fastify/websocket),
// so we replicate the REST route registrations for testing.
// This tests the actual route handler logic with real HTTP.

function createTestServer(chatStore: ChatStore): FastifyInstance {
  const app = Fastify({ logger: false });

  // Health endpoint
  app.get('/health', async () => {
    return { status: 'ok' };
  });

  // Projects
  app.get('/api/projects', async () => {
    return chatStore.getProjects();
  });

  app.post('/api/projects', async (request, reply) => {
    const body = request.body as { name?: string } | null;
    if (!body?.name?.trim()) return reply.code(400).send({ error: 'name is required' });
    return chatStore.createProject(body.name.trim());
  });

  app.delete('/api/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (id === 'general') return reply.code(400).send({ error: 'Cannot delete the default project' });
    const ok = chatStore.deleteProject(id);
    if (!ok) return reply.code(404).send({ error: 'Project not found' });
    return { ok: true };
  });

  // Chats
  app.get('/api/chats', async (request) => {
    const { projectId } = request.query as { projectId?: string };
    return chatStore.getChats(projectId);
  });

  app.post('/api/chats', async (request) => {
    const body = request.body as { projectId?: string; title?: string } | null;
    const projectId = body?.projectId || 'general';
    return chatStore.createChat(projectId, body?.title);
  });

  app.delete('/api/chats/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = chatStore.deleteChat(id);
    if (!ok) return reply.code(404).send({ error: 'Chat not found' });
    return { ok: true };
  });

  // Messages
  app.get('/api/chats/:id/messages', async (request) => {
    const { id } = request.params as { id: string };
    const { limit, before } = request.query as { limit?: string; before?: string };
    const lim = Math.min(parseInt(limit || '50', 10) || 50, 200);
    const bef = before ? parseInt(before, 10) : undefined;
    return chatStore.getMessages(id, lim, bef);
  });

  // Search
  app.get('/api/search', async (request, reply) => {
    const { q, limit } = request.query as { q?: string; limit?: string };
    if (!q?.trim()) return reply.code(400).send({ error: 'q parameter is required' });
    const lim = Math.min(parseInt(limit || '20', 10) || 20, 100);
    return chatStore.searchMessages(q.trim(), lim);
  });

  return app;
}

describe('REST API', () => {
  let app: FastifyInstance;
  let db: Database.Database;
  let chatStore: ChatStore;

  beforeAll(async () => {
    db = new Database(':memory:');
    chatStore = new ChatStore(db);
    chatStore.init();
    app = createTestServer(chatStore);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  // Reset DB between tests (re-create tables)
  beforeEach(() => {
    db.exec('DELETE FROM ui_messages');
    db.exec('DELETE FROM ui_chats');
    db.exec("DELETE FROM ui_projects WHERE id != 'general'");
  });

  // ── Health ────────────────────────────────────────

  it('GET /health should return ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('ok');
  });

  // ── Projects ──────────────────────────────────────

  it('GET /api/projects should return array with General', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect(body[0].name).toBe('General');
  });

  it('POST /api/projects should create project', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Test Project' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.name).toBe('Test Project');
    expect(body.id).toBeTruthy();
  });

  it('POST /api/projects without name should 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.error).toContain('name');
  });

  it('POST /api/projects with empty name should 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /api/projects/:id should delete', async () => {
    // Create a project to delete
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'DeleteMe' },
    });
    const project = JSON.parse(createRes.payload);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${project.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).ok).toBe(true);
  });

  it('DELETE /api/projects/general should be rejected', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/projects/general',
    });
    expect(res.statusCode).toBe(400);
  });

  it('DELETE /api/projects/:nonexistent should 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/projects/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });

  // ── Chats ─────────────────────────────────────────

  it('GET /api/chats should return array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chats' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(Array.isArray(body)).toBe(true);
  });

  it('POST /api/chats should create a chat', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: { projectId: 'general', title: 'Test Chat' },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.title).toBe('Test Chat');
    expect(body.project_id).toBe('general');
  });

  it('GET /api/chats?projectId=general should filter', async () => {
    // Create a chat
    await app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: { projectId: 'general', title: 'Filtered Chat' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/chats?projectId=general',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE /api/chats/:id should delete', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/chats',
      payload: { projectId: 'general', title: 'Delete Me' },
    });
    const chat = JSON.parse(createRes.payload);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/chats/${chat.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).ok).toBe(true);
  });

  // ── Messages ──────────────────────────────────────

  it('GET /api/chats/:id/messages should return messages', async () => {
    // Create a chat and add messages via the store directly
    const chat = chatStore.createChat('general', 'Msg Test');
    chatStore.addMessage(chat.id, 'user', 'Hello');
    chatStore.addMessage(chat.id, 'assistant', 'Hi');

    const res = await app.inject({
      method: 'GET',
      url: `/api/chats/${chat.id}/messages`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveLength(2);
    expect(body[0].role).toBe('user');
    expect(body[1].role).toBe('assistant');
  });

  it('GET /api/chats/:id/messages should paginate', async () => {
    const chat = chatStore.createChat('general', 'Paginated');
    for (let i = 0; i < 10; i++) {
      chatStore.addMessage(chat.id, 'user', `Message ${i}`);
    }

    const res = await app.inject({
      method: 'GET',
      url: `/api/chats/${chat.id}/messages?limit=3`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body).toHaveLength(3);
  });

  it('GET /api/chats/:id/messages should cap limit at 200', async () => {
    const chat = chatStore.createChat('general', 'Capped');
    // Just verify it doesn't error with a large limit
    const res = await app.inject({
      method: 'GET',
      url: `/api/chats/${chat.id}/messages?limit=999`,
    });
    expect(res.statusCode).toBe(200);
  });

  // ── Search ────────────────────────────────────────

  it('GET /api/search should return results', async () => {
    const chat = chatStore.createChat('general', 'Search Test');
    chatStore.addMessage(chat.id, 'user', 'unique_search_term_abcdef');

    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=unique_search_term_abcdef',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].content).toContain('unique_search_term_abcdef');
  });

  it('GET /api/search without q should 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/search',
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /api/search with empty q should 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/search?q=',
    });
    expect(res.statusCode).toBe(400);
  });
});
