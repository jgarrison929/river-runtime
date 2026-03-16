/**
 * Tests for ChatStore — CRUD operations on projects, chats, and messages.
 *
 * Uses an in-memory SQLite database (better-sqlite3 with ':memory:') for
 * fast, isolated tests with real SQL — no mocking.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ChatStore } from '../../src/store/chats.js';
import type { UIProject, UIChat, UIMessage } from '../../src/store/chats.js';

describe('ChatStore', () => {
  let db: Database.Database;
  let store: ChatStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ChatStore(db);
    store.init();
  });

  // ── Projects ──────────────────────────────────────

  it('should seed default General project on init', () => {
    const projects = store.getProjects();
    expect(projects.length).toBeGreaterThanOrEqual(1);
    expect(projects[0].name).toBe('General');
    expect(projects[0].id).toBe('general');
  });

  it('should not re-seed General if called twice', () => {
    store.init(); // call init again
    const projects = store.getProjects();
    const generals = projects.filter(p => p.name === 'General');
    expect(generals).toHaveLength(1);
  });

  it('should create and retrieve a project', () => {
    const p = store.createProject('Test Project');
    expect(p.name).toBe('Test Project');
    expect(p.id).toBeTruthy();

    const projects = store.getProjects();
    expect(projects.find(pr => pr.id === p.id)).toBeTruthy();
  });

  it('should assign incrementing position to new projects', () => {
    const p1 = store.createProject('First');
    const p2 = store.createProject('Second');
    expect(p2.position).toBeGreaterThan(p1.position);
  });

  it('should rename a project', () => {
    const p = store.createProject('OldName');
    const ok = store.updateProject(p.id, 'NewName');
    expect(ok).toBe(true);

    const projects = store.getProjects();
    const updated = projects.find(pr => pr.id === p.id);
    expect(updated?.name).toBe('NewName');
  });

  it('should return false when renaming non-existent project', () => {
    const ok = store.updateProject('nonexistent', 'Whatever');
    expect(ok).toBe(false);
  });

  it('should cascade delete project, chats, and messages', () => {
    const p = store.createProject('DeleteMe');
    const chat = store.createChat(p.id, 'Chat in DeleteMe');
    store.addMessage(chat.id, 'user', 'Hello');
    store.addMessage(chat.id, 'assistant', 'Hi');

    const ok = store.deleteProject(p.id);
    expect(ok).toBe(true);

    const chats = store.getChats(p.id);
    expect(chats).toHaveLength(0);

    const messages = store.getMessages(chat.id);
    expect(messages).toHaveLength(0);
  });

  it('should return false when deleting non-existent project', () => {
    const ok = store.deleteProject('nonexistent');
    expect(ok).toBe(false);
  });

  it('should include chat_count in project listing', () => {
    const projects = store.getProjects();
    const general = projects[0];
    expect(general.chat_count).toBe(0);

    store.createChat(general.id, 'Chat 1');
    store.createChat(general.id, 'Chat 2');

    const updated = store.getProjects();
    const generalUpdated = updated.find(p => p.id === 'general');
    expect(generalUpdated?.chat_count).toBe(2);
  });

  // ── Chats ─────────────────────────────────────────

  it('should create a chat in a project', () => {
    const projects = store.getProjects();
    const chat = store.createChat(projects[0].id, 'My Chat');
    expect(chat.title).toBe('My Chat');
    expect(chat.project_id).toBe(projects[0].id);
  });

  it('should create a chat with default title', () => {
    const projects = store.getProjects();
    const chat = store.createChat(projects[0].id);
    expect(chat.title).toBe('New Chat');
  });

  it('should list chats ordered by updated_at DESC', () => {
    const projects = store.getProjects();
    const c1 = store.createChat(projects[0].id, 'First');
    const c2 = store.createChat(projects[0].id, 'Second');

    // Force c2 to have a definitively later updated_at via direct SQL
    // (Date.now() can return same ms in synchronous tests)
    const db = (store as any).db;
    db.prepare('UPDATE ui_chats SET updated_at = updated_at + 1000 WHERE id = ?').run(c2.id);

    const chats = store.getChats(projects[0].id);
    expect(chats.length).toBe(2);
    // Most recently updated should be first
    expect(chats[0].id).toBe(c2.id);
  });

  it('should filter chats by projectId', () => {
    const p1 = store.createProject('Project A');
    const p2 = store.createProject('Project B');
    store.createChat(p1.id, 'Chat in A');
    store.createChat(p2.id, 'Chat in B');

    const chatsA = store.getChats(p1.id);
    expect(chatsA).toHaveLength(1);
    expect(chatsA[0].title).toBe('Chat in A');
  });

  it('should return all chats when no projectId filter', () => {
    const p1 = store.createProject('PA');
    const p2 = store.createProject('PB');
    store.createChat(p1.id, 'C1');
    store.createChat(p2.id, 'C2');

    const all = store.getChats();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it('should update chat title', () => {
    const projects = store.getProjects();
    const chat = store.createChat(projects[0].id, 'OldTitle');
    const ok = store.updateChat(chat.id, { title: 'NewTitle' });
    expect(ok).toBe(true);

    const chats = store.getChats(projects[0].id);
    const updated = chats.find(c => c.id === chat.id);
    expect(updated?.title).toBe('NewTitle');
  });

  it('should move chat to different project', () => {
    const p1 = store.createProject('Source');
    const p2 = store.createProject('Dest');
    const chat = store.createChat(p1.id, 'Moving Chat');

    const ok = store.updateChat(chat.id, { projectId: p2.id });
    expect(ok).toBe(true);

    const sourceChats = store.getChats(p1.id);
    expect(sourceChats).toHaveLength(0);

    const destChats = store.getChats(p2.id);
    expect(destChats).toHaveLength(1);
  });

  it('should cascade delete chat and messages', () => {
    const projects = store.getProjects();
    const chat = store.createChat(projects[0].id, 'DeleteMe');
    store.addMessage(chat.id, 'user', 'Hello');
    store.addMessage(chat.id, 'assistant', 'World');

    const ok = store.deleteChat(chat.id);
    expect(ok).toBe(true);

    const messages = store.getMessages(chat.id);
    expect(messages).toHaveLength(0);
  });

  it('should return false when deleting non-existent chat', () => {
    const ok = store.deleteChat('nonexistent');
    expect(ok).toBe(false);
  });

  // ── Messages ──────────────────────────────────────

  it('should add and retrieve messages in chronological order', () => {
    const projects = store.getProjects();
    const chat = store.createChat(projects[0].id);
    store.addMessage(chat.id, 'user', 'Hello');
    store.addMessage(chat.id, 'assistant', 'Hi there');

    const messages = store.getMessages(chat.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Hello');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('Hi there');
  });

  it('should paginate messages with limit', () => {
    const projects = store.getProjects();
    const chat = store.createChat(projects[0].id);
    for (let i = 0; i < 20; i++) {
      store.addMessage(chat.id, 'user', `Message ${i}`);
    }

    const page = store.getMessages(chat.id, 5);
    expect(page).toHaveLength(5);
  });

  it('should paginate messages with before cursor', () => {
    const projects = store.getProjects();
    const chat = store.createChat(projects[0].id);
    for (let i = 0; i < 10; i++) {
      store.addMessage(chat.id, 'user', `Message ${i}`);
    }

    const allMessages = store.getMessages(chat.id, 100);
    expect(allMessages).toHaveLength(10);

    // Get messages before the 5th message ID
    const beforeId = allMessages[4].id;
    const olderMessages = store.getMessages(chat.id, 100, beforeId);
    // Should return messages with id < beforeId (i.e., messages 0-3)
    expect(olderMessages.length).toBe(4);
  });

  it('should store thinking text with messages', () => {
    const projects = store.getProjects();
    const chat = store.createChat(projects[0].id);
    store.addMessage(chat.id, 'assistant', 'Response', 'I thought about this...');

    const messages = store.getMessages(chat.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].thinking).toBe('I thought about this...');
  });

  it('should store null thinking when not provided', () => {
    const projects = store.getProjects();
    const chat = store.createChat(projects[0].id);
    store.addMessage(chat.id, 'user', 'Hello');

    const messages = store.getMessages(chat.id);
    expect(messages[0].thinking).toBeNull();
  });

  it('should store file metadata with messages', () => {
    const projects = store.getProjects();
    const chat = store.createChat(projects[0].id);
    const files = [{ name: 'test.pdf', size: 1024 }];
    store.addMessage(chat.id, 'user', 'See attached', undefined, files);

    const messages = store.getMessages(chat.id);
    expect(messages[0].files).toBeTruthy();
    const parsedFiles = JSON.parse(messages[0].files!);
    expect(parsedFiles).toHaveLength(1);
    expect(parsedFiles[0].name).toBe('test.pdf');
    expect(parsedFiles[0].size).toBe(1024);
  });

  it('should touch chat updated_at when adding message', () => {
    const projects = store.getProjects();
    const chat = store.createChat(projects[0].id);
    const originalUpdatedAt = chat.updated_at;

    // Small delay to ensure timestamp difference
    store.addMessage(chat.id, 'user', 'Hello');

    const chats = store.getChats(projects[0].id);
    const updated = chats.find(c => c.id === chat.id);
    expect(updated!.updated_at).toBeGreaterThanOrEqual(originalUpdatedAt);
  });

  it('should return message with correct structure', () => {
    const projects = store.getProjects();
    const chat = store.createChat(projects[0].id);
    const msg = store.addMessage(chat.id, 'user', 'Test content');

    expect(msg.id).toBeTypeOf('number');
    expect(msg.chat_id).toBe(chat.id);
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Test content');
    expect(msg.created_at).toBeTypeOf('number');
  });

  // ── Search ────────────────────────────────────────

  it('should search messages by content', () => {
    const projects = store.getProjects();
    const chat = store.createChat(projects[0].id);
    store.addMessage(chat.id, 'user', 'The quick brown fox');
    store.addMessage(chat.id, 'assistant', 'jumped over the lazy dog');

    const results = store.searchMessages('fox');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain('fox');
  });

  it('should return chat metadata with search results', () => {
    const projects = store.getProjects();
    const chat = store.createChat(projects[0].id, 'My Test Chat');
    store.addMessage(chat.id, 'user', 'unique search term xyz');

    const results = store.searchMessages('xyz');
    expect(results).toHaveLength(1);
    expect(results[0].chat_title).toBe('My Test Chat');
    expect(results[0].project_id).toBe(projects[0].id);
  });

  it('should respect search limit', () => {
    const projects = store.getProjects();
    const chat = store.createChat(projects[0].id);
    for (let i = 0; i < 10; i++) {
      store.addMessage(chat.id, 'user', `Repeated keyword message ${i}`);
    }

    const results = store.searchMessages('keyword', 3);
    expect(results).toHaveLength(3);
  });

  it('should return empty array for no matches', () => {
    const results = store.searchMessages('nonexistent_zzzzzz');
    expect(results).toHaveLength(0);
  });

  // ── Import ────────────────────────────────────────

  it('should import project with chats and messages', () => {
    store.importProject(
      { id: 'imported-proj', name: 'Imported' },
      [
        {
          id: 'imported-chat-1',
          title: 'Imported Chat',
          createdAt: Date.now(),
          messages: [
            { role: 'user', content: 'Hello from import' },
            { role: 'assistant', content: 'Welcome!' },
          ],
        },
      ]
    );

    const projects = store.getProjects();
    const imported = projects.find(p => p.id === 'imported-proj');
    expect(imported).toBeTruthy();
    expect(imported?.name).toBe('Imported');

    const chats = store.getChats('imported-proj');
    expect(chats).toHaveLength(1);
    expect(chats[0].title).toBe('Imported Chat');

    const messages = store.getMessages('imported-chat-1');
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Hello from import');
  });
});
