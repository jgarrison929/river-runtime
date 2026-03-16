/**
 * Episodic Memory Store — stores conversation chunks with vector embeddings
 * for semantic search over past interactions.
 *
 * Uses sqlite-vec for vector similarity search inside the same SQLite database.
 * Falls back to TypeScript cosine similarity if sqlite-vec isn't available.
 *
 * Uses the same SQLite database as PatternStore and KnowledgeBase (river.sqlite via store.ts getDb()).
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { logger } from '../utils/logger.js';
import type { EmbeddingProvider } from './embeddings.js';
import {
  cosineSimilarity,
  vectorToBuffer,
  bufferToVector,
} from './embeddings.js';

// --- Types ---

export interface EpisodeInput {
  sessionKey: string;
  content: string;
  summary?: string;
  participant?: string;
  channel?: string;
  topics?: string[];
  importance?: number;
  entities?: Array<{ name: string; type?: string }>;
}

export interface Episode {
  id: string;
  sessionKey: string;
  content: string;
  summary: string | undefined;
  participant: string | undefined;
  channel: string | undefined;
  topics: string[];
  importance: number;
  createdAt: number;
  updatedAt: number;
}

export interface EpisodeSearchResult {
  episode: Episode;
  similarity: number;
  recency: number;
  finalScore: number;
}

export interface HybridSearchOptions {
  limit?: number;
  minSimilarity?: number;
  channel?: string;
  participant?: string;
  timeRange?: { after?: number; before?: number };
  /** Weight for semantic similarity (default: 0.7). */
  similarityWeight?: number;
  /** Weight for recency (default: 0.2). */
  recencyWeight?: number;
  /** Weight for importance (default: 0.1). */
  importanceWeight?: number;
}

export interface EpisodicStats {
  totalEpisodes: number;
  dateRange: { earliest: number | null; latest: number | null };
  topEntities: Array<{ name: string; type: string | null; count: number }>;
  byChannel: Record<string, number>;
}

// --- Row types for SQLite ---

interface EpisodeRow {
  id: string;
  session_key: string;
  content: string;
  summary: string | null;
  embedding: Buffer | null;
  participant: string | null;
  channel: string | null;
  topics: string | null;
  importance: number;
  created_at: number;
  updated_at: number;
}

interface EntityRow {
  entity_name: string;
  entity_type: string | null;
  count?: number;
}

interface CountRow {
  count: number;
}

interface DateRangeRow {
  earliest: number | null;
  latest: number | null;
}

interface ChannelCountRow {
  channel: string;
  count: number;
}

interface VecSearchRow {
  id: string;
  distance: number;
}

// --- EpisodicMemory ---

export class EpisodicMemory {
  private db: Database.Database;
  private embeddings: EmbeddingProvider;
  private useVecExtension: boolean;

  constructor(db: Database.Database, embeddings: EmbeddingProvider) {
    this.db = db;
    this.embeddings = embeddings;
    this.useVecExtension = false;
    this.initialize();
    logger.info('Episodic memory initialized', {
      provider: embeddings.name,
      dimensions: embeddings.dimensions,
      vecExtension: this.useVecExtension,
    });
  }

