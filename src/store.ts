import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  BridgeStore,
  BridgeSession,
  BridgeMessage,
  AuditLogInput,
  PermissionLinkInput,
  PermissionLinkRecord,
  UpsertChannelBindingInput,
} from './core/host.js';
import type { ChannelBinding, ChannelType } from './core/types.js';
import { CTI_HOME } from './config.js';

const DATA_DIR = path.join(CTI_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = filePath + '.tmp.' + Date.now();
  try {
    fs.writeFileSync(tmp, data, 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    if ((err as NodeJS.ErrnoException).code === 'EPERM') {
      try {
        fs.writeFileSync(filePath, data, 'utf-8');
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException).code === 'EPERM') {
          console.warn(`[store] EPERM writing ${filePath}, retrying in 100ms...`);
          setTimeout(() => {
            fs.writeFileSync(filePath, data, 'utf-8');
          }, 100);
        } else {
          throw err2;
        }
      }
    } else {
      throw err;
    }
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch { return fallback; }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

function uuid(): string { return crypto.randomUUID(); }
function now(): string { return new Date().toISOString(); }

interface LockEntry { lockId: string; owner: string; expiresAt: number; }

export class JsonFileStore implements BridgeStore {
  private settings: Map<string, string>;
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private offsets = new Map<string, string>();
  private dedupKeys = new Map<string, number>();
  private locks = new Map<string, LockEntry>();
  private auditLog: Array<AuditLogInput & { id: string; createdAt: string }> = [];

  private dataDir: string;
  private messagesDir: string;

  constructor(settingsMap: Map<string, string>, customDataDir?: string) {
    this.settings = settingsMap;
    this.dataDir = customDataDir || DATA_DIR;
    this.messagesDir = path.join(this.dataDir, 'messages');
    ensureDir(this.dataDir);
    ensureDir(this.messagesDir);
    this.loadAll();
  }

  private loadAll(): void {
    for (const [id, s] of Object.entries(readJson<Record<string, BridgeSession>>(path.join(this.dataDir, 'sessions.json'), {}))) {
      this.sessions.set(id, s);
    }
    for (const [key, b] of Object.entries(readJson<Record<string, ChannelBinding>>(path.join(this.dataDir, 'bindings.json'), {}))) {
      this.bindings.set(key, b);
    }
    for (const [id, p] of Object.entries(readJson<Record<string, PermissionLinkRecord>>(path.join(this.dataDir, 'permissions.json'), {}))) {
      this.permissionLinks.set(id, p);
    }
    for (const [k, v] of Object.entries(readJson<Record<string, string>>(path.join(this.dataDir, 'offsets.json'), {}))) {
      this.offsets.set(k, v);
    }
    for (const [k, v] of Object.entries(readJson<Record<string, number>>(path.join(this.dataDir, 'dedup.json'), {}))) {
      this.dedupKeys.set(k, v);
    }
    this.auditLog = readJson(path.join(this.dataDir, 'audit.json'), []);
  }

  private persistSessions(): void { writeJson(path.join(this.dataDir, 'sessions.json'), Object.fromEntries(this.sessions)); }
  private persistBindings(): void { writeJson(path.join(this.dataDir, 'bindings.json'), Object.fromEntries(this.bindings)); }
  private persistPermissions(): void { writeJson(path.join(this.dataDir, 'permissions.json'), Object.fromEntries(this.permissionLinks)); }
  private persistOffsets(): void { writeJson(path.join(this.dataDir, 'offsets.json'), Object.fromEntries(this.offsets)); }
  private persistDedup(): void { writeJson(path.join(this.dataDir, 'dedup.json'), Object.fromEntries(this.dedupKeys)); }
  private persistAudit(): void { writeJson(path.join(this.dataDir, 'audit.json'), this.auditLog); }
  private persistMessages(sessionId: string): void { writeJson(path.join(this.messagesDir, `${sessionId}.json`), this.messages.get(sessionId) || []); }
  private loadMessages(sessionId: string): BridgeMessage[] {
    if (this.messages.has(sessionId)) return this.messages.get(sessionId)!;
    const msgs = readJson<BridgeMessage[]>(path.join(this.messagesDir, `${sessionId}.json`), []);
    this.messages.set(sessionId, msgs);
    return msgs;
  }

  getSetting(key: string): string | null { return this.settings.get(key) ?? null; }

  getChannelBinding(channelType: string, chatId: string): ChannelBinding | null {
    return this.bindings.get(`${channelType}:${chatId}`) ?? null;
  }
  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    const binding: ChannelBinding = {
      id: existing?.id || uuid(),
      channelType: data.channelType,
      chatId: data.chatId,
      sessionId: data.sessionId,
      sdkSessionId: data.sdkSessionId || existing?.sdkSessionId || '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: (data.mode as ChannelBinding['mode']) || existing?.mode || 'code',
      active: true,
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
    };
    this.bindings.set(key, binding);
    this.persistBindings();
    return binding;
  }
  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [, b] of this.bindings) {
      if (b.id === id) {
        Object.assign(b, updates, { updatedAt: now() });
        this.persistBindings();
        return;
      }
    }
  }
  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    return channelType ? all.filter(b => b.channelType === channelType) : all;
  }

  getSession(id: string): BridgeSession | null { return this.sessions.get(id) ?? null; }
  createSession(name: string, model: string, systemPrompt?: string, cwd?: string, mode?: string): BridgeSession {
    const session: BridgeSession = { id: uuid(), working_directory: cwd || process.cwd(), model, system_prompt: systemPrompt };
    this.sessions.set(session.id, session);
    this.persistSessions();
    return session;
  }
  updateSessionProviderId(sessionId: string, providerId: string): void {
    const s = this.sessions.get(sessionId);
    if (s) { s.provider_id = providerId; this.persistSessions(); }
  }

  addMessage(sessionId: string, role: string, content: string, usage?: string | null): void {
    this.loadMessages(sessionId);
    const msgs = this.messages.get(sessionId)!;
    msgs.push({ role, content });
    this.persistMessages(sessionId);
  }
  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const msgs = this.loadMessages(sessionId);
    const limit = opts?.limit ?? msgs.length;
    return { messages: msgs.slice(-limit) };
  }

  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean {
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > Date.now()) return false;
    this.locks.set(sessionId, { lockId, owner, expiresAt: Date.now() + ttlSecs * 1000 });
    return true;
  }
  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const existing = this.locks.get(sessionId);
    if (existing && existing.lockId === lockId) {
      existing.expiresAt = Date.now() + ttlSecs * 1000;
    }
  }
  releaseSessionLock(sessionId: string, lockId: string): void {
    const existing = this.locks.get(sessionId);
    if (existing && existing.lockId === lockId) this.locks.delete(sessionId);
  }
  setSessionRuntimeStatus(sessionId: string, status: string): void { /* no-op for MVP */ }

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    for (const [, b] of this.bindings) {
      if (b.sessionId === sessionId) {
        b.sdkSessionId = sdkSessionId;
        this.persistBindings();
        return;
      }
    }
  }
  updateSessionModel(sessionId: string, model: string): void {
    const s = this.sessions.get(sessionId);
    if (s) { s.model = model; this.persistSessions(); }
  }

  insertAuditLog(entry: AuditLogInput): void {
    this.auditLog.push({ ...entry, id: uuid(), createdAt: now() });
    if (this.auditLog.length > 10000) this.auditLog = this.auditLog.slice(-5000);
    this.persistAudit();
  }
  checkDedup(key: string): boolean { return this.dedupKeys.has(key); }
  insertDedup(key: string): void { this.dedupKeys.set(key, Date.now()); this.persistDedup(); }
  cleanupExpiredDedup(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [k, v] of this.dedupKeys) {
      if (v < cutoff) this.dedupKeys.delete(k);
    }
    this.persistDedup();
  }

  insertPermissionLink(link: PermissionLinkInput): void {
    const record: PermissionLinkRecord = {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
      suggestions: link.suggestions,
    };
    this.permissionLinks.set(link.permissionRequestId, record);
    this.persistPermissions();
  }
  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }
  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    link.resolved = true;
    this.persistPermissions();
    return true;
  }
  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    return Array.from(this.permissionLinks.values()).filter(l => l.chatId === chatId && !l.resolved);
  }

  getChannelOffset(key: string): string { return this.offsets.get(key) || ''; }
  setChannelOffset(key: string, offset: string): void { this.offsets.set(key, offset); this.persistOffsets(); }
}
