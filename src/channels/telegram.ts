/**
 * Telegram channel adapter using Grammy + Runner (same as OpenClaw).
 * Runner handles polling lifecycle, retries, backoff, concurrency.
 * Throttler prevents hitting Telegram API rate limits.
 */

import { Bot, type Context } from 'grammy';
import { run, type RunnerHandle } from '@grammyjs/runner';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';
import type { TelegramChannelConfig } from '../config.js';
import { logger } from '../utils/logger.js';

export class TelegramAdapter implements ChannelAdapter {
  readonly name = 'telegram';
  private bot: Bot;
  private config: TelegramChannelConfig;
  private handler: ((message: InboundMessage) => Promise<void>) | null = null;
  private connected = false;
  private runner: RunnerHandle | null = null;

  constructor(config: TelegramChannelConfig) {
    this.config = config;
    this.bot = new Bot(config.token);
  }

  async start(): Promise<void> {
    logger.info('Starting Telegram adapter');

    // Install throttler to prevent API rate limit errors
    this.bot.api.config.use(apiThrottler());

    // Set up message handler
    this.bot.on('message:text', async (ctx: Context) => {
      if (!ctx.message?.text || !ctx.from) return;

      const userId = String(ctx.from.id);
      if (this.config.allowed_users.length > 0 && !this.config.allowed_users.includes(userId)) {
        logger.warn('Telegram message from non-allowed user', { userId });
        return;
      }

      logger.info('Inbound Telegram message', {
        userId,
        userName: ctx.from.first_name,
        chatId: ctx.chat?.id,
        textLength: ctx.message.text.length,
      });

      const inbound: InboundMessage = {
        id: String(ctx.message.message_id),
        channel: 'telegram',
        sessionKey: `telegram:${ctx.chat?.id}`,
        userId,
        userName: ctx.from.first_name || ctx.from.username || 'Unknown',
        text: ctx.message.text,
        timestamp: ctx.message.date * 1000,
        replyTo: ctx.message.reply_to_message
          ? String(ctx.message.reply_to_message.message_id)
          : undefined,
      };

      if (this.handler) {
        try {
          await this.handler(inbound);
        } catch (err) {
          logger.error('Error handling Telegram message', {
            error: err instanceof Error ? err.message : String(err),
            messageId: inbound.id,
          });
        }
      }
    });

    // Grammy error handler — don't crash on individual errors
    this.bot.catch((err) => {
      logger.error('Grammy error', { error: err.message });
    });

    // Use @grammyjs/runner for resilient polling (same as OpenClaw)
    // Runner handles: retry with backoff, error recovery, graceful shutdown
    this.runner = run(this.bot, {
      runner: {
        fetch: {
          // Drop old updates on startup
          allowed_updates: ['message'],
        },
      },
    });

    // Wait for bot info to be available
    try {
      await this.bot.init();
      logger.info('Telegram bot started via Grammy runner', {
        username: this.bot.botInfo.username,
        id: this.bot.botInfo.id,
      });
      this.connected = true;
    } catch (err) {
      logger.warn('Telegram bot.init() failed, runner still active', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Runner will keep retrying internally
      this.connected = true;
    }

    logger.info('Telegram adapter started');
  }

  async stop(): Promise<void> {
    logger.info('Stopping Telegram adapter');
    this.connected = false;
    if (this.runner) {
      this.runner.stop();
      this.runner = null;
    }
  }

  async send(message: OutboundMessage): Promise<void> {
    const chatId = message.target;
    try {
      const text = message.text;
      if (text.length <= 4096) {
        await this.bot.api.sendMessage(chatId, text, {
          reply_to_message_id: message.replyTo ? Number(message.replyTo) : undefined,
        });
        logger.info('Response sent', { channel: 'telegram', chatId });
      } else {
        const chunks = splitMessage(text, 4096);
        for (const chunk of chunks) {
          await this.bot.api.sendMessage(chatId, chunk);
        }
        logger.info('Response sent (chunked)', {
          channel: 'telegram',
          chatId,
          chunks: chunks.length,
        });
      }
    } catch (err) {
      logger.error('Failed to send Telegram message', {
        error: err instanceof Error ? err.message : String(err),
        chatId,
      });
      throw err;
    }
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
