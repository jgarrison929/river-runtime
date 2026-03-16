/**
 * Channel type definitions.
 * Defines the common interface for all messaging channels (Telegram, Discord, webchat).
 */

export interface InboundMessage {
  /** Unique message ID from the channel */
  id: string;
  /** Channel type (telegram, discord, webchat) */
  channel: 'telegram' | 'discord' | 'webchat';
  /** Session key for routing, e.g. "telegram:12345" */
  sessionKey: string;
  /** User ID on the channel */
  userId: string;
  /** Display name of the sender */
  userName: string;
  /** Message text content */
  text: string;
  /** Unix timestamp (ms) */
  timestamp: number;
  /** Optional: reply-to message ID */
  replyTo?: string;
  /** Optional: raw channel-specific data */
  raw?: unknown;
  /** Optional: thinking/extended reasoning config from webchat */
  thinking?: { enabled: boolean; budget_tokens: number };
}

export interface OutboundMessage {
  /** Channel type */
  channel: 'telegram' | 'discord' | 'webchat';
  /** Target identifier (chat ID for Telegram, channel ID for Discord) */
  target: string;
  /** Text content */
  text: string;
  /** Optional: reply to a specific message */
  replyTo?: string;
  /** Optional: parse mode (markdown, html) */
  parseMode?: 'markdown' | 'html';
  /** Optional: thinking/reasoning text from extended thinking */
  thinking?: string;
  /** Optional: thinking token count */
  thinkingTokens?: number;
}

export interface ChannelAdapter {
  /** Channel identifier */
  readonly name: string;

  /** Start the channel (begin polling/listening) */
  start(): Promise<void>;

  /** Stop the channel gracefully */
  stop(): Promise<void>;

  /** Send a message through the channel */
  send(message: OutboundMessage): Promise<void>;

  /** Register a handler for inbound messages */
  onMessage(handler: (message: InboundMessage) => Promise<void>): void;

  /** Whether this channel is currently connected */
  isConnected(): boolean;
}
