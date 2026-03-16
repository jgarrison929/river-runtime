/**
 * Document Ingestion — extracts structured technical knowledge from
 * documentation text or URLs. Uses a cheaper LLM model (Sonnet) for extraction.
 *
 * This is the core of the frozen-model solution: when River reads docs,
 * the knowledge becomes available to all future sub-agent dispatches.
 */

import { createHash } from 'node:crypto';
import { AnthropicProvider } from '../llm/anthropic.js';
import type {
  KnowledgeBase,
  KnowledgeEntryInput,
  KnowledgeEntryType,
  SourceType,
} from './knowledge.js';
import { logger } from '../utils/logger.js';

// --- Types ---

interface ExtractedEntry {
  entry_type: KnowledgeEntryType;
  title: string;
  content: string;
  code_example: string | null;
  tags: string[];
}

interface ExtractionResponse {
  entries: ExtractedEntry[];
}

export interface IngestionResult {
  sourceId: string;
  entriesExtracted: number;
  entryIds: string[];
}

// --- Constants ---

/** Cheaper model for extraction (Sonnet, not Opus). */
const EXTRACTION_MODEL = 'claude-sonnet-4-20250514';

/** Max characters per chunk (~4000 tokens ≈ 16000 chars). */
const MAX_CHUNK_CHARS = 16000;

/** Overlap between chunks to avoid splitting mid-concept. */
const CHUNK_OVERLAP = 500;

const EXTRACTION_SYSTEM_PROMPT = `You are a technical documentation extraction system. Given documentation text for a specific technology, extract structured knowledge entries.

For each piece of useful knowledge, create an entry with:
- entry_type: one of api_signature, migration_note, breaking_change, best_practice, anti_pattern, concept, example
- title: Short descriptive title
- content: The actual knowledge, precise and actionable
- code_example: A code snippet if applicable (null if not)
- tags: relevant tags as string array

Rules:
- Extract ACTIONABLE knowledge, not summaries
- API signatures should include parameter types and return types
- Breaking changes should specify what stopped working and the migration path
- Best practices should be specific enough to apply directly
- Skip boilerplate, marketing text, and information that's common knowledge
- If the text has nothing worth extracting, return empty entries array

Respond with ONLY valid JSON, no markdown fencing:
{
  "entries": [
    {
      "entry_type": "api_signature",
      "title": "createClient() function",
      "content": "Creates a new Anthropic client. Accepts ApiConfig with apiKey, baseURL, maxRetries.",
      "code_example": "const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });",
      "tags": ["initialization", "client"]
    }
  ]
}`;

// --- DocumentIngestion ---

export class DocumentIngestion {
  private knowledgeBase: KnowledgeBase;
  private llm: AnthropicProvider;

  constructor(knowledgeBase: KnowledgeBase, llm?: AnthropicProvider) {
    this.knowledgeBase = knowledgeBase;
    this.llm = llm ?? new AnthropicProvider();
  }

  /**
   * Ingest documentation from a URL. Fetches the content, then extracts knowledge.
   * Returns the source ID and the number of entries extracted.
   */
  async ingestFromUrl(
    url: string,
    technology: string,
    version?: string
  ): Promise<IngestionResult> {
    logger.info('Ingesting documentation from URL', { url, technology, version });

    // Fetch the URL content
    const text = await this.fetchUrl(url);
    const contentHash = createHash('sha256').update(text).digest('hex');

    // Record the source
    const sourceId = this.knowledgeBase.addSource({
      url,
      technology,
      version,
      title: this.extractTitle(text),
      content_hash: contentHash,
    });

    try {
      // Extract knowledge from the text
      const entryIds = await this.extractAndStore(text, technology, version, url);

      // Mark source as processed
      this.knowledgeBase.markSourceProcessed(sourceId, entryIds.length);

      logger.info('URL ingestion complete', {
        url,
        technology,
        entriesExtracted: entryIds.length,
      });

      return { sourceId, entriesExtracted: entryIds.length, entryIds };
    } catch (err) {
      this.knowledgeBase.markSourceFailed(sourceId);
      throw err;
    }
  }

