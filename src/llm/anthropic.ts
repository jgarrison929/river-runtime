/**
 * Anthropic Claude LLM provider.
 * Uses the @anthropic-ai/sdk directly for tool-use enabled completions.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  ContentBlock,
  LLMMessage,
} from './types.js';
import { logger } from '../utils/logger.js';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({
      apiKey: apiKey || process.env['ANTHROPIC_API_KEY'],
    });
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    logger.debug('Anthropic API request', {
      model: request.model,
      messageCount: request.messages.length,
      toolCount: request.tools.length,
    });

    const anthropicMessages = request.messages.map((msg) =>
      this.convertMessage(msg)
    );

    const anthropicTools: Anthropic.Tool[] = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    try {
      // Build base request params
      let maxTokens = request.max_tokens;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const createParams: any = {
        model: request.model,
        max_tokens: maxTokens,
        system: request.system,
        messages: anthropicMessages,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      };

      // Add thinking if enabled
      if (request.thinking?.enabled) {
        // Determine if model supports adaptive thinking (Opus 4.6+, Sonnet 4.6+)
        const supportsAdaptive = request.model.includes('4-6') ||
          request.model.includes('4.6') ||
          request.model === 'claude-opus-4-6' ||
          request.model === 'claude-sonnet-4-6';

        if (supportsAdaptive) {
          // Adaptive thinking — model decides how much to think
          // budget_tokens is still required by API — set to max minus response room
          const modelMaxOutput = request.model.includes('sonnet') ? 64000 : 32000;
          createParams.thinking = {
            type: 'enabled',
            budget_tokens: modelMaxOutput - 4000,
          };
        } else if (request.thinking.budget_tokens) {
          // Manual budget for older models
          const modelMaxOutput = request.model.includes('sonnet') ? 64000 : 32000;
          const cappedBudget = Math.min(request.thinking.budget_tokens, modelMaxOutput - 4000);
          createParams.thinking = {
            type: 'enabled',
            budget_tokens: cappedBudget,
          };
        } else {
          // Fallback: manual mode with reasonable default
          createParams.thinking = {
            type: 'enabled',
            budget_tokens: 10000,
          };
        }

        // Set max_tokens to model's max output when thinking is enabled
        const modelMaxOutput = request.model.includes('sonnet') ? 64000 : 32000;
        createParams.max_tokens = modelMaxOutput;
        // Temperature MUST NOT be set when thinking is enabled
        delete createParams.temperature;

        logger.debug('Extended thinking configured', {
          mode: supportsAdaptive ? 'adaptive' : 'manual',
          maxTokens: modelMaxOutput,
          model: request.model,
        });
      }

      // Use streaming to avoid timeout issues with extended thinking
      // (stream().finalMessage() returns the same Message shape as create())
      logger.debug('Using streaming API for Anthropic request', {
        thinking: !!request.thinking?.enabled,
        model: request.model,
      });
      const stream = this.client.messages.stream(createParams);

      // If a stream delta callback is provided, wire up event listeners
      if (request.onStreamDelta) {
        const cb = request.onStreamDelta;
        cb({ type: 'stream_start' });

        stream.on('text', (textDelta: string) => {
          cb({ type: 'text_delta', delta: textDelta, blockType: 'text' });
        });

        // The SDK emits 'thinking' events for thinking block deltas
        stream.on('thinking', (thinkingDelta: string) => {
          cb({ type: 'thinking_delta', delta: thinkingDelta, blockType: 'thinking' });
        });
      }

      const response = await stream.finalMessage();

      // Signal stream end
      if (request.onStreamDelta) {
        request.onStreamDelta({ type: 'stream_end' });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const content: ContentBlock[] = response.content.map((block: any) => {
        if (block.type === 'thinking') {
          return { type: 'thinking' as const, thinking: block.thinking as string };
        }
        if (block.type === 'text') {
          return { type: 'text' as const, text: block.text as string };
        }
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            id: block.id as string,
            name: block.name as string,
            input: block.input as Record<string, unknown>,
          };
        }
        // Shouldn't happen, but handle gracefully
        return { type: 'text' as const, text: `[Unsupported block type: ${block.type}]` };
      });

      logger.debug('Anthropic API response', {
        stopReason: response.stop_reason,
        contentBlocks: content.length,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      });

      // Extract thinking tokens from usage if present
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const usageAny = response.usage as any;
      const thinkingTokens: number | undefined = usageAny.thinking_tokens ?? undefined;

      return {
        content,
        stop_reason: response.stop_reason ?? 'end_turn',
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          ...(thinkingTokens !== undefined ? { thinking_tokens: thinkingTokens } : {}),
        },
      };
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        logger.error('Anthropic API error', {
          status: err.status,
          message: err.message,
        });
      }
      throw err;
    }
  }

  private convertMessage(msg: LLMMessage): Anthropic.MessageParam {
    if (typeof msg.content === 'string') {
      return {
        role: msg.role,
        content: msg.content,
      };
    }

    // Convert content blocks
    const blocks: Anthropic.ContentBlockParam[] = msg.content.map((block) => {
      if (block.type === 'text') {
        return { type: 'text' as const, text: block.text };
      }
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use' as const,
          id: block.id,
          name: block.name,
          input: block.input,
        };
      }
      if (block.type === 'tool_result') {
        return {
          type: 'tool_result' as const,
          tool_use_id: block.tool_use_id,
          content: block.content,
          is_error: block.is_error,
        };
      }
      return { type: 'text' as const, text: '[unknown block]' };
    });

    return {
      role: msg.role,
      content: blocks,
    };
  }
}