  private initialize(): void {
    // Core episodes table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        embedding BLOB,
        participant TEXT,
        channel TEXT,
        topics TEXT,
        importance REAL DEFAULT 0.5,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS episode_entities (
        episode_id TEXT NOT NULL REFERENCES episodes(id),
        entity_name TEXT NOT NULL,
        entity_type TEXT,
        PRIMARY KEY (episode_id, entity_name)
      );

      CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_key);
      CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at);
      CREATE INDEX IF NOT EXISTS idx_episodes_importance ON episodes(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_episode_entities ON episode_entities(entity_name);
    `);

    // Try to set up sqlite-vec virtual table
    this.tryInitVec();
  }

  private tryInitVec(): void {
    try {
      // sqlite-vec is a native module that needs require() to load correctly
      const require = createRequire(import.meta.url);
      const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void };
      sqliteVec.load(this.db);

      // Create the virtual table for vector search
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS episode_vectors
        USING vec0(
          episode_id TEXT PRIMARY KEY,
          embedding float[${this.embeddings.dimensions}]
        );
      `);

      this.useVecExtension = true;
      logger.info('sqlite-vec extension loaded for vector search');
    } catch (err) {
      logger.warn('sqlite-vec not available, using TypeScript cosine similarity fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.useVecExtension = false;
    }
  }

  /**
   * Add a new episode to the store.
   * Generates an embedding and stores the episode with its metadata.
   */
  async addEpisode(input: EpisodeInput): Promise<string> {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    // Generate embedding
    let embeddingBuffer: Buffer | null = null;
    try {
      const embeddingText = this.buildEmbeddingText(input);
      const vector = await this.embeddings.embed(embeddingText);
      embeddingBuffer = vectorToBuffer(vector);
    } catch (err) {
      logger.warn('Failed to generate embedding for episode', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Insert episode
    this.db
      .prepare(
        `INSERT INTO episodes (id, session_key, content, summary, embedding,
         participant, channel, topics, importance, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.sessionKey,
        input.content,
        input.summary ?? null,
        embeddingBuffer,
        input.participant ?? null,
        input.channel ?? null,
        input.topics ? JSON.stringify(input.topics) : null,
        input.importance ?? 0.5,
        now,
        now
      );

    // Insert into vec0 virtual table if available
    if (this.useVecExtension && embeddingBuffer) {
      try {
        this.db
          .prepare(
            'INSERT INTO episode_vectors (episode_id, embedding) VALUES (?, ?)'
          )
          .run(id, embeddingBuffer);
      } catch (err) {
        logger.warn('Failed to insert into vector table', {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Insert entities
    if (input.entities && input.entities.length > 0) {
      const insertEntity = this.db.prepare(
        'INSERT OR IGNORE INTO episode_entities (episode_id, entity_name, entity_type) VALUES (?, ?, ?)'
      );
      const insertMany = this.db.transaction(
        (entities: Array<{ name: string; type?: string }>) => {
          for (const entity of entities) {
            insertEntity.run(id, entity.name.toLowerCase(), entity.type ?? null);
          }
        }
      );
      insertMany(input.entities);
    }

    logger.debug('Episode added', {
      id,
      sessionKey: input.sessionKey,
      contentLength: input.content.length,
      hasEmbedding: embeddingBuffer !== null,
      entityCount: input.entities?.length ?? 0,
    });

    return id;
  }

  /**
   * Semantic search — find episodes similar to the query.
   */
  async search(
    query: string,
    limit: number = 10,
    minSimilarity: number = 0.3
  ): Promise<EpisodeSearchResult[]> {
    let queryVector: number[];
    try {
      queryVector = await this.embeddings.embed(query);
    } catch (err) {
      logger.warn('Failed to embed search query, falling back to text search', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.textSearch(query, limit);
    }

    if (this.useVecExtension) {
      return this.vecSearch(queryVector, limit, minSimilarity);
    }

    return this.brutteForceCosineSearch(queryVector, limit, minSimilarity);
  }

  /**
   * Search using sqlite-vec extension for efficient vector similarity.
   * sqlite-vec uses L2 (Euclidean) distance. For normalized vectors:
   *   L2_distance = sqrt(2 * (1 - cosine_similarity))
   *   cosine_similarity = 1 - (distance² / 2)
   */
  private vecSearch(
    queryVector: number[],
    limit: number,
    minSimilarity: number
  ): EpisodeSearchResult[] {
    const queryBuffer = vectorToBuffer(queryVector);

    const vecResults = this.db
      .prepare(
        `SELECT episode_id as id, distance
         FROM episode_vectors
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`
      )
      .all(queryBuffer, limit * 3) as VecSearchRow[];

    const now = Math.floor(Date.now() / 1000);
    const results: EpisodeSearchResult[] = [];

    for (const vecRow of vecResults) {
      // Convert L2 distance to cosine similarity for normalized vectors
      const similarity = Math.max(0, 1 - (vecRow.distance * vecRow.distance) / 2);
      if (similarity < minSimilarity) continue;

      const episode = this.getById(vecRow.id);
      if (!episode) continue;

      const recency = this.computeRecency(episode.createdAt, now);
      const finalScore =
        similarity * 0.7 + recency * 0.2 + episode.importance * 0.1;

      results.push({ episode, similarity, recency, finalScore });
    }

    return results
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, limit);
  }

  /**
   * Brute-force cosine similarity search over all episodes.
   * Used when sqlite-vec is not available.
   */
  private brutteForceCosineSearch(
    queryVector: number[],
    limit: number,
    minSimilarity: number
  ): EpisodeSearchResult[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM episodes WHERE embedding IS NOT NULL ORDER BY created_at DESC LIMIT 10000'
      )
      .all() as EpisodeRow[];

    const now = Math.floor(Date.now() / 1000);
    const scored: EpisodeSearchResult[] = [];

    for (const row of rows) {
      if (!row.embedding) continue;

      const episodeVector = bufferToVector(row.embedding);
      const similarity = cosineSimilarity(queryVector, episodeVector);

      if (similarity < minSimilarity) continue;

      const episode = rowToEpisode(row);
      const recency = this.computeRecency(episode.createdAt, now);
      const finalScore =
        similarity * 0.7 + recency * 0.2 + episode.importance * 0.1;

      scored.push({ episode, similarity, recency, finalScore });
    }

    return scored
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, limit);
  }

  /**
   * Fallback text-based search when embeddings aren't available.
   */
  private textSearch(
    query: string,
    limit: number
  ): EpisodeSearchResult[] {
    const likeQuery = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM episodes
         WHERE content LIKE ? OR summary LIKE ? OR topics LIKE ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(likeQuery, likeQuery, likeQuery, limit) as EpisodeRow[];

    const now = Math.floor(Date.now() / 1000);
    return rows.map((row) => {
      const episode = rowToEpisode(row);
      const recency = this.computeRecency(episode.createdAt, now);
      return {
        episode,
        similarity: 0.5, // Arbitrary for text match
        recency,
        finalScore: 0.5 * 0.7 + recency * 0.2 + episode.importance * 0.1,
      };
    });
  }

  /**
   * Hybrid search — combines semantic similarity, recency, and importance weighting.
   */
  async searchHybrid(
    query: string,
    options?: HybridSearchOptions
  ): Promise<EpisodeSearchResult[]> {
    const limit = options?.limit ?? 10;
    const minSimilarity = options?.minSimilarity ?? 0.3;
    const simWeight = options?.similarityWeight ?? 0.7;
    const recWeight = options?.recencyWeight ?? 0.2;
    const impWeight = options?.importanceWeight ?? 0.1;

    // Start with semantic search (wider net)
    const candidates = await this.search(query, limit * 3, minSimilarity);

    // Apply filters
    let filtered = candidates;

    if (options?.channel) {
      filtered = filtered.filter((r) => r.episode.channel === options.channel);
    }
    if (options?.participant) {
      filtered = filtered.filter(
        (r) => r.episode.participant === options.participant
      );
    }
    if (options?.timeRange) {
      const { after, before } = options.timeRange;
      if (after) {
        filtered = filtered.filter((r) => r.episode.createdAt >= after);
      }
      if (before) {
        filtered = filtered.filter((r) => r.episode.createdAt <= before);
      }
    }

    // Re-score with custom weights
    const now = Math.floor(Date.now() / 1000);
    const rescored = filtered.map((r) => {
      const recency = this.computeRecency(r.episode.createdAt, now);
      const finalScore =
        r.similarity * simWeight +
        recency * recWeight +
        r.episode.importance * impWeight;
      return { ...r, recency, finalScore };
    });

    return rescored
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, limit);
  }

  /**
   * Find episodes that mention a specific entity.
   */
  searchByEntity(entityName: string, limit: number = 10): Episode[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM episodes e
         INNER JOIN episode_entities ee ON e.id = ee.episode_id
         WHERE ee.entity_name = ?
         ORDER BY e.created_at DESC
         LIMIT ?`
      )
      .all(entityName.toLowerCase(), limit) as EpisodeRow[];

    return rows.map(rowToEpisode);
  }

  /**
   * Find episodes within a time range.
   */
  searchByTimeRange(
    start: number,
    end: number,
    limit: number = 20
  ): Episode[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM episodes
         WHERE created_at >= ? AND created_at <= ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(start, end, limit) as EpisodeRow[];

    return rows.map(rowToEpisode);
  }

  /**
   * Get the most recent episodes.
   */
  getRecent(limit: number = 10): Episode[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM episodes ORDER BY created_at DESC LIMIT ?'
      )
      .all(limit) as EpisodeRow[];

    return rows.map(rowToEpisode);
  }

  /**
   * Update the importance score of an episode.
   */
  updateImportance(id: string, importance: number): void {
    const clamped = Math.max(0, Math.min(1, importance));
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        'UPDATE episodes SET importance = ?, updated_at = ? WHERE id = ?'
      )
      .run(clamped, now, id);

    logger.debug('Episode importance updated', { id, importance: clamped });
  }

  /**
   * Get an episode by ID.
   */
  getById(id: string): Episode | undefined {
    const row = this.db
      .prepare('SELECT * FROM episodes WHERE id = ?')
      .get(id) as EpisodeRow | undefined;

    return row ? rowToEpisode(row) : undefined;
  }

  /**
   * Get statistics about the episodic memory store.
   */
  getStats(): EpisodicStats {
    const totalEpisodes = (
      this.db.prepare('SELECT COUNT(*) as count FROM episodes').get() as CountRow
    ).count;

    const dateRange = this.db
      .prepare(
        'SELECT MIN(created_at) as earliest, MAX(created_at) as latest FROM episodes'
      )
      .get() as DateRangeRow;

    const topEntities = this.db
      .prepare(
        `SELECT entity_name, entity_type, COUNT(*) as count
         FROM episode_entities
         GROUP BY entity_name
         ORDER BY count DESC
         LIMIT 20`
      )
      .all() as Array<{ entity_name: string; entity_type: string | null; count: number }>;

    const channelRows = this.db
      .prepare(
        `SELECT channel, COUNT(*) as count FROM episodes
         WHERE channel IS NOT NULL
         GROUP BY channel`
      )
      .all() as ChannelCountRow[];

    const byChannel: Record<string, number> = {};
    for (const row of channelRows) {
      byChannel[row.channel] = row.count;
    }

    return {
      totalEpisodes,
      dateRange: {
        earliest: dateRange.earliest,
        latest: dateRange.latest,
      },
      topEntities: topEntities.map((e) => ({
        name: e.entity_name,
        type: e.entity_type,
        count: e.count,
      })),
      byChannel,
    };
  }

  // --- Private helpers ---

  /** Build the text to embed for an episode (summary + topics + truncated content). */
  private buildEmbeddingText(input: EpisodeInput): string {
    const parts: string[] = [];

    if (input.summary) {
      parts.push(input.summary);
    }
    if (input.topics && input.topics.length > 0) {
      parts.push(`Topics: ${input.topics.join(', ')}`);
    }
    // Truncate content to ~2000 chars for embedding
    const truncatedContent =
      input.content.length > 2000
        ? input.content.slice(0, 2000)
        : input.content;
    parts.push(truncatedContent);

    return parts.join('\n');
  }

  /** Compute a recency score (0-1) using exponential decay. */
  private computeRecency(createdAt: number, now: number): number {
    const daysSince = (now - createdAt) / 86400;
    return 1 / (1 + daysSince);
  }
}

// --- Helpers ---

function rowToEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    sessionKey: row.session_key,
    content: row.content,
    summary: row.summary ?? undefined,
    participant: row.participant ?? undefined,
    channel: row.channel ?? undefined,
    topics: row.topics ? (JSON.parse(row.topics) as string[]) : [],
    importance: row.importance,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
