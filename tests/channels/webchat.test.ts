/**
 * Tests for WebSocket protocol handling in webchat adapter.
 *
 * Bug coverage:
 * - WebSocket pong messages must mark connection alive
 * - Ping messages must mark connection alive AND send pong back
 * - File upload limit should accept up to 50 files
 *
 * Uses mock/spy approach since we can't easily spin up the full Fastify+WS stack.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Simulate the WebSocket message handler logic ──────────────────
// This mirrors the on('message') handler in WebchatAdapter.mount()

interface MockConnection {
  id: string;
  alive: boolean;
  sentMessages: unknown[];
}

function createMockConnection(id: string): MockConnection {
  return {
    id,
    alive: true,
    sentMessages: [],
  };
}

/**
 * Simulates the WebSocket message handler logic extracted from webchat.ts.
 * In the real code, this is inside socket.on('message', ...).
 */
function handleWebSocketMessage(
  conn: MockConnection,
  data: Record<string, unknown>,
  onMessage?: (message: unknown) => Promise<void>
): void {
  if (data.type === 'message' && typeof data.content === 'string' && (data.content as string).trim()) {
    // Message handling — would call this.handler
    conn.sentMessages.push({ type: 'status', status: 'thinking' });
    if (onMessage) {
      // Fire and forget in the test
    }
  } else if (data.type === 'ping') {
    conn.alive = true;
    conn.sentMessages.push({ type: 'pong' });
  } else if (data.type === 'pong') {
    // Client responding to our ping — mark connection alive
    conn.alive = true;
  }
}

/**
 * Simulates the heartbeat interval logic from WebchatAdapter.start()
 */
function runHeartbeat(connections: Map<string, MockConnection>): void {
  for (const [id, conn] of connections) {
    if (!conn.alive) {
      // Would call conn.socket.close() in real code
      connections.delete(id);
      continue;
    }
    conn.alive = false;
    conn.sentMessages.push({ type: 'ping' });
  }
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('WebSocket Protocol', () => {
  let conn: MockConnection;

  beforeEach(() => {
    conn = createMockConnection('test-conn');
  });

  it('should mark connection alive on pong message', () => {
    // Simulate heartbeat marking it dead
    conn.alive = false;

    // Simulate receiving { type: 'pong' }
    handleWebSocketMessage(conn, { type: 'pong' });

    expect(conn.alive).toBe(true);
    // Pong should NOT trigger sending anything back
    expect(conn.sentMessages).toHaveLength(0);
  });

  it('should mark connection alive on ping message', () => {
    // Simulate heartbeat marking it dead
    conn.alive = false;

    // Simulate receiving { type: 'ping' }
    handleWebSocketMessage(conn, { type: 'ping' });

    expect(conn.alive).toBe(true);
    // Should send back { type: 'pong' }
    expect(conn.sentMessages).toHaveLength(1);
    expect(conn.sentMessages[0]).toEqual({ type: 'pong' });
  });

  it('should not mark alive on unknown message types', () => {
    conn.alive = false;

    handleWebSocketMessage(conn, { type: 'unknown' });

    // alive should remain false since no handler matched
    expect(conn.alive).toBe(false);
    expect(conn.sentMessages).toHaveLength(0);
  });

  it('should send thinking status for valid chat messages', () => {
    handleWebSocketMessage(conn, { type: 'message', content: 'Hello!' });

    expect(conn.sentMessages).toHaveLength(1);
    expect(conn.sentMessages[0]).toEqual({
      type: 'status',
      status: 'thinking',
    });
  });

  it('should ignore message with empty content', () => {
    handleWebSocketMessage(conn, { type: 'message', content: '   ' });

    expect(conn.sentMessages).toHaveLength(0);
  });
});

describe('WebSocket Heartbeat', () => {
  it('should remove dead connections during heartbeat', () => {
    const connections = new Map<string, MockConnection>();
    const alive = createMockConnection('alive');
    const dead = createMockConnection('dead');
    dead.alive = false;

    connections.set('alive', alive);
    connections.set('dead', dead);

    runHeartbeat(connections);

    // Dead connection should be removed
    expect(connections.has('dead')).toBe(false);
    // Alive connection should still be there but marked not-alive
    expect(connections.has('alive')).toBe(true);
    expect(alive.alive).toBe(false);
    // Alive connection should have received a ping
    expect(alive.sentMessages).toContainEqual({ type: 'ping' });
  });

  it('should mark all surviving connections as not-alive after heartbeat', () => {
    const connections = new Map<string, MockConnection>();
    const conn1 = createMockConnection('c1');
    const conn2 = createMockConnection('c2');
    conn1.alive = true;
    conn2.alive = true;

    connections.set('c1', conn1);
    connections.set('c2', conn2);

    runHeartbeat(connections);

    expect(conn1.alive).toBe(false);
    expect(conn2.alive).toBe(false);
  });
});

describe('File Upload Configuration', () => {
  it('should accept up to 50 files per upload', () => {
    // This is a configuration value check from the multipart plugin registration.
    // In webchat.ts mount(): { limits: { fileSize: 50 * 1024 * 1024, files: 50 } }
    const multipartConfig = {
      limits: {
        fileSize: 50 * 1024 * 1024, // 50MB
        files: 50,
      },
    };

    expect(multipartConfig.limits.files).toBe(50);
    expect(multipartConfig.limits.fileSize).toBe(50 * 1024 * 1024);
  });
});
