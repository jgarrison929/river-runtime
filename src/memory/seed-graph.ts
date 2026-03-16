/**
 * Seed the knowledge graph with initial example data.
 * Demonstrates the graph structure with sample entities and relationships.
 * Idempotent — skips if graph already has nodes.
 *
 * Replace this with your own seed data to bootstrap the knowledge graph
 * with entities relevant to your use case.
 */

import type { KnowledgeGraph, NodeType } from './graph.js';
import { logger } from '../utils/logger.js';

interface SeedNode {
  name: string;
  type: NodeType;
  properties?: Record<string, unknown>;
  importance?: number;
}

interface SeedEdge {
  source: string;
  target: string;
  relationship: string;
  properties?: Record<string, unknown>;
}

const SEED_NODES: SeedNode[] = [
  {
    name: 'User',
    type: 'person',
    properties: { role: 'owner' },
    importance: 1.0,
  },
  {
    name: 'Agent',
    type: 'person',
    properties: { role: 'assistant', born: '2026-01-01' },
    importance: 1.0,
  },
  {
    name: 'Acme Corp',
    type: 'organization',
    properties: { industry: 'technology' },
    importance: 0.8,
  },
  {
    name: 'Project Alpha',
    type: 'project',
    properties: { language: 'TypeScript', path: '/home/user/projects/alpha' },
    importance: 0.7,
  },
  {
    name: 'river-runtime',
    type: 'project',
    properties: { language: 'TypeScript', path: '/home/user/projects/river-runtime' },
    importance: 0.9,
  },
  {
    name: 'WebApp',
    type: 'project',
    properties: { language: 'TypeScript/Next.js', path: '/home/user/projects/webapp' },
    importance: 0.8,
  },
  {
    name: 'TypeScript',
    type: 'technology',
    importance: 0.6,
  },
  {
    name: 'Anthropic Claude',
    type: 'technology',
    importance: 0.7,
  },
];

const SEED_EDGES: SeedEdge[] = [
  { source: 'User', target: 'Acme Corp', relationship: 'works_at' },
  { source: 'User', target: 'Agent', relationship: 'created' },
  { source: 'Agent', target: 'Project Alpha', relationship: 'builds' },
  { source: 'Agent', target: 'river-runtime', relationship: 'builds' },
  { source: 'Agent', target: 'WebApp', relationship: 'builds' },
  { source: 'Project Alpha', target: 'TypeScript', relationship: 'uses' },
  { source: 'river-runtime', target: 'TypeScript', relationship: 'uses' },
  { source: 'river-runtime', target: 'Anthropic Claude', relationship: 'uses' },
];

/** Seed the knowledge graph with initial data. Idempotent — skips if nodes exist. */
export function seedGraph(graph: KnowledgeGraph): void {
  if (!graph.isEmpty()) {
    logger.debug('Knowledge graph already seeded, skipping');
    return;
  }

  logger.info('Seeding knowledge graph with initial data');

  // Add nodes
  for (const node of SEED_NODES) {
    graph.addNode(node.name, node.type, node.properties, node.importance);
  }

  // Add edges
  for (const edge of SEED_EDGES) {
    graph.addEdge(edge.source, edge.target, edge.relationship, edge.properties);
  }

  logger.info('Knowledge graph seeded', {
    nodes: SEED_NODES.length,
    edges: SEED_EDGES.length,
  });
}
