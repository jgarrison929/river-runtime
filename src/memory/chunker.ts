/**
 * Conversation chunker — splits conversations into meaningful chunks for embedding.
 *
 * Rules:
 * - Target ~500 tokens per chunk (~2000 chars)
 * - Overlap 1-2 messages between chunks for context continuity
 * - Don't split in the middle of a tool call + result pair
 * - Include enough context in each chunk to be meaningful standalone
 */

import type { LLMMessage, ContentBlock, ToolResultBlock } from '../llm/types.js';

// --- Types ---

export interface Chunk {
  /** The textual content of this chunk. */
  content: string;
  /** Index of the first message in this chunk (0-based). */
  startIndex: number;
  /** Index of the last message in this chunk (inclusive, 0-based). */
  endIndex: number;
  /** Number of messages in this chunk. */
  messageCount: number;
  /** Estimated token count for this chunk. */
  estimatedTokens: number;
}

export interface ChunkOptions {
  /** Target maximum tokens per chunk (default: 500). */
  maxTokens?: number;
  /** Number of messages to overlap between chunks (default: 1). */
  overlap?: number;
  /** Don't split in the middle of a turn (default: true). */
  respectTurnBoundaries?: boolean;
}

// --- Constants ---

const DEFAULT_MAX_TOKENS = 500;
const DEFAULT_OVERLAP = 1;
const CHARS_PER_TOKEN = 4; // rough approximation

// --- Main function ---

/**
 * Split a list of LLM messages into meaningful chunks for embedding.
 */
export function chunkConversation(
  messages: LLMMessage[],
  options?: ChunkOptions
): Chunk[] {
  if (messages.length === 0) return [];

  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlap = options?.overlap ?? DEFAULT_OVERLAP;
  const respectTurnBoundaries = options?.respectTurnBoundaries ?? true;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  // First, identify tool-call groups — pairs of tool_use + tool_result that
  // should not be split. We mark messages that must stay with the previous one.
  const mustStayWithPrevious = new Set<number>();
  if (respectTurnBoundaries) {
    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1]!;
      const curr = messages[i]!;

      // If previous is assistant with tool_use, and current is user with tool_result
      if (
        prev.role === 'assistant' &&
        hasToolUse(prev) &&
        curr.role === 'user' &&
        hasToolResult(curr)
      ) {
        mustStayWithPrevious.add(i);
      }
    }
  }

  const chunks: Chunk[] = [];
  let currentStart = 0;

  while (currentStart < messages.length) {
    let currentEnd = currentStart;
    let currentChars = 0;

    // Accumulate messages until we hit the token limit
    while (currentEnd < messages.length) {
      const msgText = messageToText(messages[currentEnd]!);
      const msgChars = msgText.length;

      // If adding this message would exceed the limit and we already have content
      if (currentChars + msgChars > maxChars && currentEnd > currentStart) {
        // Check if we're breaking a tool call pair
        if (mustStayWithPrevious.has(currentEnd)) {
          // Include this message anyway — it's a tool result paired with the previous tool call
          currentChars += msgChars;
          currentEnd++;
        }
        break;
      }

      currentChars += msgChars;
      currentEnd++;

      // If the next message must stay with the current one, continue
      if (currentEnd < messages.length && mustStayWithPrevious.has(currentEnd)) {
        continue;
      }
    }

    // Build chunk content
    const chunkMessages = messages.slice(currentStart, currentEnd);
    const content = chunkMessages.map(messageToText).join('\n');

    chunks.push({
      content,
      startIndex: currentStart,
      endIndex: currentEnd - 1,
      messageCount: currentEnd - currentStart,
      estimatedTokens: Math.ceil(content.length / CHARS_PER_TOKEN),
    });

    // Move forward, accounting for overlap
    const advance = Math.max(1, currentEnd - currentStart - overlap);
    currentStart += advance;

    // Make sure we don't start in the middle of a tool pair
    while (
      currentStart < messages.length &&
      mustStayWithPrevious.has(currentStart)
    ) {
      currentStart--;
      if (currentStart <= chunks[chunks.length - 1]!.startIndex) {
        // Prevent infinite loop — just move past
        currentStart = currentEnd;
        break;
      }
    }

    // Prevent infinite loop: never go backwards
    if (currentStart <= (chunks.length > 0 ? chunks[chunks.length - 1]!.startIndex : -1)) {
      currentStart = currentEnd;
    }
  }

  return chunks;
}

/**
 * Chunk raw text (not messages) into segments of approximately maxTokens.
 * Used for indexing arbitrary text content like files or notes.
 */
export function chunkText(
  text: string,
  options?: { maxTokens?: number; overlap?: number }
): Chunk[] {
  const maxTokens = options?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapChars = (options?.overlap ?? 50) * CHARS_PER_TOKEN;
  const maxChars = maxTokens * CHARS_PER_TOKEN;

  if (text.length === 0) return [];

  // Split on paragraph boundaries
  const paragraphs = text.split(/\n\n+/);
  const chunks: Chunk[] = [];
  let currentContent = '';
  let startIdx = 0;

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i]!;

    if (currentContent.length + para.length + 2 > maxChars && currentContent.length > 0) {
      // Emit current chunk
      chunks.push({
        content: currentContent.trim(),
        startIndex: startIdx,
        endIndex: i - 1,
        messageCount: i - startIdx,
        estimatedTokens: Math.ceil(currentContent.length / CHARS_PER_TOKEN),
      });

      // Start new chunk with overlap (take the last bit of previous content)
      if (overlapChars > 0 && currentContent.length > overlapChars) {
        currentContent = currentContent.slice(-overlapChars) + '\n\n' + para;
      } else {
        currentContent = para;
      }
      startIdx = i;
    } else {
      currentContent += (currentContent.length > 0 ? '\n\n' : '') + para;
    }
  }

  // Last chunk
  if (currentContent.trim().length > 0) {
    chunks.push({
      content: currentContent.trim(),
      startIndex: startIdx,
      endIndex: paragraphs.length - 1,
      messageCount: paragraphs.length - startIdx,
      estimatedTokens: Math.ceil(currentContent.length / CHARS_PER_TOKEN),
    });
  }

  return chunks;
}

// --- Helpers ---

/** Convert an LLM message to plain text for embedding. */
function messageToText(msg: LLMMessage): string {
  const role = msg.role === 'user' ? 'User' : 'Assistant';

  if (typeof msg.content === 'string') {
    return `[${role}]: ${msg.content}`;
  }

  // Array of content blocks
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      parts.push(`[Tool: ${block.name}]`);
    } else if (block.type === 'tool_result') {
      const resultBlock = block as ToolResultBlock;
      // Truncate tool results — they can be huge
      const content = resultBlock.content;
      const truncated =
        content.length > 500 ? content.slice(0, 500) + '...' : content;
      parts.push(`[Tool Result]: ${truncated}`);
    }
  }

  return `[${role}]: ${parts.join(' ')}`;
}

/** Check if a message contains tool_use blocks. */
function hasToolUse(msg: LLMMessage): boolean {
  if (typeof msg.content === 'string') return false;
  return msg.content.some(
    (block) => (block as ContentBlock).type === 'tool_use'
  );
}

/** Check if a message contains tool_result blocks. */
function hasToolResult(msg: LLMMessage): boolean {
  if (typeof msg.content === 'string') return false;
  return msg.content.some(
    (block) => (block as ToolResultBlock).type === 'tool_result'
  );
}

/** Estimate token count for a string. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
