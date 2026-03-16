/**
 * Tool registry — registers tools and dispatches execution.
 * Each tool provides its Anthropic-compatible definition and an execute function.
 */

import type { ToolDefinition, ToolUseBlock, ToolResultBlock } from '../llm/types.js';
import { logger } from '../utils/logger.js';

export interface ToolHandler {
  definition: ToolDefinition;
  execute: (input: Record<string, unknown>) => Promise<string>;
}

export class ToolRegistry {
  private tools: Map<string, ToolHandler> = new Map();

  /** Register a tool. */
  register(handler: ToolHandler): void {
    if (this.tools.has(handler.definition.name)) {
      throw new Error(`Tool '${handler.definition.name}' already registered`);
    }
    this.tools.set(handler.definition.name, handler);
    logger.debug('Registered tool', { name: handler.definition.name });
  }

  /** Get all tool definitions for passing to LLM. */
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((h) => h.definition);
  }

  /** Execute a single tool use block and return the result block. */
  async execute(toolUse: ToolUseBlock): Promise<ToolResultBlock> {
    const handler = this.tools.get(toolUse.name);

    if (!handler) {
      logger.error('Unknown tool requested', { name: toolUse.name });
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Error: Unknown tool '${toolUse.name}'`,
        is_error: true,
      };
    }

    try {
      logger.info('Executing tool', { name: toolUse.name, id: toolUse.id });
      const result = await handler.execute(toolUse.input);

      // Truncate very large results to avoid context overflow
      const maxLen = 100_000;
      const truncated =
        result.length > maxLen
          ? result.slice(0, maxLen) + `\n\n[Truncated: output exceeded ${maxLen} chars]`
          : result;

      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: truncated,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('Tool execution failed', {
        name: toolUse.name,
        id: toolUse.id,
        error: errMsg,
      });
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Error executing tool '${toolUse.name}': ${errMsg}`,
        is_error: true,
      };
    }
  }

  /** Execute multiple tool uses in parallel. */
  async executeAll(toolUses: ToolUseBlock[]): Promise<ToolResultBlock[]> {
    return Promise.all(toolUses.map((tu) => this.execute(tu)));
  }

  /** Get the count of registered tools. */
  get size(): number {
    return this.tools.size;
  }
}