  /**
   * Ingest documentation from raw text. Extracts knowledge entries directly.
   */
  async ingestFromText(
    text: string,
    technology: string,
    version?: string,
    sourceUrl?: string
  ): Promise<IngestionResult> {
    logger.info('Ingesting documentation from text', {
      technology,
      version,
      textLength: text.length,
    });

    // Record a source if URL is provided
    let sourceId = 'direct-text';
    if (sourceUrl) {
      const contentHash = createHash('sha256').update(text).digest('hex');
      sourceId = this.knowledgeBase.addSource({
        url: sourceUrl,
        technology,
        version,
        title: this.extractTitle(text),
        content_hash: contentHash,
      });
    }

    try {
      const entryIds = await this.extractAndStore(text, technology, version, sourceUrl);

      if (sourceUrl) {
        this.knowledgeBase.markSourceProcessed(sourceId, entryIds.length);
      }

      logger.info('Text ingestion complete', {
        technology,
        entriesExtracted: entryIds.length,
      });

      return { sourceId, entriesExtracted: entryIds.length, entryIds };
    } catch (err) {
      if (sourceUrl) {
        this.knowledgeBase.markSourceFailed(sourceId);
      }
      throw err;
    }
  }

  /**
   * Core extraction: chunk the text, call LLM for each chunk, store results.
   */
  private async extractAndStore(
    text: string,
    technology: string,
    version?: string,
    sourceUrl?: string
  ): Promise<string[]> {
    const chunks = this.chunkText(text);
    const allEntryIds: string[] = [];

    logger.debug('Processing document chunks', { chunkCount: chunks.length });

    for (const chunk of chunks) {
      const entries = await this.extractFromChunk(chunk, technology, version);

      for (const entry of entries) {
        const entryInput: KnowledgeEntryInput = {
          technology,
          version,
          entry_type: entry.entry_type,
          title: entry.title,
          content: entry.content,
          code_example: entry.code_example ?? undefined,
          source_url: sourceUrl,
          source_type: this.guessSourceType(sourceUrl),
          confidence: 0.7,
          tags: entry.tags,
        };

        const id = this.knowledgeBase.addEntry(entryInput);
        allEntryIds.push(id);
      }
    }

    return allEntryIds;
  }

