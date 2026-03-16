/**
 * Health check HTTP endpoint via Fastify.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { logger } from './logger.js';

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  uptime: number;
  version: string;
  channels: Record<string, boolean>;
  llm: { provider: string; model: string };
  scheduler?: { jobs: number };
  subAgents?: { active: number };
  mcp?: { endpoint: string; health: string };
  [key: string]: unknown;
}

let statusFn: (() => HealthStatus) | null = null;

export function setHealthStatusProvider(fn: () => HealthStatus): void {
  statusFn = fn;
}

/**
 * Create the Fastify server instance with health routes (but don't listen yet).
 * This allows other modules (e.g. webchat) to mount routes before the server starts.
 */
export function createHealthServer(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async (_request, _reply) => {
    if (statusFn) {
      return statusFn();
    }
    return { status: 'ok', uptime: process.uptime() };
  });

  return app;
}

/**
 * Start listening on the given port.
 * Call after all routes/plugins have been mounted.
 */
export async function listenHealthServer(app: FastifyInstance, port: number): Promise<void> {
  await app.listen({ port, host: '0.0.0.0' });
  logger.info('Health server started', { port });
}

/**
 * @deprecated Use createHealthServer() + listenHealthServer() for proper mount ordering.
 */
export async function startHealthServer(port: number): Promise<FastifyInstance> {
  const app = createHealthServer();
  await listenHealthServer(app, port);
  return app;
}
