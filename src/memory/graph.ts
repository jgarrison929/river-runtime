/**
 * Knowledge Graph — SQLite adjacency tables for entity relationships.
 * Tracks people, projects, technologies, decisions, and their connections.
 *
 * Same SQLite database as other memory modules (river.sqlite via store.ts getDb()).
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

// --- Types ---

export type NodeType =
  | 'person'
  | 'project'
  | 'technology'
  | 'location'
  | 'organization'
  | 'decision'
  | 'concept'
  | 'repo'
  | 'file'
  | 'event';

export interface GraphNodeInput {
  name: string;
  type: NodeType;
  properties?: Record<string, unknown>;
  importance?: number;
}

export interface GraphNode {
  id: string;
  name: string;
  type: NodeType;
  properties: Record<string, unknown>;
  importance: number;
  firstSeen: number;
  lastSeen: number;
  mentionCount: number;
}

export interface GraphEdge {
  id: number;
  sourceId: string;
  targetId: string;
  relationship: string;
  properties: Record<string, unknown>;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export interface NodeWithEdges extends GraphNode {
  edges: Array<GraphEdge & { connectedNode: GraphNode }>;
}

export interface PathResult {
  found: boolean;
  path: GraphNode[];
  relationships: string[];
  hops: number;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  nodesByType: Record<string, number>;
  edgesByRelationship: Record<string, number>;
  mostConnected: Array<{ name: string; type: NodeType; edgeCount: number }>;
}

// --- Row types ---

interface NodeRow {
  id: string;
  name: string;
  type: string;
  properties: string | null;
  importance: number;
  first_seen: number;
  last_seen: number;
  mention_count: number;
}

interface EdgeRow {
  id: number;
  source_id: string;
  target_id: string;
  relationship: string;
  properties: string | null;
  confidence: number;
  created_at: number;
  updated_at: number;
}

interface CountRow {
  count: number;
}

interface TypeCountRow {
  type: string;
  count: number;
}

interface RelCountRow {
  relationship: string;
  count: number;
}

interface ConnectedRow {
  name: string;
  type: string;
  edge_count: number;
}

// --- KnowledgeGraph ---

export class KnowledgeGraph {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
    logger.info('Knowledge graph initialized');
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN (
          'person', 'project', 'technology', 'location', 'organization',
          'decision', 'concept', 'repo', 'file', 'event'
        )),
        properties TEXT,
        importance REAL DEFAULT 0.5,
        first_seen INTEGER NOT NULL DEFAULT (unixepoch()),
        last_seen INTEGER NOT NULL DEFAULT (unixepoch()),
        mention_count INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS graph_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL REFERENCES graph_nodes(id),
        target_id TEXT NOT NULL REFERENCES graph_nodes(id),
        relationship TEXT NOT NULL,
        properties TEXT,
        confidence REAL DEFAULT 0.7,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(source_id, target_id, relationship)
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_name ON graph_nodes(name);
      CREATE INDEX IF NOT EXISTS idx_nodes_type ON graph_nodes(type);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON graph_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON graph_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_relationship ON graph_edges(relationship);
    `);
  }

  /** Add or update a node (upsert by name+type). Returns the node ID. */
  addNode(name: string, type: NodeType, properties?: Record<string, unknown>, importance?: number): string {
    const now = Math.floor(Date.now() / 1000);

    // Check for existing node with same name and type
    const existing = this.db
      .prepare('SELECT id, mention_count FROM graph_nodes WHERE name = ? AND type = ?')
      .get(name, type) as { id: string; mention_count: number } | undefined;

    if (existing) {
      // Update: merge properties, bump mention count, update last_seen
      const currentRow = this.db
        .prepare('SELECT properties FROM graph_nodes WHERE id = ?')
        .get(existing.id) as { properties: string | null } | undefined;

      const currentProps: Record<string, unknown> = currentRow?.properties
        ? (JSON.parse(currentRow.properties) as Record<string, unknown>)
        : {};
      const mergedProps = properties ? { ...currentProps, ...properties } : currentProps;

      this.db
        .prepare(
          `UPDATE graph_nodes
           SET properties = ?, importance = COALESCE(?, importance),
               last_seen = ?, mention_count = mention_count + 1
           WHERE id = ?`
        )
        .run(JSON.stringify(mergedProps), importance ?? null, now, existing.id);

      return existing.id;
    }

    // Insert new node
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO graph_nodes (id, name, type, properties, importance, first_seen, last_seen, mention_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(id, name, type, properties ? JSON.stringify(properties) : null, importance ?? 0.5, now, now);

    logger.debug('Graph node added', { id, name, type });
    return id;
  }

  /** Add a relationship between two nodes (by name). Creates nodes if they don't exist. */
  addEdge(
    sourceName: string,
    targetName: string,
    relationship: string,
    properties?: Record<string, unknown>,
    confidence?: number
  ): number {
    const now = Math.floor(Date.now() / 1000);

    // Find source and target nodes
    const sourceNode = this.db
      .prepare('SELECT id FROM graph_nodes WHERE name = ?')
      .get(sourceName) as { id: string } | undefined;

    const targetNode = this.db
      .prepare('SELECT id FROM graph_nodes WHERE name = ?')
      .get(targetName) as { id: string } | undefined;

    if (!sourceNode || !targetNode) {
      logger.warn('Cannot add edge — node not found', {
        source: sourceName,
        target: targetName,
        sourceFound: !!sourceNode,
        targetFound: !!targetNode,
      });
      return -1;
    }

    // Upsert edge
    const existing = this.db
      .prepare(
        'SELECT id FROM graph_edges WHERE source_id = ? AND target_id = ? AND relationship = ?'
      )
      .get(sourceNode.id, targetNode.id, relationship) as { id: number } | undefined;

    if (existing) {
      // Update existing edge
      this.db
        .prepare(
          `UPDATE graph_edges
           SET properties = COALESCE(?, properties), confidence = COALESCE(?, confidence), updated_at = ?
           WHERE id = ?`
        )
        .run(
          properties ? JSON.stringify(properties) : null,
          confidence ?? null,
          now,
          existing.id
        );
      return existing.id;
    }

    // Insert new edge
    const result = this.db
      .prepare(
        `INSERT INTO graph_edges (source_id, target_id, relationship, properties, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sourceNode.id,
        targetNode.id,
        relationship,
        properties ? JSON.stringify(properties) : null,
        confidence ?? 0.7,
        now,
        now
      );

    logger.debug('Graph edge added', { source: sourceName, target: targetName, relationship });
    return Number(result.lastInsertRowid);
  }

  /** Get a node with all its edges. */
  getNode(name: string): NodeWithEdges | undefined {
    const nodeRow = this.db
      .prepare('SELECT * FROM graph_nodes WHERE name = ?')
      .get(name) as NodeRow | undefined;

    if (!nodeRow) return undefined;

    const node = rowToNode(nodeRow);

    // Get all edges where this node is source or target
    const edgeRows = this.db
      .prepare(
        `SELECT * FROM graph_edges WHERE source_id = ? OR target_id = ?`
      )
      .all(node.id, node.id) as EdgeRow[];

    const edges: Array<GraphEdge & { connectedNode: GraphNode }> = [];

    for (const edgeRow of edgeRows) {
      const edge = rowToEdge(edgeRow);
      const connectedId = edgeRow.source_id === node.id ? edgeRow.target_id : edgeRow.source_id;
      const connectedRow = this.db
        .prepare('SELECT * FROM graph_nodes WHERE id = ?')
        .get(connectedId) as NodeRow | undefined;

      if (connectedRow) {
        edges.push({ ...edge, connectedNode: rowToNode(connectedRow) });
      }
    }

    return { ...node, edges };
  }

  /** Get nodes within N hops of a given node (BFS). */
  getNeighbors(name: string, depth: number = 1): GraphNode[] {
    const startNode = this.db
      .prepare('SELECT id FROM graph_nodes WHERE name = ?')
      .get(name) as { id: string } | undefined;

    if (!startNode) return [];

    const visited = new Set<string>([startNode.id]);
    let currentLayer = [startNode.id];
    const results: GraphNode[] = [];

    for (let d = 0; d < depth; d++) {
      const nextLayer: string[] = [];

      for (const nodeId of currentLayer) {
        // Get all connected node IDs
        const edgeRows = this.db
          .prepare(
            `SELECT source_id, target_id FROM graph_edges
             WHERE source_id = ? OR target_id = ?`
          )
          .all(nodeId, nodeId) as Array<{ source_id: string; target_id: string }>;

        for (const row of edgeRows) {
          const connectedId = row.source_id === nodeId ? row.target_id : row.source_id;
          if (!visited.has(connectedId)) {
            visited.add(connectedId);
            nextLayer.push(connectedId);

            const nodeRow = this.db
              .prepare('SELECT * FROM graph_nodes WHERE id = ?')
              .get(connectedId) as NodeRow | undefined;
            if (nodeRow) {
              results.push(rowToNode(nodeRow));
            }
          }
        }
      }

      currentLayer = nextLayer;
      if (currentLayer.length === 0) break;
    }

    return results;
  }

  /** Find shortest path between two nodes (BFS, max depth 5). */
  findPath(fromName: string, toName: string, maxDepth: number = 5): PathResult {
    const fromNode = this.db
      .prepare('SELECT * FROM graph_nodes WHERE name = ?')
      .get(fromName) as NodeRow | undefined;
    const toNode = this.db
      .prepare('SELECT * FROM graph_nodes WHERE name = ?')
      .get(toName) as NodeRow | undefined;

    if (!fromNode || !toNode) {
      return { found: false, path: [], relationships: [], hops: 0 };
    }

    if (fromNode.id === toNode.id) {
      return { found: true, path: [rowToNode(fromNode)], relationships: [], hops: 0 };
    }

    // BFS with parent tracking
    const visited = new Set<string>([fromNode.id]);
    const parentMap = new Map<string, { parentId: string; relationship: string }>();
    let currentLayer = [fromNode.id];

    for (let depth = 0; depth < maxDepth; depth++) {
      const nextLayer: string[] = [];

      for (const nodeId of currentLayer) {
        const edgeRows = this.db
          .prepare(
            `SELECT source_id, target_id, relationship FROM graph_edges
             WHERE source_id = ? OR target_id = ?`
          )
          .all(nodeId, nodeId) as Array<{ source_id: string; target_id: string; relationship: string }>;

        for (const row of edgeRows) {
          const connectedId = row.source_id === nodeId ? row.target_id : row.source_id;
          if (visited.has(connectedId)) continue;

          visited.add(connectedId);
          parentMap.set(connectedId, { parentId: nodeId, relationship: row.relationship });
          nextLayer.push(connectedId);

          // Found the target!
          if (connectedId === toNode.id) {
            return this.reconstructPath(fromNode.id, toNode.id, parentMap);
          }
        }
      }

      currentLayer = nextLayer;
      if (currentLayer.length === 0) break;
    }

    return { found: false, path: [], relationships: [], hops: 0 };
  }

  /** Flexible query — filter nodes by type and/or edges by relationship. */
  query(nodeType?: NodeType, relationship?: string): Array<GraphNode & { edges: GraphEdge[] }> {
    let nodeRows: NodeRow[];

    if (nodeType) {
      nodeRows = this.db
        .prepare('SELECT * FROM graph_nodes WHERE type = ? ORDER BY importance DESC LIMIT 100')
        .all(nodeType) as NodeRow[];
    } else {
      nodeRows = this.db
        .prepare('SELECT * FROM graph_nodes ORDER BY importance DESC LIMIT 100')
        .all() as NodeRow[];
    }

    return nodeRows.map((nodeRow) => {
      const node = rowToNode(nodeRow);
      let edgeSql = 'SELECT * FROM graph_edges WHERE source_id = ? OR target_id = ?';
      const params: string[] = [node.id, node.id];

      if (relationship) {
        edgeSql += ' AND relationship = ?';
        params.push(relationship);
      }

      const edgeRows = this.db.prepare(edgeSql).all(...params) as EdgeRow[];
      return { ...node, edges: edgeRows.map(rowToEdge) };
    });
  }

  /** Get everything related to an entity (optionally filtered by relationship type). */
  getRelated(name: string, relationship?: string): Array<{ node: GraphNode; relationship: string; direction: 'outgoing' | 'incoming' }> {
    const sourceNode = this.db
      .prepare('SELECT id FROM graph_nodes WHERE name = ?')
      .get(name) as { id: string } | undefined;

    if (!sourceNode) return [];

    let edgeSql = 'SELECT * FROM graph_edges WHERE source_id = ? OR target_id = ?';
    const params: string[] = [sourceNode.id, sourceNode.id];

    if (relationship) {
      edgeSql += ' AND relationship = ?';
      params.push(relationship);
    }

    const edgeRows = this.db.prepare(edgeSql).all(...params) as EdgeRow[];
    const results: Array<{ node: GraphNode; relationship: string; direction: 'outgoing' | 'incoming' }> = [];

    for (const row of edgeRows) {
      const connectedId = row.source_id === sourceNode.id ? row.target_id : row.source_id;
      const direction = row.source_id === sourceNode.id ? 'outgoing' as const : 'incoming' as const;

      const nodeRow = this.db
        .prepare('SELECT * FROM graph_nodes WHERE id = ?')
        .get(connectedId) as NodeRow | undefined;

      if (nodeRow) {
        results.push({
          node: rowToNode(nodeRow),
          relationship: row.relationship,
          direction,
        });
      }
    }

    return results;
  }

  /**
   * Find potential contradictions — edges where the same relationship type
   * exists multiple times for the same source (e.g., two 'works_at' for same person).
   */
  findContradictions(): Array<{
    nodeName: string;
    relationship: string;
    conflicting: Array<{ target: string; confidence: number }>;
  }> {
    // Find cases where one node has multiple edges with the same singular relationship
    const SINGULAR_RELATIONSHIPS = new Set([
      'works_at', 'married_to', 'lives_in', 'born_in', 'reports_to',
    ]);

    const contradictions: Array<{
      nodeName: string;
      relationship: string;
      conflicting: Array<{ target: string; confidence: number }>;
    }> = [];

    for (const rel of SINGULAR_RELATIONSHIPS) {
      const rows = this.db
        .prepare(
          `SELECT n.name as node_name, e.source_id, e.relationship,
                  COUNT(*) as edge_count
           FROM graph_edges e
           INNER JOIN graph_nodes n ON e.source_id = n.id
           WHERE e.relationship = ?
           GROUP BY e.source_id, e.relationship
           HAVING COUNT(*) > 1`
        )
        .all(rel) as Array<{ node_name: string; source_id: string; relationship: string; edge_count: number }>;

      for (const row of rows) {
        const edges = this.db
          .prepare(
            `SELECT t.name as target_name, e.confidence
             FROM graph_edges e
             INNER JOIN graph_nodes t ON e.target_id = t.id
             WHERE e.source_id = ? AND e.relationship = ?`
          )
          .all(row.source_id, rel) as Array<{ target_name: string; confidence: number }>;

        contradictions.push({
          nodeName: row.node_name,
          relationship: rel,
          conflicting: edges.map((e) => ({ target: e.target_name, confidence: e.confidence })),
        });
      }
    }

    return contradictions;
  }

  /** Get nodes with the most edges (most connected/important entities). */
  getMostConnected(limit: number = 10): Array<{ name: string; type: NodeType; edgeCount: number }> {
    const rows = this.db
      .prepare(
        `SELECT n.name, n.type, COUNT(*) as edge_count
         FROM graph_nodes n
         LEFT JOIN (
           SELECT source_id as node_id FROM graph_edges
           UNION ALL
           SELECT target_id as node_id FROM graph_edges
         ) e ON n.id = e.node_id
         GROUP BY n.id
         ORDER BY edge_count DESC
         LIMIT ?`
      )
      .all(limit) as ConnectedRow[];

    return rows.map((r) => ({
      name: r.name,
      type: r.type as NodeType,
      edgeCount: r.edge_count,
    }));
  }

  /** Get summary stats about the graph. */
  getStats(): GraphStats {
    const nodeCount = (this.db.prepare('SELECT COUNT(*) as count FROM graph_nodes').get() as CountRow).count;
    const edgeCount = (this.db.prepare('SELECT COUNT(*) as count FROM graph_edges').get() as CountRow).count;

    const typeRows = this.db
      .prepare('SELECT type, COUNT(*) as count FROM graph_nodes GROUP BY type')
      .all() as TypeCountRow[];

    const nodesByType: Record<string, number> = {};
    for (const row of typeRows) {
      nodesByType[row.type] = row.count;
    }

    const relRows = this.db
      .prepare('SELECT relationship, COUNT(*) as count FROM graph_edges GROUP BY relationship')
      .all() as RelCountRow[];

    const edgesByRelationship: Record<string, number> = {};
    for (const row of relRows) {
      edgesByRelationship[row.relationship] = row.count;
    }

    const mostConnected = this.getMostConnected(5);

    return { nodeCount, edgeCount, nodesByType, edgesByRelationship, mostConnected };
  }

  /** Check if the graph has any nodes. */
  isEmpty(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM graph_nodes').get() as CountRow;
    return row.count === 0;
  }

  // --- Private helpers ---

  private reconstructPath(
    fromId: string,
    toId: string,
    parentMap: Map<string, { parentId: string; relationship: string }>
  ): PathResult {
    const pathIds: string[] = [toId];
    const relationships: string[] = [];
    let currentId = toId;

    while (currentId !== fromId) {
      const parent = parentMap.get(currentId);
      if (!parent) break; // Should not happen in a valid BFS
      relationships.unshift(parent.relationship);
      pathIds.unshift(parent.parentId);
      currentId = parent.parentId;
    }

    const path: GraphNode[] = [];
    for (const id of pathIds) {
      const row = this.db
        .prepare('SELECT * FROM graph_nodes WHERE id = ?')
        .get(id) as NodeRow | undefined;
      if (row) {
        path.push(rowToNode(row));
      }
    }

    return {
      found: true,
      path,
      relationships,
      hops: relationships.length,
    };
  }
}

// --- Row converters ---

function rowToNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    name: row.name,
    type: row.type as NodeType,
    properties: row.properties ? (JSON.parse(row.properties) as Record<string, unknown>) : {},
    importance: row.importance,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    mentionCount: row.mention_count,
  };
}

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    relationship: row.relationship,
    properties: row.properties ? (JSON.parse(row.properties) as Record<string, unknown>) : {},
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
