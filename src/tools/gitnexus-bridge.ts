/**
 * GitNexus MCP bridge — spawns `gitnexus mcp` as a child process and communicates
 * via JSON-RPC over stdio (MCP stdio transport).
 *
 * Handles:
 * - Process lifecycle (spawn, auto-restart on crash, cleanup)
 * - JSON-RPC message framing (one JSON object per line)
 * - Tool discovery (tools/list) and invocation (tools/call)
 * - Graceful degradation when GitNexus is not installed
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../utils/logger.js';
import type { ToolDefinition } from '../llm/types.js';
import type Anthropic from '@anthropic-ai/sdk';

// --- JSON-RPC types for MCP protocol ---

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpToolsListResult {
  tools: McpToolSchema[];
}

interface McpContentItem {
  type: string;
  text?: string;
}

interface McpCallResult {
  content: McpContentItem[];
  isError?: boolean;
}

// Type guard helpers
function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj['jsonrpc'] === '2.0' && typeof obj['id'] === 'number';
}

function isMcpToolsListResult(value: unknown): value is McpToolsListResult {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj['tools']);
}

function isMcpCallResult(value: unknown): value is McpCallResult {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj['content']);
}

// --- Bridge implementation ---

const RESTART_DELAY_MS = 2000;
const INIT_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 30000;

export class GitNexusBridge {
  private process: ChildProcess | null = null;
  private tools: ToolDefinition[] = [];
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  private stdoutBuffer = '';
  private started = false;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private available = false;

  /** Whether GitNexus was successfully initialized and tools are available. */
  get isAvailable(): boolean {
    return this.available;
  }

  /**
   * Start the GitNexus MCP process.
   * If `gitnexus` is not installed or fails to start, logs a warning and returns gracefully.
   */
  async start(): Promise<void> {
    this.stopping = false;

    try {
      await this.spawnAndInitialize();
      this.available = true;
      this.started = true;
      logger.info('GitNexus bridge started', { tools: this.tools.length });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('GitNexus bridge failed to start — code tools will be unavailable', { error: msg });
      this.available = false;
      // Don't throw — startup continues without GitNexus
    }
  }

  /** Call a GitNexus tool by name. Returns the text result or an error string. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.process || !this.available) {
      return `Error: GitNexus bridge is not available. The gitnexus process is not running.`;
    }

    try {
      const result = await this.sendRequest('tools/call', {
        name,
        arguments: args,
      }, CALL_TIMEOUT_MS);

      if (!isMcpCallResult(result)) {
        return `Error: Unexpected response format from GitNexus tool '${name}'.`;
      }

      if (result.isError) {
        const errorText = result.content
          .filter((c): c is McpContentItem & { text: string } => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n');
        return `Error from GitNexus: ${errorText || 'Unknown error'}`;
      }

      // Concatenate all text content blocks
      return result.content
        .filter((c): c is McpContentItem & { text: string } => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('GitNexus tool call failed', { name, error: msg });
      return `Error calling GitNexus tool '${name}': ${msg}`;
    }
  }

  /** Stop the bridge and kill the child process. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.available = false;
    this.started = false;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    // Reject all pending requests
    for (const [id, { reject }] of this.pending) {
      reject(new Error('GitNexus bridge is shutting down'));
      this.pending.delete(id);
    }

    if (this.process) {
      const proc = this.process;
      this.process = null;

      try {
        proc.kill('SIGTERM');

        // Give it a moment to exit, then force kill
        await new Promise<void>((resolve) => {
          const forceKillTimer = setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // Already dead
            }
            resolve();
          }, 3000);

          proc.once('exit', () => {
            clearTimeout(forceKillTimer);
            resolve();
          });
        });
      } catch {
        // Process already dead
      }
    }

    logger.info('GitNexus bridge stopped');
  }

  /** Return cached tool definitions (mapped to river-runtime format). */
  getTools(): ToolDefinition[] {
    return this.tools;
  }

  // --- Internal methods ---

  private async spawnAndInitialize(): Promise<void> {
    // Spawn the process
    const proc = spawn('gitnexus', ['mcp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    this.process = proc;
    this.stdoutBuffer = '';

    // Wire up stdout line parsing
    proc.stdout!.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf-8');
      this.processBuffer();
    });

    // Log stderr but don't fail
    proc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text) {
        logger.debug('GitNexus stderr', { text: text.substring(0, 500) });
      }
    });

    // Handle process exit
    proc.on('exit', (code, signal) => {
      logger.warn('GitNexus process exited', { code, signal });
      this.process = null;
      this.available = false;

      // Reject all pending
      for (const [id, { reject }] of this.pending) {
        reject(new Error(`GitNexus process exited (code=${code}, signal=${signal})`));
        this.pending.delete(id);
      }

      // Auto-restart if we were started and aren't shutting down
      if (this.started && !this.stopping) {
        logger.info('Scheduling GitNexus bridge restart', { delayMs: RESTART_DELAY_MS });
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.spawnAndInitialize()
            .then(() => {
              this.available = true;
              logger.info('GitNexus bridge restarted successfully', { tools: this.tools.length });
            })
            .catch((err) => {
              logger.warn('GitNexus bridge restart failed', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }, RESTART_DELAY_MS);
      }
    });

    proc.on('error', (err) => {
      logger.error('GitNexus process error', { error: err.message });
      // 'error' event is typically ENOENT (not installed)
      this.process = null;
      this.available = false;
    });

    // Wait for process to be ready (check it hasn't immediately died)
    await new Promise<void>((resolve, reject) => {
      const earlyExitHandler = (code: number | null) => {
        reject(new Error(`GitNexus process exited immediately (code=${code}). Is gitnexus installed?`));
      };
      const errorHandler = (err: Error) => {
        reject(new Error(`Failed to spawn gitnexus: ${err.message}`));
      };

      proc.once('exit', earlyExitHandler);
      proc.once('error', errorHandler);

      // Give it a tick to fail
      setTimeout(() => {
        proc.removeListener('exit', earlyExitHandler);
        proc.removeListener('error', errorHandler);
        resolve();
      }, 500);
    });

    // Send initialize
    const initResult = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'river-runtime', version: '0.1.0' },
    }, INIT_TIMEOUT_MS);

    logger.debug('GitNexus MCP initialized', { result: initResult });

    // Send initialized notification (no id, no response expected)
    this.sendNotification('notifications/initialized', {});

    // List tools
    const toolsResult = await this.sendRequest('tools/list', {}, INIT_TIMEOUT_MS);

    if (!isMcpToolsListResult(toolsResult)) {
      throw new Error('Unexpected tools/list response format');
    }

    // Convert MCP tool schemas to our ToolDefinition format
    this.tools = toolsResult.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }));

    logger.info('GitNexus tools discovered', {
      count: this.tools.length,
      names: this.tools.map((t) => t.name),
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) return;

    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.process.stdin.write(message + '\n');
  }

  private sendRequest(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error('GitNexus process is not running'));
        return;
      }

      const id = this.nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      // Set up timeout
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`GitNexus request timed out after ${timeoutMs}ms (method=${method})`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      const message = JSON.stringify(request);
      this.process.stdin.write(message + '\n');
      logger.debug('GitNexus request sent', { id, method });
    });
  }

  private processBuffer(): void {
    // Process complete lines from the buffer
    let newlineIndex: number;
    while ((newlineIndex = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (!line) continue;

      try {
        const parsed: unknown = JSON.parse(line);

        if (!isJsonRpcResponse(parsed)) {
          // Could be a notification or other message — log and skip
          logger.debug('GitNexus non-response message', { line: line.substring(0, 200) });
          continue;
        }

        const pending = this.pending.get(parsed.id);
        if (!pending) {
          logger.debug('GitNexus response for unknown id', { id: parsed.id });
          continue;
        }

        this.pending.delete(parsed.id);

        if (parsed.error) {
          pending.reject(
            new Error(`GitNexus RPC error (${parsed.error.code}): ${parsed.error.message}`)
          );
        } else {
          pending.resolve(parsed.result);
        }
      } catch {
        // Not valid JSON — likely stderr mixed in or partial output
        logger.debug('GitNexus unparseable stdout line', { line: line.substring(0, 200) });
      }
    }
  }
}
