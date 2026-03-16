/**
 * Agent core — the main agent loop.
 * Receives an inbound message, builds context, calls the LLM with tools,
 * executes tool calls in a loop, and returns the final text response.
 */

import type { InboundMessage } from '../channels/types.js';
import type { LLMMessage, ContentBlock, ToolUseBlock, ToolResultBlock, ThinkingBlock, StreamDeltaCallback } from '../llm/types.js';
import type { LLMRouter } from '../llm/router.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ContextBuilder } from './context-builder.js';
import type { SessionManager } from './session.js';
import { logger } from '../utils/logger.js';

export interface AgentCoreOptions {
  llm: LLMRouter;
  tools: ToolRegistry;
  contextBuilder: ContextBuilder;
  sessions: SessionManager;
  maxToolLoops?: number;
  maxSessionMessages?: number;
}

export class AgentCore {
  private llm: LLMRouter;
  private tools: ToolRegistry;
  private contextBuilder: ContextBuilder;
  private sessions: SessionManager;
  private maxToolLoops: number;
  private maxSessionMessages: number;

  // Track ongoing requests to prevent double-processing
  private activeRequests: Set<string> = new Set();

  constructor(options: AgentCoreOptions) {
    this.llm = options.llm;
    this.tools = options.tools;
    this.contextBuilder = options.contextBuilder;
    this.sessions = options.sessions;
    this.maxToolLoops = options.maxToolLoops ?? 10;
    this.maxSessionMessages = options.maxSessionMessages ?? 100;
  }

  /** Result from processing a message, includes optional thinking text */
  public static readonly DUPLICATE_MSG = 'I\'m still processing your previous message. Please wait a moment.';

  /**
   * Process an inbound message through the full agent loop.
   * Returns the final text response and optional thinking content.
   * @param onStreamDelta Optional callback to stream token deltas to the caller (webchat streaming).
   *        Only fires for the *final* LLM call (not intermediate tool-use calls).
   */
  async processMessage(
    message: InboundMessage,
    onStreamDelta?: StreamDeltaCallback
  ): Promise<{ text: string; thinking?: string; thinkingTokens?: number }> {
    const { sessionKey } = message;

    // Prevent duplicate processing
    if (this.activeRequests.has(sessionKey)) {
      logger.warn('Dropping duplicate request for active session', { sessionKey });
      return { text: AgentCore.DUPLICATE_MSG };
    }

    this.activeRequests.add(sessionKey);

    try {
      return await this.runAgentLoop(message, onStreamDelta);
    } finally {
      this.activeRequests.delete(sessionKey);
    }
  }

  private async runAgentLoop(
    message: InboundMessage,
    onStreamDelta?: StreamDeltaCallback
  ): Promise<{ text: string; thinking?: string; thinkingTokens?: number }> {
    const { sessionKey, text, userName } = message;

    // Get session history
    const history = this.sessions.getHistory(sessionKey);

    // Add the user message
    const userContent = `[${userName}]: ${text}`;
    const userMessage: LLMMessage = { role: 'user', content: userContent };
    this.sessions.append(sessionKey, userMessage);

    // Build the messages array for the LLM
    // Use a copy to avoid mutating session history during tool loops
    const messages: LLMMessage[] = [...history, userMessage];

    // Build system prompt
    const systemPrompt = this.contextBuilder.buildSystemPrompt();

    // Get tool definitions — filter by channel
    // Telegram is conversational only: no exec, no computer control
    const allToolDefs = this.tools.getDefinitions();
    const TELEGRAM_BLOCKED_TOOLS = new Set([
      'exec', 'read', 'write', 'edit',
      'take_screenshot', 'computer_click', 'computer_type',
      'computer_press_key', 'list_windows', 'focus_window',
      'mouse_move', 'mouse_scroll',
    ]);
    const toolDefs = message.channel === 'telegram'
      ? allToolDefs.filter(t => !TELEGRAM_BLOCKED_TOOLS.has(t.name))
      : allToolDefs;

    logger.info('Starting agent loop', {
      sessionKey,
      historyLength: messages.length,
      toolCount: toolDefs.length,
      thinking: message.thinking?.enabled ? `budget=${message.thinking.budget_tokens}` : 'off',
    });

    // Collect thinking from all loop iterations
    let allThinking = '';
    let totalThinkingTokens = 0;

    // The tool loop
    let loops = 0;
    while (loops < this.maxToolLoops) {
      loops++;

      const response = await this.llm.chat({
        system: systemPrompt,
        messages,
        tools: toolDefs,
        thinking: message.thinking,
        onStreamDelta,
      });

      // Extract thinking blocks from this iteration
      const thinkingBlocks = response.content.filter(
        (b): b is ThinkingBlock => b.type === 'thinking'
      );
      if (thinkingBlocks.length > 0) {
        const thinkingText = thinkingBlocks.map(b => b.thinking).join('\n\n');
        allThinking += (allThinking ? '\n\n---\n\n' : '') + thinkingText;
      }
      if (response.usage.thinking_tokens) {
        totalThinkingTokens += response.usage.thinking_tokens;
      }

      // Extract tool use blocks (exclude thinking blocks)
      const toolUses = response.content.filter(
        (b): b is ToolUseBlock => b.type === 'tool_use'
      );

      // If no tool uses, we have a final text response
      if (toolUses.length === 0) {
        const textContent = response.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('');

        // Persist the assistant response (text only, not thinking)
        const assistantMessage: LLMMessage = {
          role: 'assistant',
          content: textContent,
        };
        this.sessions.append(sessionKey, assistantMessage);

        // Trim if session is getting long
        this.sessions.trim(sessionKey, this.maxSessionMessages);

        logger.info('Agent loop completed', {
          sessionKey,
          loops,
          responseLength: textContent.length,
          thinkingTokens: totalThinkingTokens || undefined,
          usage: response.usage,
        });

        return {
          text: textContent,
          thinking: allThinking || undefined,
          thinkingTokens: totalThinkingTokens || undefined,
        };
      }

      // Add assistant message with tool uses (filter out thinking blocks for session history)
      const assistantContent: ContentBlock[] = response.content.filter(
        (b) => b.type !== 'thinking'
      );
      messages.push({ role: 'assistant', content: assistantContent });

      // Execute all tools
      logger.info('Executing tools', {
        sessionKey,
        loop: loops,
        tools: toolUses.map((t) => t.name),
      });

      const toolResults: ToolResultBlock[] = await this.tools.executeAll(toolUses);

      // Add tool results as user message
      messages.push({ role: 'user', content: toolResults });
    }

    // If we hit max loops, return what we have
    logger.warn('Agent loop hit max iterations', {
      sessionKey,
      maxToolLoops: this.maxToolLoops,
    });

    return {
      text: 'I hit the maximum number of tool execution steps. Here\'s what I have so far — please try a simpler request or break it into parts.',
      thinking: allThinking || undefined,
      thinkingTokens: totalThinkingTokens || undefined,
    };
  }
}
