/**
 * Verification script for Phase 4 — Code Intelligence + Knowledge Graph.
 * Run with: npx tsx scripts/verify-phase4.ts
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodeIndex } from '../src/memory/code-index.js';
import { KnowledgeGraph } from '../src/memory/graph.js';
import { seedGraph } from '../src/memory/seed-graph.js';

const TEST_DIR = '/tmp/river-phase4-test';
mkdirSync(TEST_DIR, { recursive: true });

const db = new Database(join(TEST_DIR, 'test.sqlite'));
db.pragma('journal_mode = WAL');

console.log('=== Phase 4 Verification ===\n');

// --- Knowledge Graph ---
console.log('--- Knowledge Graph ---');

const graph = new KnowledgeGraph(db);
console.log('✓ KnowledgeGraph initialized');

// Seed it
seedGraph(graph);
console.log('✓ Graph seeded');

// Idempotent check
seedGraph(graph);
console.log('✓ Seed is idempotent (no error on second run)');

// Get node
const user = graph.getNode('User');
if (!user) throw new Error('User node not found');
console.log(`✓ getNode('User'): ${user.name}, ${user.type}, edges: ${user.edges.length}`);

// Get neighbors
const neighbors = graph.getNeighbors('User');
const neighborNames = neighbors.map(n => n.name).sort();
console.log(`✓ getNeighbors('User'): ${neighborNames.join(', ')}`);

// Verify expected neighbors
const expected = ['Acme Corp', 'Agent'];
for (const name of expected) {
  if (!neighborNames.includes(name)) {
    throw new Error(`Expected neighbor ${name} not found for User`);
  }
}
console.log('✓ All expected neighbors found: Acme Corp, Agent');

// Find path
const path = graph.findPath('Project Alpha', 'Acme Corp');
if (!path.found) throw new Error('Path not found between Project Alpha and Acme Corp');
console.log(`✓ findPath('Project Alpha', 'Acme Corp'): ${path.path.map(n => n.name).join(' → ')} (${path.hops} hops)`);
console.log(`  Relationships: ${path.relationships.join(' → ')}`);

// Most connected
const mostConnected = graph.getMostConnected(3);
console.log(`✓ getMostConnected: ${mostConnected.map(n => `${n.name}(${n.edgeCount})`).join(', ')}`);

// Stats
const graphStats = graph.getStats();
console.log(`✓ Graph stats: ${graphStats.nodeCount} nodes, ${graphStats.edgeCount} edges`);

// Get related
const related = graph.getRelated('Agent');
console.log(`✓ getRelated('Agent'): ${related.map(r => `${r.relationship} → ${r.node.name}`).join(', ')}`);

// Find contradictions (should be empty with seed data)
const contradictions = graph.findContradictions();
console.log(`✓ findContradictions: ${contradictions.length} contradictions found`);

console.log('\n--- Code Intelligence ---');

// --- Code Index ---
const codeIndex = new CodeIndex(db);
console.log('✓ CodeIndex initialized');

// Add a repo (use the river-runtime source itself)
const repoId = codeIndex.addRepo('river-runtime', process.cwd());
console.log(`✓ addRepo: ${repoId}`);

// Index the memory directory (small, fast)
codeIndex.indexFile(repoId, 'src/memory/graph.ts', process.cwd());
console.log('✓ indexFile: src/memory/graph.ts');

// Check symbols
const symbols = codeIndex.getFileSymbols('src/memory/graph.ts');
console.log(`✓ getFileSymbols: ${symbols.length} symbols found`);
const symbolNames = symbols.filter(s => s.exported).map(s => `${s.type}:${s.name}`);
console.log(`  Exported: ${symbolNames.slice(0, 8).join(', ')}${symbolNames.length > 8 ? '...' : ''}`);

// Find symbol
const found = codeIndex.findSymbol('KnowledgeGraph');
console.log(`✓ findSymbol('KnowledgeGraph'): ${found.length} results in ${found.map(f => f.filePath).join(', ')}`);

// Index another file for dependency testing
codeIndex.indexFile(repoId, 'src/memory/seed-graph.ts', process.cwd());

// Check dependencies
const deps = codeIndex.getDependencies('src/memory/seed-graph.ts');
console.log(`✓ getDependencies('seed-graph.ts'): ${deps.length} imports`);
for (const dep of deps) {
  console.log(`  → ${dep.targetPath} (${dep.importNames.join(', ')})`);
}

// Impact analysis
const impact = codeIndex.getImpactAnalysis(['src/memory/graph.ts']);
console.log(`✓ getImpactAnalysis(['graph.ts']): ${impact.directDependents.length} direct dependents, ${impact.affectedSymbols.length} affected symbols`);

// Record a change
const changeId = codeIndex.recordChange(repoId, 'src/memory/graph.ts', 'modify', ['KnowledgeGraph', 'addNode']);
console.log(`✓ recordChange: ${changeId}`);

// Get change history
const history = codeIndex.getChangeHistory('src/memory/graph.ts');
console.log(`✓ getChangeHistory: ${history.length} changes`);

// Stats
const codeStats = codeIndex.getStats();
console.log(`✓ Code index stats: ${codeStats.repos} repos, ${codeStats.files} files, ${codeStats.symbols} symbols, ${codeStats.dependencies} deps`);

console.log('\n=== All Phase 4 verifications passed! ===');

db.close();
