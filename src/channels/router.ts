/**
 * Channel router — manages all channel adapters and routes messages.
 * Inbound messages are dispatched to the agent core.
 * Outbound messages are routed to the appropriate channel adapter.
 */

import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';
import { logger } from '../utils/logger.js';

export type MessageHandler = (message: InboundMessage) => Promise<void>;

export class ChannelRouter {
  private adapters: Map<string, ChannelAdapter> = new Map();
  private handler: MessageHandler | null = null;

  /** Register a channel adapter. */
  register(adapter: ChannelAdapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`Channel adapter '${adapter.name}' already registered`);
    }
    this.adapters.set(adapter.name, adapter);

    // Wire inbound messages to our central handler
    adapter.onMessage(async (message: InboundMessage) => {
      if (this.handler) {
        await this.handler(message);
      } else {
        logger.warn('No message handler registered, dropping message', {
          channel: message.channel,
          sessionKey: message.sessionKey,
        });
      }
    });

    logger.info('Registered channel adapter', { name: adapter.name });
  }

  /** Set the handler for all inbound messages. */
  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Start all registered adapters. */
  async startAll(): Promise<void> {
    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.start();
        logger.info('Channel started', { name });
      } catch (err) {
        logger.error('Failed to start channel', {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Stop all registered adapters. */
  async stopAll(): Promise<void> {
    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.stop();
        logger.info('Channel stopped', { name });
      } catch (err) {
        logger.error('Failed to stop channel', {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Send a message through the appropriate channel. */
  async send(message: OutboundMessage): Promise<void> {
    const adapter = this.adapters.get(message.channel);
    if (!adapter) {
      throw new Error(`No adapter registered for channel '${message.channel}'`);
    }
    await adapter.send(message);
  }

  /** Get connection status for all channels. */
  getStatus(): Record<string, boolean> {
    const status: Record<string, boolean> = {};
    for (const [name, adapter] of this.adapters) {
      status[name] = adapter.isConnected();
    }
    return status;
  }

  /** Get a specific adapter by name. */
  getAdapter(name: string): ChannelAdapter | undefined {
    return this.adapters.get(name);
  }
}
