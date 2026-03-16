/**
 * Knowledge tools — ingest_docs and query_knowledge.
 *
 * ingest_docs: Read and ingest technical documentation into River's knowledge base.
 * query_knowledge: Search the knowledge base for specific technical information.
 *
 * These tools are how River proactively learns about new APIs, versions,
 * and best practices — the core solution to the frozen-model problem.
 */

import type { ToolHandler } from './registry.js';
import type { KnowledgeBase, KnowledgeEntryType } from '../memory/knowledge.js';
import type { DocumentIngestion } from '../memory/ingestion.js';
import { logger } from '../utils/logger.js';

/**
 * Create the ingest_docs tool.
 * River uses this to absorb documentation on-the-fly.
 */
export function createIngestDocsTool(
  knowledgeBase: KnowledgeBase,
  ingestion: DocumentIngestion
): ToolHandler {
  return {
    definition: {
      name: 'ingest_docs',
      description:
        "Read and ingest technical documentation into River's knowledge base. " +
        'Use when reading docs for a new version, framework, or API. ' +
        'The knowledge will be available to all future sub-agent dispatches.',
      input_schema: {
        type: 'object' as const,
        properties: {
          url: {
            type: 'string',
            description: 'URL of the documentation to ingest',
          },
          text: {
            type: 'string',
            description: 'Raw text to ingest (alternative to URL)',
          },
          technology: {
            type: 'string',
            description: "Technology name (e.g., 'next.js', 'anthropic-sdk')",
          },
          version: {
            type: 'string',
            description: "Version (e.g., '15.0', '0.39')",
          },
        },
        required: ['technology'],
      },
    },
    execute: async (input) => {
      const technology = String(input['technology']).toLowerCase();
      const version = input['version'] ? String(input['version']) : undefined;
      const url = input['url'] ? String(input['url']) : undefined;
      const text = input['text'] ? String(input['text']) : undefined;

      if (!url && !text) {
        return 'Error: Must provide either url or text to ingest.';
      }

      try {
        let result;
        if (url) {
          result = await ingestion.ingestFromUrl(url, technology, version);
        } else {
          result = await ingestion.ingestFromText(text!, technology, version, undefined);
        }

        const stats = knowledgeBase.getStats();

        return [
          `Ingested ${result.entriesExtracted} knowledge entries for ${technology}${version ? ` v${version}` : ''}.`,
          `Source ID: ${result.sourceId}`,
          `Knowledge base now has ${stats.currentEntries} active entries across ${Object.keys(stats.byTechnology).length} technologies.`,
        ].join('\n');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('ingest_docs tool failed', { technology, error: msg });
        return `Error ingesting documentation: ${msg}`;
      }
    },
  };
}

/**
 * Create the query_knowledge tool.
 * Allows searching the knowledge base for specific technical information.
 */
export function createQueryKnowledgeTool(knowledgeBase: KnowledgeBase): ToolHandler {
  return {
    definition: {
      name: 'query_knowledge',
      description:
        "Search River's knowledge base for technical information about a specific technology, API, or concept.",
      input_schema: {
        type: 'object' as const,
        properties: {
          technology: {
            type: 'string',
            description: 'Technology to search for',
          },
          query: {
            type: 'string',
            description: 'What to search for (function name, concept, etc.)',
          },
          entry_type: {
            type: 'string',
            enum: [
              'api_signature',
              'migration_note',
              'breaking_change',
              'best_practice',
              'anti_pattern',
              'concept',
              'example',
            ],
            description: 'Filter by entry type',
          },
        },
        required: ['technology'],
      },
    },
    execute: async (input) => {
      const technology = String(input['technology']).toLowerCase();
      const query = input['query'] ? String(input['query']) : undefined;
      const entryType = input['entry_type']
        ? (String(input['entry_type']) as KnowledgeEntryType)
        : undefined;

      try {
        let entries;

        // If searching for a specific function/API name
        if (query && !entryType) {
          entries = knowledgeBase.getApiSignature(technology, query);

          // If no API signatures found, do a broader search
          if (entries.length === 0) {
            entries = knowledgeBase.findEntries(technology, undefined, undefined);
            // Filter by query text in title or content
            const lowerQuery = query.toLowerCase();
            entries = entries.filter(
              (e) =>
                e.title.toLowerCase().includes(lowerQuery) ||
                e.content.toLowerCase().includes(lowerQuery)
            );
          }
        } else if (entryType === 'breaking_change') {
          entries = knowledgeBase.getBreakingChanges(technology);
        } else if (entryType === 'best_practice') {
          entries = knowledgeBase.getBestPractices(technology);
        } else {
          entries = knowledgeBase.findEntries(technology, undefined, entryType);
        }

        if (entries.length === 0) {
          return `No knowledge found for ${technology}${query ? ` matching "${query}"` : ''}${entryType ? ` (type: ${entryType})` : ''}.`;
        }

        const formatted = entries.slice(0, 20).map((e) => {
          let line = `### [${e.entry_type}] ${e.title}`;
          if (e.version) line += ` (v${e.version})`;
          line += `\n${e.content}`;
          if (e.code_example) {
            line += `\n\`\`\`\n${e.code_example}\n\`\`\``;
          }
          if (e.tags && e.tags.length > 0) {
            line += `\nTags: ${e.tags.join(', ')}`;
          }
          return line;
        });

        return [
          `Found ${entries.length} entries for ${technology}:`,
          '',
          ...formatted,
        ].join('\n');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('query_knowledge tool failed', { technology, error: msg });
        return `Error querying knowledge: ${msg}`;
      }
    },
  };
}
