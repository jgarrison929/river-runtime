/**
 * Code Intelligence — tracks codebase structure at the symbol level
 * for impact analysis, dependency mapping, and change tracking.
 *
 * Uses regex-based symbol extraction (80% accuracy > full AST complexity).
 * Same SQLite database as other memory modules (river.sqlite via store.ts getDb()).
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { logger } from '../utils/logger.js';

// --- Types ---

export interface CodeRepo {
  id: string;
  name: string;
  path: string;
  lastIndexed: number | null;
  createdAt: number;
}

export interface CodeFile {
  id: string;
  repoId: string;
  path: string;
  language: string | null;
  lastModified: number | null;
  lastIndexed: number | null;
  lineCount: number | null;
  createdAt: number;
}

export interface CodeSymbol {
  id: string;
  fileId: string;
  name: string;
  type: SymbolType;
  signature: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  exported: boolean;
  createdAt: number;
}

export type SymbolType = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'export';

export interface CodeDependency {
  id: number;
  sourceFileId: string;
  targetFileId: string | null;
  targetPath: string;
  importNames: string[];
  createdAt: number;
}

export interface CodeChange {
  id: string;
  repoId: string;
  filePath: string;
  changeType: 'add' | 'modify' | 'delete';
  symbolsAffected: string[];
  commitHash: string | null;
  taskId: string | null;
  description: string | null;
  createdAt: number;
}

export interface ImpactAnalysisResult {
  changedFiles: string[];
  directDependents: string[];
  transitiveDependents: string[];
  affectedSymbols: string[];
}

export interface CodeIndexStats {
  repos: number;
  files: number;
  symbols: number;
  dependencies: number;
  changes: number;
}

// --- Row types ---

interface RepoRow {
  id: string;
  name: string;
  path: string;
  last_indexed: number | null;
  created_at: number;
}

interface FileRow {
  id: string;
  repo_id: string;
  path: string;
  language: string | null;
  last_modified: number | null;
  last_indexed: number | null;
  line_count: number | null;
  created_at: number;
}

interface SymbolRow {
  id: string;
  file_id: string;
  name: string;
  type: string;
  signature: string | null;
  line_start: number | null;
  line_end: number | null;
  exported: number;
  created_at: number;
}

interface DependencyRow {
  id: number;
  source_file_id: string;
  target_file_id: string | null;
  target_path: string;
  import_names: string | null;
  created_at: number;
}

interface ChangeRow {
  id: string;
  repo_id: string;
  file_path: string;
  change_type: string;
  symbols_affected: string | null;
  commit_hash: string | null;
  task_id: string | null;
  description: string | null;
  created_at: number;
}

interface CountRow {
  count: number;
}

// --- Extracted symbol/import types ---

interface ExtractedSymbol {
  name: string;
  type: SymbolType;
  signature: string | null;
  lineStart: number;
  exported: boolean;
}

interface ExtractedImport {
  names: string[];
  path: string;
}

// --- Supported file extensions ---

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

function getLanguage(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts': return 'typescript';
    case '.tsx': return 'tsx';
    case '.js': return 'javascript';
    case '.jsx': return 'jsx';
    default: return null;
  }
}

// --- CodeIndex ---

export class CodeIndex {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
    logger.info('Code index initialized');
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_repos (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        last_indexed INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS code_files (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES code_repos(id),
        path TEXT NOT NULL,
        language TEXT,
        last_modified INTEGER,
        last_indexed INTEGER,
        line_count INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(repo_id, path)
      );

      CREATE TABLE IF NOT EXISTS code_symbols (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES code_files(id),
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('function', 'class', 'interface', 'type', 'enum', 'variable', 'export')),
        signature TEXT,
        line_start INTEGER,
        line_end INTEGER,
        exported INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS code_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_file_id TEXT NOT NULL REFERENCES code_files(id),
        target_file_id TEXT,
        target_path TEXT NOT NULL,
        import_names TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(source_file_id, target_path)
      );

      CREATE TABLE IF NOT EXISTS code_changes (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES code_repos(id),
        file_path TEXT NOT NULL,
        change_type TEXT CHECK(change_type IN ('add', 'modify', 'delete')),
        symbols_affected TEXT,
        commit_hash TEXT,
        task_id TEXT,
        description TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_code_files_repo ON code_files(repo_id);
      CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(name);
      CREATE INDEX IF NOT EXISTS idx_code_deps_source ON code_dependencies(source_file_id);
      CREATE INDEX IF NOT EXISTS idx_code_deps_target ON code_dependencies(target_path);
      CREATE INDEX IF NOT EXISTS idx_code_changes_repo ON code_changes(repo_id);
    `);
  }

  /** Register a repository to track. Returns the repo ID. */
  addRepo(name: string, path: string): string {
    // Check if repo already exists by name
    const existing = this.db
      .prepare('SELECT id FROM code_repos WHERE name = ?')
      .get(name) as { id: string } | undefined;

    if (existing) {
      logger.debug('Repo already registered', { name, id: existing.id });
      return existing.id;
    }

    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    this.db
      .prepare('INSERT INTO code_repos (id, name, path, created_at) VALUES (?, ?, ?, ?)')
      .run(id, name, path, now);

    logger.info('Code repo registered', { id, name, path });
    return id;
  }

  /** Scan all code files in a repo, extract symbols and imports. */
  indexRepo(repoId: string): void {
    const repo = this.db
      .prepare('SELECT * FROM code_repos WHERE id = ?')
      .get(repoId) as RepoRow | undefined;

    if (!repo) {
      logger.warn('Repo not found for indexing', { repoId });
      return;
    }

    if (!existsSync(repo.path)) {
      logger.warn('Repo path does not exist', { repoId, path: repo.path });
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const files = this.walkDirectory(repo.path);

    logger.info('Indexing repo', { name: repo.name, fileCount: files.length });

    let indexed = 0;
    for (const absPath of files) {
      const relPath = relative(repo.path, absPath);
      try {
        this.indexFile(repoId, relPath, repo.path);
        indexed++;
      } catch (err) {
        logger.warn('Failed to index file', {
          file: relPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Update last_indexed timestamp
    this.db
      .prepare('UPDATE code_repos SET last_indexed = ? WHERE id = ?')
      .run(now, repoId);

    logger.info('Repo indexing complete', { name: repo.name, indexed, total: files.length });
  }

  /** Index a single file — extract symbols and imports. */
  indexFile(repoId: string, filePath: string, repoPath?: string): void {
    // Resolve repo path if not provided
    if (!repoPath) {
      const repo = this.db
        .prepare('SELECT path FROM code_repos WHERE id = ?')
        .get(repoId) as { path: string } | undefined;
      if (!repo) return;
      repoPath = repo.path;
    }

    const absPath = join(repoPath, filePath);
    if (!existsSync(absPath)) return;

    const stat = statSync(absPath);
    const content = readFileSync(absPath, 'utf-8');
    const lines = content.split('\n');
    const language = getLanguage(filePath);
    const now = Math.floor(Date.now() / 1000);

    // Upsert the file record
    const fileId = this.upsertFile(repoId, filePath, language, Math.floor(stat.mtimeMs / 1000), lines.length, now);

    // Clear existing symbols and deps for this file (re-index)
    this.db.prepare('DELETE FROM code_symbols WHERE file_id = ?').run(fileId);
    this.db.prepare('DELETE FROM code_dependencies WHERE source_file_id = ?').run(fileId);

    // Extract symbols
    const symbols = extractSymbols(content);
    const insertSymbol = this.db.prepare(
      `INSERT INTO code_symbols (id, file_id, name, type, signature, line_start, exported, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertSymbols = this.db.transaction((syms: ExtractedSymbol[]) => {
      for (const sym of syms) {
        insertSymbol.run(
          randomUUID(),
          fileId,
          sym.name,
          sym.type,
          sym.signature,
          sym.lineStart,
          sym.exported ? 1 : 0,
          now
        );
      }
    });
    insertSymbols(symbols);

    // Extract imports
    const imports = extractImports(content);
    const insertDep = this.db.prepare(
      `INSERT OR IGNORE INTO code_dependencies (source_file_id, target_path, import_names, created_at)
       VALUES (?, ?, ?, ?)`
    );

    const insertDeps = this.db.transaction((imps: ExtractedImport[]) => {
      for (const imp of imps) {
        insertDep.run(fileId, imp.path, JSON.stringify(imp.names), now);
      }
    });
    insertDeps(imports);

    // Update file's last_indexed
    this.db
      .prepare('UPDATE code_files SET last_indexed = ? WHERE id = ?')
      .run(now, fileId);
  }

  /** List symbols in a file (by relative path). */
  getFileSymbols(filePath: string): CodeSymbol[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM code_symbols s
         INNER JOIN code_files f ON s.file_id = f.id
         WHERE f.path = ?
         ORDER BY s.line_start`
      )
      .all(filePath) as SymbolRow[];

    return rows.map(rowToSymbol);
  }

  /** Find where a symbol is defined (by name). */
  findSymbol(name: string): Array<CodeSymbol & { filePath: string; repoName: string }> {
    const rows = this.db
      .prepare(
        `SELECT s.*, f.path as file_path, r.name as repo_name
         FROM code_symbols s
         INNER JOIN code_files f ON s.file_id = f.id
         INNER JOIN code_repos r ON f.repo_id = r.id
         WHERE s.name = ?
         ORDER BY s.exported DESC`
      )
      .all(name) as Array<SymbolRow & { file_path: string; repo_name: string }>;

    return rows.map((row) => ({
      ...rowToSymbol(row),
      filePath: row.file_path,
      repoName: row.repo_name,
    }));
  }

  /** What files import from this file? */
  getDependents(filePath: string): CodeFile[] {
    // Find files that have a dependency targeting this file path
    // We need to match various import patterns (with/without extension, relative paths)
    const baseName = filePath.replace(/\.(ts|tsx|js|jsx)$/, '');
    const patterns = [filePath, baseName, `./${filePath}`, `./${baseName}`];

    const results: Map<string, FileRow> = new Map();

    for (const pattern of patterns) {
      const rows = this.db
        .prepare(
          `SELECT f.* FROM code_files f
           INNER JOIN code_dependencies d ON d.source_file_id = f.id
           WHERE d.target_path LIKE ?`
        )
        .all(`%${pattern}%`) as FileRow[];

      for (const row of rows) {
        results.set(row.id, row);
      }
    }

    return Array.from(results.values()).map(rowToFile);
  }

  /** What does this file import? */
  getDependencies(filePath: string): CodeDependency[] {
    const rows = this.db
      .prepare(
        `SELECT d.* FROM code_dependencies d
         INNER JOIN code_files f ON d.source_file_id = f.id
         WHERE f.path = ?`
      )
      .all(filePath) as DependencyRow[];

    return rows.map(rowToDependency);
  }

  /** Given a list of changed files, return all files that might be affected. */
  getImpactAnalysis(filePaths: string[]): ImpactAnalysisResult {
    const directDependents = new Set<string>();
    const transitiveDependents = new Set<string>();
    const affectedSymbols: string[] = [];

    // Get direct dependents for each changed file
    for (const fp of filePaths) {
      const dependents = this.getDependents(fp);
      for (const dep of dependents) {
        if (!filePaths.includes(dep.path)) {
          directDependents.add(dep.path);
        }
      }

      // Get symbols from changed files
      const symbols = this.getFileSymbols(fp);
      for (const sym of symbols) {
        if (sym.exported) {
          affectedSymbols.push(sym.name);
        }
      }
    }

    // Get transitive dependents (one more hop)
    for (const directDep of directDependents) {
      const secondOrder = this.getDependents(directDep);
      for (const dep of secondOrder) {
        if (!filePaths.includes(dep.path) && !directDependents.has(dep.path)) {
          transitiveDependents.add(dep.path);
        }
      }
    }

    return {
      changedFiles: filePaths,
      directDependents: Array.from(directDependents),
      transitiveDependents: Array.from(transitiveDependents),
      affectedSymbols,
    };
  }

  /** Record a code change event. */
  recordChange(
    repoId: string,
    filePath: string,
    changeType: 'add' | 'modify' | 'delete',
    symbolsAffected: string[],
    taskId?: string,
    description?: string,
    commitHash?: string
  ): string {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    this.db
      .prepare(
        `INSERT INTO code_changes (id, repo_id, file_path, change_type, symbols_affected,
         commit_hash, task_id, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        repoId,
        filePath,
        changeType,
        JSON.stringify(symbolsAffected),
        commitHash ?? null,
        taskId ?? null,
        description ?? null,
        now
      );

    logger.debug('Code change recorded', { id, filePath, changeType });
    return id;
  }

  /** Get recent change history, optionally filtered by file or repo. */
  getChangeHistory(filePath?: string, repoId?: string, limit: number = 50): CodeChange[] {
    let sql = 'SELECT * FROM code_changes WHERE 1=1';
    const params: (string | number)[] = [];

    if (filePath) {
      sql += ' AND file_path = ?';
      params.push(filePath);
    }
    if (repoId) {
      sql += ' AND repo_id = ?';
      params.push(repoId);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as ChangeRow[];
    return rows.map(rowToChange);
  }

  /** Get stats about the code index. */
  getStats(): CodeIndexStats {
    const repos = (this.db.prepare('SELECT COUNT(*) as count FROM code_repos').get() as CountRow).count;
    const files = (this.db.prepare('SELECT COUNT(*) as count FROM code_files').get() as CountRow).count;
    const symbols = (this.db.prepare('SELECT COUNT(*) as count FROM code_symbols').get() as CountRow).count;
    const dependencies = (this.db.prepare('SELECT COUNT(*) as count FROM code_dependencies').get() as CountRow).count;
    const changes = (this.db.prepare('SELECT COUNT(*) as count FROM code_changes').get() as CountRow).count;

    return { repos, files, symbols, dependencies, changes };
  }

  // --- Private helpers ---

  private upsertFile(
    repoId: string,
    path: string,
    language: string | null,
    lastModified: number,
    lineCount: number,
    now: number
  ): string {
    const existing = this.db
      .prepare('SELECT id FROM code_files WHERE repo_id = ? AND path = ?')
      .get(repoId, path) as { id: string } | undefined;

    if (existing) {
      this.db
        .prepare(
          'UPDATE code_files SET language = ?, last_modified = ?, line_count = ? WHERE id = ?'
        )
        .run(language, lastModified, lineCount, existing.id);
      return existing.id;
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO code_files (id, repo_id, path, language, last_modified, line_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, repoId, path, language, lastModified, lineCount, now);
    return id;
  }

  /** Recursively walk a directory, returning code file paths. */
  private walkDirectory(dir: string): string[] {
    const results: string[] = [];
    const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo']);

    const walk = (current: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(current);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue;

        const fullPath = join(current, entry);
        let stat;
        try {
          stat = statSync(fullPath);
        } catch {
          continue;
        }

        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (stat.isFile() && CODE_EXTENSIONS.has(extname(entry).toLowerCase())) {
          results.push(fullPath);
        }
      }
    };

    walk(dir);
    return results;
  }
}

// --- Regex-based symbol extraction ---

/** Extract exported symbols from TypeScript/JavaScript source. */
function extractSymbols(content: string): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      continue;
    }

    // export function name(
    const funcMatch = /^export\s+(?:async\s+)?function\s+(\w+)\s*[\(<]/.exec(trimmed);
    if (funcMatch?.[1]) {
      symbols.push({
        name: funcMatch[1],
        type: 'function',
        signature: trimmed.slice(0, 200),
        lineStart: i + 1,
        exported: true,
      });
      continue;
    }

    // export class Name
    const classMatch = /^export\s+(?:abstract\s+)?class\s+(\w+)/.exec(trimmed);
    if (classMatch?.[1]) {
      symbols.push({
        name: classMatch[1],
        type: 'class',
        signature: trimmed.slice(0, 200),
        lineStart: i + 1,
        exported: true,
      });
      continue;
    }

    // export interface Name
    const ifaceMatch = /^export\s+interface\s+(\w+)/.exec(trimmed);
    if (ifaceMatch?.[1]) {
      symbols.push({
        name: ifaceMatch[1],
        type: 'interface',
        signature: trimmed.slice(0, 200),
        lineStart: i + 1,
        exported: true,
      });
      continue;
    }

    // export type Name
    const typeMatch = /^export\s+type\s+(\w+)/.exec(trimmed);
    if (typeMatch?.[1]) {
      symbols.push({
        name: typeMatch[1],
        type: 'type',
        signature: trimmed.slice(0, 200),
        lineStart: i + 1,
        exported: true,
      });
      continue;
    }

    // export enum Name
    const enumMatch = /^export\s+enum\s+(\w+)/.exec(trimmed);
    if (enumMatch?.[1]) {
      symbols.push({
        name: enumMatch[1],
        type: 'enum',
        signature: trimmed.slice(0, 200),
        lineStart: i + 1,
        exported: true,
      });
      continue;
    }

    // export const/let/var name
    const varMatch = /^export\s+(?:const|let|var)\s+(\w+)/.exec(trimmed);
    if (varMatch?.[1]) {
      symbols.push({
        name: varMatch[1],
        type: 'variable',
        signature: trimmed.slice(0, 200),
        lineStart: i + 1,
        exported: true,
      });
      continue;
    }

    // export default function/class (name them 'default')
    const defaultMatch = /^export\s+default\s+(?:function|class)\s*(\w*)/.exec(trimmed);
    if (defaultMatch) {
      symbols.push({
        name: defaultMatch[1] || 'default',
        type: 'export',
        signature: trimmed.slice(0, 200),
        lineStart: i + 1,
        exported: true,
      });
      continue;
    }

    // Non-exported function/class/const (track but mark as not exported)
    const localFuncMatch = /^(?:async\s+)?function\s+(\w+)\s*[\(<]/.exec(trimmed);
    if (localFuncMatch?.[1]) {
      symbols.push({
        name: localFuncMatch[1],
        type: 'function',
        signature: trimmed.slice(0, 200),
        lineStart: i + 1,
        exported: false,
      });
      continue;
    }

    const localClassMatch = /^(?:abstract\s+)?class\s+(\w+)/.exec(trimmed);
    if (localClassMatch?.[1]) {
      symbols.push({
        name: localClassMatch[1],
        type: 'class',
        signature: trimmed.slice(0, 200),
        lineStart: i + 1,
        exported: false,
      });
    }
  }

  return symbols;
}

/** Extract import declarations from source. */
function extractImports(content: string): ExtractedImport[] {
  const imports: ExtractedImport[] = [];
  const lines = content.split('\n');

  for (const line of lines) {
    if (line === undefined) continue;
    const trimmed = line.trim();

    // import { a, b } from './path'
    const namedMatch = /^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/.exec(trimmed);
    if (namedMatch?.[1] !== undefined && namedMatch[2] !== undefined) {
      const names = namedMatch[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]?.trim()).filter((n): n is string => !!n);
      imports.push({ names, path: namedMatch[2] });
      continue;
    }

    // import name from './path'
    const defaultMatch = /^import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/.exec(trimmed);
    if (defaultMatch?.[1] !== undefined && defaultMatch[2] !== undefined) {
      imports.push({ names: [defaultMatch[1]], path: defaultMatch[2] });
      continue;
    }

    // import * as name from './path'
    const starMatch = /^import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/.exec(trimmed);
    if (starMatch?.[1] !== undefined && starMatch[2] !== undefined) {
      imports.push({ names: [`* as ${starMatch[1]}`], path: starMatch[2] });
      continue;
    }

    // import type { a, b } from './path'
    const typeImportMatch = /^import\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/.exec(trimmed);
    if (typeImportMatch?.[1] !== undefined && typeImportMatch[2] !== undefined) {
      const names = typeImportMatch[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]?.trim()).filter((n): n is string => !!n);
      imports.push({ names, path: typeImportMatch[2] });
      continue;
    }

    // import type Name from './path'
    const typeDefaultMatch = /^import\s+type\s+(\w+)\s+from\s+['"]([^'"]+)['"]/.exec(trimmed);
    if (typeDefaultMatch?.[1] !== undefined && typeDefaultMatch[2] !== undefined) {
      imports.push({ names: [typeDefaultMatch[1]], path: typeDefaultMatch[2] });
    }
  }

  return imports;
}

// --- Row converters ---

function rowToFile(row: FileRow): CodeFile {
  return {
    id: row.id,
    repoId: row.repo_id,
    path: row.path,
    language: row.language,
    lastModified: row.last_modified,
    lastIndexed: row.last_indexed,
    lineCount: row.line_count,
    createdAt: row.created_at,
  };
}

function rowToSymbol(row: SymbolRow): CodeSymbol {
  return {
    id: row.id,
    fileId: row.file_id,
    name: row.name,
    type: row.type as SymbolType,
    signature: row.signature,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    exported: row.exported === 1,
    createdAt: row.created_at,
  };
}

function rowToDependency(row: DependencyRow): CodeDependency {
  return {
    id: row.id,
    sourceFileId: row.source_file_id,
    targetFileId: row.target_file_id,
    targetPath: row.target_path,
    importNames: row.import_names ? (JSON.parse(row.import_names) as string[]) : [],
    createdAt: row.created_at,
  };
}

function rowToChange(row: ChangeRow): CodeChange {
  return {
    id: row.id,
    repoId: row.repo_id,
    filePath: row.file_path,
    changeType: row.change_type as 'add' | 'modify' | 'delete',
    symbolsAffected: row.symbols_affected ? (JSON.parse(row.symbols_affected) as string[]) : [],
    commitHash: row.commit_hash,
    taskId: row.task_id,
    description: row.description,
    createdAt: row.created_at,
  };
}
