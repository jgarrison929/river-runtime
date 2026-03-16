/**
 * GitNexus tool handlers — wraps the GitNexus MCP bridge as ToolHandler instances
 * for registration in the ToolRegistry.
 *
 * Tools are registered dynamically based on what the GitNexus MCP server reports.
 * Each tool keeps its original `gitnexus_` prefix (already well-namespaced).
 */

import type { ToolHandler } from './registry.js';
import type { GitNexusBridge } from './gitnexus-bridge.js';
import { logger } from '../utils/logger.js';

/**
 * Create ToolHandler instances from the GitNexus bridge's discovered tools.
 * Returns an empty array if the bridge is not available (GitNexus not installed).
 */
export function createGitNexusTools(bridge: GitNexusBridge): ToolHandler[] {
  if (!bridge.isAvailable) {
    logger.debug('GitNexus bridge not available, skipping tool registration');
    return [];
  }

  const definitions = bridge.getTools();
  const handlers: ToolHandler[] = [];

  for (const definition of definitions) {
    const toolName = definition.name;

    handlers.push({
      definition,
      execute: async (input: Record<string, unknown>): Promise<string> => {
        if (!bridge.isAvailable) {
          return `Error: GitNexus is not currently available. The process may be restarting.`;
        }

        try {
          const result = await bridge.callTool(toolName, input);
          return result;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('GitNexus tool execution failed', { tool: toolName, error: msg });
          return `Error executing ${toolName}: ${msg}`;
        }
      },
    });
  }

  logger.info('Created GitNexus tool handlers', {
    count: handlers.length,
    names: handlers.map((h) => h.definition.name),
  });

  return handlers;
}