  /**
   * Extract knowledge entries from a single text chunk via LLM.
   */
  private async extractFromChunk(
    chunk: string,
    technology: string,
    version?: string
  ): Promise<ExtractedEntry[]> {
    const userPrompt = `Technology: ${technology}${version ? `\nVersion: ${version}` : ''}

Documentation text:
${chunk}`;

    try {
      const response = await this.llm.chat({
        model: EXTRACTION_MODEL,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        tools: [],
        max_tokens: 4096,
      });

      const responseText = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');

      return this.parseExtractionResponse(responseText);
    } catch (err) {
      logger.error('Chunk extraction failed', {
        technology,
        chunkLength: chunk.length,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Parse the LLM's JSON response into typed entries.
   */
  private parseExtractionResponse(responseText: string): ExtractedEntry[] {
    try {
      const parsed = JSON.parse(responseText) as ExtractionResponse;
      return this.validateEntries(parsed.entries);
    } catch {
      // Try to extract JSON from surrounding text or markdown fencing
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as ExtractionResponse;
          return this.validateEntries(parsed.entries);
        } catch {
          logger.warn('Failed to parse extraction response JSON', {
            responseLength: responseText.length,
          });
          return [];
        }
      }
      return [];
    }
  }

  /**
   * Validate and sanitize extracted entries.
   */
  private validateEntries(entries: unknown): ExtractedEntry[] {
    if (!Array.isArray(entries)) return [];

    const validTypes: KnowledgeEntryType[] = [
      'api_signature',
      'migration_note',
      'breaking_change',
      'best_practice',
      'anti_pattern',
      'concept',
      'example',
    ];

    return entries.filter((e): e is ExtractedEntry => {
      if (typeof e !== 'object' || e === null) return false;
      const entry = e as Record<string, unknown>;

      return (
        typeof entry['entry_type'] === 'string' &&
        validTypes.includes(entry['entry_type'] as KnowledgeEntryType) &&
        typeof entry['title'] === 'string' &&
        entry['title'].length > 0 &&
        typeof entry['content'] === 'string' &&
        entry['content'].length > 0
      );
    }).map((e) => ({
      entry_type: e.entry_type,
      title: e.title,
      content: e.content,
      code_example: typeof e.code_example === 'string' ? e.code_example : null,
      tags: Array.isArray(e.tags) ? e.tags.filter((t): t is string => typeof t === 'string') : [],
    }));
  }

  /**
   * Split large documents into overlapping chunks.
   * Tries to split on paragraph boundaries to preserve context.
   */
  private chunkText(text: string): string[] {
    if (text.length <= MAX_CHUNK_CHARS) {
      return [text];
    }

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = start + MAX_CHUNK_CHARS;

      if (end < text.length) {
        // Try to find a good split point (paragraph boundary)
        const searchRegion = text.slice(end - 500, end);
        const lastParagraph = searchRegion.lastIndexOf('\n\n');
        if (lastParagraph > 0) {
          end = end - 500 + lastParagraph;
        } else {
          // Fall back to newline boundary
          const lastNewline = searchRegion.lastIndexOf('\n');
          if (lastNewline > 0) {
            end = end - 500 + lastNewline;
          }
        }
      } else {
        end = text.length;
      }

      chunks.push(text.slice(start, end));
      start = end > start ? end - CHUNK_OVERLAP : end;

      // Safety valve: prevent infinite loop
      if (end <= start + CHUNK_OVERLAP) {
        start = end;
      }
    }

    return chunks;
  }

  /**
   * Fetch content from a URL.
   */
  private async fetchUrl(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; RiverRuntime/0.1; +https://github.com/river-runtime)',
        Accept: 'text/html,application/xhtml+xml,text/plain,*/*',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} fetching ${url}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();

    // Basic HTML stripping for readability
    if (contentType.includes('text/html')) {
      return this.stripHtml(text);
    }

    return text;
  }

  /**
   * Basic HTML to text conversion.
   */
  private stripHtml(html: string): string {
    let text = html;
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/?(p|div|h[1-6]|li|tr|blockquote|pre)[^>]*>/gi, '\n');
    text = text.replace(/<[^>]+>/g, '');
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&#x27;/g, "'");
    text = text.replace(/[ \t]+/g, ' ');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
  }

  /**
   * Try to extract a page title from text content.
   */
  private extractTitle(text: string): string {
    // Try to find a heading
    const headingMatch = text.match(/^#\s+(.+)$/m);
    if (headingMatch) return headingMatch[1].trim();

    // Try HTML title
    const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) return titleMatch[1].trim();

    // Fall back to first line
    const firstLine = text.split('\n')[0]?.trim();
    return firstLine ? firstLine.slice(0, 100) : 'Untitled';
  }

  /**
   * Guess the source type from a URL.
   */
  private guessSourceType(url?: string): SourceType | undefined {
    if (!url) return undefined;

    const lower = url.toLowerCase();

    if (lower.includes('changelog') || lower.includes('releases') || lower.includes('release-notes')) {
      return 'changelog';
    }
    if (lower.includes('blog') || lower.includes('medium.com') || lower.includes('dev.to')) {
      return 'blog';
    }
    if (lower.includes('tutorial') || lower.includes('learn') || lower.includes('guide')) {
      return 'tutorial';
    }
    if (
      lower.includes('docs') ||
      lower.includes('documentation') ||
      lower.includes('api') ||
      lower.includes('reference')
    ) {
      return 'official_docs';
    }

    return undefined;
  }
}
