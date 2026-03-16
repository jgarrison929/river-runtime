/**
 * Chat persistence store — SQLite-backed projects, chats, and messages.
 * Uses the same SQLite database as the memory store (via getDb()).
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

export interface UIProject {
  id: string;
  name: string;
  position: number;
  created_at: number;
  updated_at: number;
  chat_count?: number;
}

export interface UIChat {
  id: string;
  project_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  archived: number;
}

export interface UIMessage {
  id: number;
  chat_id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string | null;
  files?: string | null; // JSON string
  created_at: number;
}

export class ChatStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Create tables and seed default data if needed. */
  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ui_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ui_chats (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES ui_projects(id),
        title TEXT NOT NULL DEFAULT 'New Chat',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS ui_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL REFERENCES ui_chats(id),
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        thinking TEXT,
        files TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat ON ui_messages(chat_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_chats_project ON ui_chats(project_id);
    `);

    // Seed default "General" project if none exist
    const count = this.db.prepare('SELECT COUNT(*) as cnt FROM ui_projects').get() as { cnt: number };
    if (count.cnt === 0) {
      const now = Date.now();
      this.db.prepare(
        'INSERT INTO ui_projects (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run('general', 'General', 0, now, now);
      logger.info('Seeded default "General" project');
    }

    logger.info('ChatStore initialized');
  }

  // ── Projects ──────────────────────────────────────

  /** Returns all projects with their chat counts. */
  getProjects(): UIProject[] {
    return this.db.prepare(`
      SELECT p.*, COALESCE(c.cnt, 0) as chat_count
      FROM ui_projects p
      LEFT JOIN (
        SELECT project_id, COUNT(*) as cnt
        FROM ui_chats
        WHERE archived = 0
        GROUP BY project_id
      ) c ON c.project_id = p.id
      ORDER BY p.position ASC, p.created_at ASC
    `).all() as UIProject[];
  }

  /** Create a new project. */
  createProject(name: string): UIProject {
    const id = randomUUID().slice(0, 8);
    const now = Date.now();
    // Position after all existing projects
    const maxPos = this.db.prepare('SELECT COALESCE(MAX(position), -1) as mp FROM ui_projects').get() as { mp: number };
    this.db.prepare(
      'INSERT INTO ui_projects (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, name, maxPos.mp + 1, now, now);
    return { id, name, position: maxPos.mp + 1, created_at: now, updated_at: now, chat_count: 0 };
  }

  /** Rename a project. */
  updateProject(id: string, name: string): boolean {
    const result = this.db.prepare(
      'UPDATE ui_projects SET name = ?, updated_at = ? WHERE id = ?'
    ).run(name, Date.now(), id);
    return result.changes > 0;
  }

  /** Delete a project and all its chats + messages. */
  deleteProject(id: string): boolean {
    const deleteInTx = this.db.transaction(() => {
      // Delete all messages belonging to chats in this project
      this.db.prepare(`
        DELETE FROM ui_messages WHERE chat_id IN (
          SELECT id FROM ui_chats WHERE project_id = ?
        )
      `).run(id);
      // Delete all chats in this project
      this.db.prepare('DELETE FROM ui_chats WHERE project_id = ?').run(id);
      // Delete the project
      const result = this.db.prepare('DELETE FROM ui_projects WHERE id = ?').run(id);
      return result.changes > 0;
    });
    return deleteInTx();
  }

  // ── Chats ─────────────────────────────────────────

  /** Returns all chats, optionally filtered by projectId. */
  getChats(projectId?: string): UIChat[] {
    if (projectId) {
      return this.db.prepare(
        'SELECT * FROM ui_chats WHERE project_id = ? AND archived = 0 ORDER BY updated_at DESC'
      ).all(projectId) as UIChat[];
    }
    return this.db.prepare(
      'SELECT * FROM ui_chats WHERE archived = 0 ORDER BY updated_at DESC'
    ).all() as UIChat[];
  }

  /** Create a new chat. */
  createChat(projectId: string, title?: string): UIChat {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO ui_chats (id, project_id, title, created_at, updated_at, archived) VALUES (?, ?, ?, ?, ?, 0)'
    ).run(id, projectId, title || 'New Chat', now, now);
    return { id, project_id: projectId, title: title || 'New Chat', created_at: now, updated_at: now, archived: 0 };
  }

  /** Update a chat (title, projectId). */
  updateChat(id: string, updates: { title?: string; projectId?: string }): boolean {
    const fields: string[] = [];
    const values: (string | number)[] = [];

    if (updates.title !== undefined) {
      fields.push('title = ?');
      values.push(updates.title);
    }
    if (updates.projectId !== undefined) {
      fields.push('project_id = ?');
      values.push(updates.projectId);
    }

    if (fields.length === 0) return false;

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    const result = this.db.prepare(
      `UPDATE ui_chats SET ${fields.join(', ')} WHERE id = ?`
    ).run(...values);
    return result.changes > 0;
  }

  /** Delete a chat and all its messages. */
  deleteChat(id: string): boolean {
    const deleteInTx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM ui_messages WHERE chat_id = ?').run(id);
      const result = this.db.prepare('DELETE FROM ui_chats WHERE id = ?').run(id);
      return result.changes > 0;
    });
    return deleteInTx();
  }

  // ── Messages ──────────────────────────────────────

  /** Get paginated messages for a chat (newest first internally, returned chronological). */
  getMessages(chatId: string, limit: number = 50, before?: number): UIMessage[] {
    let rows: UIMessage[];
    if (before) {
      rows = this.db.prepare(
        'SELECT * FROM ui_messages WHERE chat_id = ? AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?'
      ).all(chatId, before, limit) as UIMessage[];
    } else {
      rows = this.db.prepare(
        'SELECT * FROM ui_messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
      ).all(chatId, limit) as UIMessage[];
    }
    // Return in chronological order
    return rows.reverse();
  }

  /** Add a message to a chat. */
  addMessage(
    chatId: string,
    role: 'user' | 'assistant',
    content: string,
    thinking?: string | null,
    files?: Array<{ name: string; size: number; path?: string }> | null
  ): UIMessage {
    const now = Date.now();
    const filesJson = files ? JSON.stringify(files) : null;
    const result = this.db.prepare(
      'INSERT INTO ui_messages (chat_id, role, content, thinking, files, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(chatId, role, content, thinking || null, filesJson, now);

    // Touch the chat's updated_at
    this.db.prepare('UPDATE ui_chats SET updated_at = ? WHERE id = ?').run(now, chatId);

    return {
      id: Number(result.lastInsertRowid),
      chat_id: chatId,
      role,
      content,
      thinking: thinking || null,
      files: filesJson,
      created_at: now,
    };
  }

  /** Full-text search across all messages. */
  searchMessages(query: string, limit: number = 20): Array<UIMessage & { chat_title: string; project_id: string }> {
    // Use SQLite LIKE for search (simple but effective for now)
    const pattern = `%${query}%`;
    return this.db.prepare(`
      SELECT m.*, c.title as chat_title, c.project_id
      FROM ui_messages m
      JOIN ui_chats c ON c.id = m.chat_id
      WHERE m.content LIKE ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(pattern, limit) as Array<UIMessage & { chat_title: string; project_id: string }>;
  }

  // ── Bulk import (for migration from localStorage) ─

  /** Import a full project (with its chats and messages) in a transaction. */
  importProject(project: { id: string; name: string }, chats: Array<{
    id: string;
    title: string;
    createdAt: number;
    messages: Array<{ role: string; content: string; files?: Array<{ name: string; size: number }>; thinking?: string; thinkingTokens?: number }>;
  }>): void {
    const doImport = this.db.transaction(() => {
      const now = Date.now();

      // Upsert project
      this.db.prepare(`
        INSERT OR IGNORE INTO ui_projects (id, name, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(project.id, project.name, 0, now, now);

      for (const chat of chats) {
        // Insert chat
        const chatCreated = chat.createdAt || now;
        this.db.prepare(`
          INSERT OR IGNORE INTO ui_chats (id, project_id, title, created_at, updated_at, archived)
          VALUES (?, ?, ?, ?, ?, 0)
        `).run(chat.id, project.id, chat.title, chatCreated, chatCreated);

        // Insert messages
        const insertMsg = this.db.prepare(
          'INSERT INTO ui_messages (chat_id, role, content, thinking, files, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        );
        let msgTime = chatCreated;
        for (const msg of chat.messages) {
          const filesJson = msg.files ? JSON.stringify(msg.files) : null;
          insertMsg.run(chat.id, msg.role, msg.content, msg.thinking || null, filesJson, msgTime);
          msgTime += 1; // Ensure ordering
        }
      }
    });
    doImport();
  }
}
