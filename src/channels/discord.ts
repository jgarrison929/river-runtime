/**
 * Discord channel adapter using discord.js.
 * Handles bot setup, message routing, guild/channel allowlists, DMs, and guild messages.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
} from 'discord.js';
import type { ChannelAdapter, InboundMessage, OutboundMessage } from './types.js';
import type { DiscordChannelConfig } from '../config.js';
import { logger } from '../utils/logger.js';

export class DiscordAdapter implements ChannelAdapter {
  readonly name = 'discord';
  private client: Client;
  private config: DiscordChannelConfig;
  private handler: ((message: InboundMessage) => Promise<void>) | null = null;
  private connected = false;

  constructor(config: DiscordChannelConfig) {
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.client.on('ready', () => {
      this.connected = true;
      logger.info('Discord bot connected', {
        user: this.client.user?.tag ?? 'unknown',
        guilds: this.client.guilds.cache.size,
      });
    });

    this.client.on('messageCreate', async (msg: DiscordMessage) => {
      // Ignore bot messages (including self)
      if (msg.author.bot) return;

      // Check guild allowlist (if configured)
      if (this.config.guilds && this.config.guilds.length > 0 && msg.guild) {
        const guildConfig = this.config.guilds.find((g) => g.id === msg.guild?.id);
        if (!guildConfig) {
          logger.debug('Discord message from non-allowed guild', { guildId: msg.guild.id });
          return;
        }

        // Check channel allowlist within the guild (if configured)
        if (guildConfig.channels.length > 0 && !guildConfig.channels.includes(msg.channel.id)) {
          logger.debug('Discord message from non-allowed channel', {
            guildId: msg.guild.id,
            channelId: msg.channel.id,
          });
          return;
        }
      }

      const isDM = !msg.guild;
      const sessionKey = isDM
        ? `discord:dm:${msg.author.id}`
        : `discord:${msg.guild.id}:${msg.channel.id}`;

      const inbound: InboundMessage = {
        id: msg.id,
        channel: 'discord',
        sessionKey,
        userId: msg.author.id,
        userName: msg.author.displayName || msg.author.username,
        text: msg.content,
        timestamp: msg.createdTimestamp,
        replyTo: msg.reference?.messageId,
        raw: msg,
      };

      if (this.handler) {
        try {
          await this.handler(inbound);
        } catch (err) {
          logger.error('Error handling Discord message', {
            error: err instanceof Error ? err.message : String(err),
            messageId: inbound.id,
          });
        }
      }
    });

    this.client.on('error', (err) => {
      logger.error('Discord client error', { error: err.message });
    });

    this.client.on('warn', (msg) => {
      logger.warn('Discord client warning', { message: msg });
    });
  }

  async start(): Promise<void> {
    logger.info('Starting Discord adapter');
    await this.client.login(this.config.token);
  }

  async stop(): Promise<void> {
    logger.info('Stopping Discord adapter');
    this.connected = false;
    await this.client.destroy();
  }

  async send(message: OutboundMessage): Promise<void> {
    const channelOrUserId = message.target;

    try {
      // Resolve the target to a sendable channel
      const channel = await this.resolveChannel(channelOrUserId);

      if (!channel || !('send' in channel)) {
        throw new Error(`Channel '${channelOrUserId}' is not a text channel`);
      }

      // Discord has a 2000 char limit per message. Split if needed.
      const text = message.text;
      const sendable = channel as unknown as {
        send: (opts: { content: string; reply?: { messageReference: string } }) => Promise<unknown>;
      };

      if (text.length <= 2000) {
        const opts: { content: string; reply?: { messageReference: string } } = { content: text };
        if (message.replyTo) {
          opts.reply = { messageReference: message.replyTo };
        }
        await sendable.send(opts);
      } else {
        // Split into chunks
        const chunks = splitMessage(text, 2000);
        for (const chunk of chunks) {
          await sendable.send({ content: chunk });
        }
      }
    } catch (err) {
      logger.error('Failed to send Discord message', {
        error: err instanceof Error ? err.message : String(err),
        target: channelOrUserId,
      });
      throw err;
    }
  }

  private async resolveChannel(
    channelOrUserId: string
  ): Promise<{ send: unknown } | undefined> {
    // Try cache first
    const cached = this.client.channels.cache.get(channelOrUserId);
    if (cached) return cached as unknown as { send: unknown };

    // Try fetching as a channel
    try {
      const fetched = await this.client.channels.fetch(channelOrUserId);
      if (fetched) return fetched as unknown as { send: unknown };
    } catch {
      // Not a channel — try as a user (DM)
    }

    try {
      const user = await this.client.users.fetch(channelOrUserId);
      const dm = await user.createDM();
      return dm as unknown as { send: unknown };
    } catch (dmErr) {
      throw new Error(
        `Could not resolve target '${channelOrUserId}' as channel or user: ${dmErr instanceof Error ? dmErr.message : String(dmErr)}`
      );
    }
  }

  onMessage(handler: (message: InboundMessage) => Promise<void>): void {
    this.handler = handler;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

/** Split a long message into chunks at newline boundaries where possible. */
function splitMessage(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) {
      splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
