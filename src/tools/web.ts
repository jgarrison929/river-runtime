/**
 * Web tools: web_search (Brave API) and web_fetch (HTTP fetch + text extraction).
 */

import type { ToolHandler } from './registry.js';
import type { WebSearchToolConfig } from '../config.js';
import { logger } from '../utils/logger.js';

// --- Brave Search ---

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

export function createWebSearchTool(config: WebSearchToolConfig): ToolHandler {
  return {
    definition: {
      name: 'web_search',
      description:
        'Search the web using Brave Search API. Returns titles, URLs, and snippets.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Search query string',
          },
          count: {
            type: 'number',
            description: 'Number of results to return (1-10, default 5)',
          },
        },
        required: ['query'],
      },
    },
    execute: async (input) => {
      if (!config.enabled || !config.brave_api_key) {
        throw new Error('Web search is not configured (missing Brave API key)');
      }

      const query = String(input['query']);
      const count = typeof input['count'] === 'number' ? Math.min(input['count'], 10) : 5;

      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(count));

      const response = await fetch(url.toString(), {
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': config.brave_api_key,
        },
      });

      if (!response.ok) {
        throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as BraveSearchResponse;
      const results: BraveSearchResult[] = (data.web?.results ?? []).map(
        (r: BraveWebResult) => ({
          title: r.title ?? '',
          url: r.url ?? '',
          description: r.description ?? '',
        })
      );

      if (results.length === 0) {
        return 'No results found.';
      }

      return results
        .map(
          (r, i) =>
            `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`
        )
        .join('\n\n');
    },
  };
}

// --- Web Fetch ---

export function createWebFetchTool(): ToolHandler {
  return {
    definition: {
      name: 'web_fetch',
      description:
        'Fetch and extract readable content from a URL. Returns text or markdown extracted from the page.',
      input_schema: {
        type: 'object' as const,
        properties: {
          url: {
            type: 'string',
            description: 'HTTP or HTTPS URL to fetch',
          },
          max_chars: {
            type: 'number',
            description: 'Maximum characters to return (default: 50000)',
          },
        },
        required: ['url'],
      },
    },
    execute: async (input) => {
      const targetUrl = String(input['url']);
      const maxChars = typeof input['max_chars'] === 'number' ? input['max_chars'] : 50_000;

      try {
        const response = await fetch(targetUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (compatible; RiverRuntime/0.1; +https://github.com/river-runtime)',
            Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
          },
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get('content-type') ?? '';
        const text = await response.text();

        // Simple HTML tag stripping for basic readability
        // Phase 2: integrate @mozilla/readability for proper extraction
        let extracted: string;
        if (contentType.includes('text/html')) {
          extracted = stripHtml(text);
        } else {
          extracted = text;
        }

        if (extracted.length > maxChars) {
          extracted = extracted.slice(0, maxChars) + '\n\n[Truncated]';
        }

        return extracted;
      } catch (err) {
        logger.error('Web fetch failed', {
          url: targetUrl,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}

/**
 * Basic HTML to text conversion.
 * Strips tags, decodes entities, collapses whitespace.
 * Not perfect — Phase 2 will use @mozilla/readability.
 */
function stripHtml(html: string): string {
  let text = html;

  // Remove script and style blocks
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Convert common block elements to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/?(p|div|h[1-6]|li|tr|blockquote|pre)[^>]*>/gi, '\n');

  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&#x27;/g, "'");

  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  return text;
}
