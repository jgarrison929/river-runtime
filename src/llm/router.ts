/**
 * LLM provider router with failover support.
 * Tries the primary provider, then falls back through the chain.
 * Providers are created lazily — unsupported providers are skipped at runtime.
 */

import type { LLMConfig, LLMModelConfig } from '../config.js';
import type { LLMProvider, LLMRequest, LLMResponse, StreamDeltaCallback } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { logger } from '../utils/logger.js';

interface ProviderEntry {
  config: LLMModelConfig;
  provider: LLMProvider | null;
  createError?: string;
}

export class LLMRouter {
  private providers: ProviderEntry[] = [];

  constructor(config: LLMConfig) {
    // Build primary (must succeed)
    const primaryProvider = this.createProvider(config.primary);
    if (!primaryProvider) {
      throw new Error(
        `Failed to create primary LLM provider: ${config.primary.provider}/${config.primary.model}`
      );
    }
    this.providers.push({
      config: config.primary,
      provider: primaryProvider,
    });

    // Build fallbacks (can fail gracefully)
    for (const fallback of config.fallbacks) {
      const provider = this.createProvider(fallback);
      this.providers.push({
        config: fallback,
        provider,
        createError: provider ? undefined : `Provider '${fallback.provider}' not yet implemented`,
      });
      if (!provider) {
        logger.warn('Fallback provider not available, will be skipped', {
          provider: fallback.provider,
          model: fallback.model,
        });
      }
    }

    logger.info('LLM router initialized', {
      primary: `${config.primary.provider}/${config.primary.model}`,
      contextWindow: config.primary.context_window ?? 200000,
      maxTokens: config.primary.max_tokens ?? 8192,
      fallbackCount: config.fallbacks.length,
      availableFallbacks: this.providers.filter((p) => p.provider !== null).length - 1,
    });
  }

  private createProvider(config: LLMModelConfig): LLMProvider | null {
    try {
      switch (config.provider) {
        case 'anthropic':
          return new AnthropicProvider();
        case 'openai':
          // Phase 2: add OpenAI provider
          logger.debug('OpenAI provider not yet implemented');
          return null;
        default:
          logger.warn('Unknown LLM provider', { provider: config.provider });
          return null;
      }
    } catch (err) {
      logger.error('Failed to create LLM provider', {
        provider: config.provider,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Send a chat request with automatic failover. */
  async chat(request: Omit<LLMRequest, 'model' | 'max_tokens'> & { onStreamDelta?: StreamDeltaCallback }): Promise<LLMResponse> {
    let lastError: Error | null = null;

    for (const entry of this.providers) {
      if (!entry.provider) continue; // Skip unavailable providers

      try {
        const fullRequest: LLMRequest = {
          ...request,
          model: entry.config.model,
          max_tokens: entry.config.max_tokens ?? 8192,
          thinking: request.thinking, // Pass through thinking config
          onStreamDelta: request.onStreamDelta, // Pass through streaming callback
        };

        return await entry.provider.chat(fullRequest);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.warn('LLM provider failed, trying next', {
          provider: entry.config.provider,
          model: entry.config.model,
          error: lastError.message,
        });
      }
    }

    throw new Error(`All LLM providers failed. Last error: ${lastError?.message ?? 'unknown'}`);
  }

  /** Get info about the primary provider. */
  getPrimaryInfo(): { provider: string; model: string; contextWindow: number; maxTokens: number } {
    const primary = this.providers[0];
    if (!primary) {
      return { provider: 'none', model: 'none', contextWindow: 0, maxTokens: 0 };
    }
    return {
      provider: primary.config.provider,
      model: primary.config.model,
      contextWindow: primary.config.context_window ?? 200000,
      maxTokens: primary.config.max_tokens ?? 8192,
    };
  }
}
