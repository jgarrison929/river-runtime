/**
 * LLM provider interface types.
 * Wraps Anthropic's content block types into our own interfaces for provider abstraction.
 */

import type Anthropic from '@anthropic-ai/sdk';

/** Thinking configuration for extended reasoning.
 *  Opus 4.6+ uses adaptive thinking (model decides budget).
 *  Older models use manual budget_tokens. */
export interface ThinkingConfig {
  enabled: boolean;
  budget_tokens?: number; // Only for manual mode (older models). Adaptive ignores this.
}

/** Content block types aligned with Anthropic's API */
export type TextBlock = {
  type: 'text';
  text: string;
};

export type ToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};

export type ThinkingBlock = {
  type: 'thinking';
  thinking: string;
};

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: string | (ContentBlock | ToolResultBlock)[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Anthropic.Tool['input_schema'];
}

/** Callback for streaming deltas from the LLM. */
export type StreamDeltaCallback = (event: StreamDeltaEvent) => void;

export interface StreamDeltaEvent {
  type: 'text_delta' | 'thinking_delta' | 'stream_start' | 'stream_end';
  delta?: string;
  blockType?: 'text' | 'thinking';
}

export interface LLMRequest {
  model: string;
  system: string;
  messages: LLMMessage[];
  tools: ToolDefinition[];
  max_tokens: number;
  thinking?: ThinkingConfig;
  /** Optional callback for streaming token deltas to the caller. */
  onStreamDelta?: StreamDeltaCallback;
}

export interface LLMResponse {
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    thinking_tokens?: number;
  };
}

export interface LLMProvider {
  readonly name: string;
  chat(request: LLMRequest): Promise<LLMResponse>;
}
