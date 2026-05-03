import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JsonFileStore } from '../store.js';
import { initBridgeContext } from '../core/context.js';
import type { LLMProvider, PermissionGateway, LifecycleHooks } from '../core/host.js';
import type { InboundMessage, OutboundMessage, SendResult, ChannelBinding } from '../core/types.js';
import * as bridgeManager from '../core/bridge-manager.js';
import { deliver } from '../core/delivery-layer.js';
import { processMessage } from '../core/conversation-engine.js';
import { sanitizeInput, isDangerousInput } from '../core/security/validators.js';
import { sseEvent } from '../sse-utils.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

class MockLLMProvider implements LLMProvider {
  streamChat(_params: import('../core/host.js').StreamChatParams): ReadableStream<string> {
    const events = [
      sseEvent('text', 'Hello from mock'),
      sseEvent('result', JSON.stringify({ text: 'Hello from mock', tokenUsage: null })),
      sseEvent('done', ''),
    ];
    return new ReadableStream<string>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(event);
        }
        controller.close();
      },
    });
  }
}

class MockFeishuAdapter {
  readonly channelType = 'feishu' as const;
  private sentMessages: OutboundMessage[] = [];
  private messageQueue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private _running = false;
  private typingCalls: string[] = [];
  private streamTexts: Map<string, string> = new Map();
  private streamEndCalls: string[] = [];

  async start(): Promise<void> { this._running = true; }
  async stop(): Promise<void> { this._running = false; for (const w of this.waiters) w(null); }
  isRunning(): boolean { return this._running; }

  async consumeOne(): Promise<InboundMessage | null> {
    if (this.messageQueue.length > 0) return this.messageQueue.shift()!;
    return new Promise<InboundMessage | null>(resolve => {
      this.waiters.push(resolve);
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    this.sentMessages.push(message);
    return { ok: true, messageId: `msg-${this.sentMessages.length}` };
  }

  onMessageStart(chatId: string): void { this.typingCalls.push(chatId); }
  onStreamText(chatId: string, text: string): void { this.streamTexts.set(chatId, text); }
  async onStreamEnd(chatId: string, _status: string, _text: string): Promise<boolean> {
    this.streamEndCalls.push(chatId);
    return false;
  }
  onMessageEnd(_chatId: string): void { /* no-op */ }

  injectMessage(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(msg);
    else this.messageQueue.push(msg);
  }

  getSentMessages(): OutboundMessage[] { return this.sentMessages; }
  getTypingCalls(): string[] { return this.typingCalls; }
  getStreamEndCalls(): string[] { return this.streamEndCalls; }
}

function createTestContext(): { store: JsonFileStore; llm: MockLLMProvider; permissions: PermissionGateway; lifecycle: LifecycleHooks; testDir: string } {
  const testDir = path.join(os.tmpdir(), `traecn-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(testDir, { recursive: true });

  const settingsMap = new Map<string, string>();
  settingsMap.set('bridge_feishu_app_id', 'test-app-id');
  settingsMap.set('bridge_feishu_app_secret', 'test-app-secret');
  settingsMap.set('bridge_feishu_domain', 'feishu');
  settingsMap.set('bridge_feishu_chat_id', 'test-chat-id');
  settingsMap.set('bridge_default_cwd', testDir);
  settingsMap.set('bridge_model', 'test-model');

  const store = new JsonFileStore(settingsMap, path.join(testDir, 'data'));
  const llm = new MockLLMProvider();
  const permissions: PermissionGateway = {
    resolvePendingPermission: () => {},
  };
  const lifecycle: LifecycleHooks = {
    onBridgeStart: () => {},
    onBridgeStop: () => {},
  };

  initBridgeContext({ store, llm, permissions, lifecycle });
  return { store, llm, permissions, lifecycle, testDir };
}

describe('MVP Integration Tests', () => {
  describe('Security Validators', () => {
    it('should sanitize control characters', () => {
      const input = 'Hello\x00World\x01Test';
      const result = sanitizeInput(input);
      assert.equal(result, 'HelloWorldTest');
    });

    it('should truncate very long input', () => {
      const input = 'a'.repeat(60000);
      const result = sanitizeInput(input);
      assert.equal(result.length, 50000);
    });

    it('should detect dangerous input patterns', () => {
      assert.equal(isDangerousInput('../../../etc/passwd'), true);
      assert.equal(isDangerousInput('normal text'), false);
    });
  });

  describe('SSE Utils', () => {
    it('should format SSE events correctly', () => {
      const event = sseEvent('text', 'hello');
      assert.ok(event.includes('event: text'));
      assert.ok(event.includes('data: hello'));
      assert.ok(event.endsWith('\n\n'));
    });
  });

  describe('JsonFileStore', () => {
    it('should store and retrieve settings', () => {
      const { store } = createTestContext();
      assert.equal(store.getSetting('bridge_feishu_app_id'), 'test-app-id');
      assert.equal(store.getSetting('nonexistent'), null);
    });

    it('should create and retrieve sessions', () => {
      const { store, testDir } = createTestContext();
      const session = store.createSession('test-session', 'test-model', undefined, testDir, 'code');
      assert.ok(session.id);
      assert.equal(session.model, 'test-model');

      const retrieved = store.getSession(session.id);
      assert.ok(retrieved);
      assert.equal(retrieved.id, session.id);
    });

    it('should add and retrieve messages', () => {
      const { store } = createTestContext();
      const session = store.createSession('test-session', 'test-model');
      store.addMessage(session.id, 'user', 'Hello');
      store.addMessage(session.id, 'assistant', 'Hi there');

      const { messages } = store.getMessages(session.id);
      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[0].content, 'Hello');
      assert.equal(messages[1].role, 'assistant');
      assert.equal(messages[1].content, 'Hi there');
    });

    it('should manage channel bindings', () => {
      const { store, testDir } = createTestContext();
      const binding = store.upsertChannelBinding({
        channelType: 'feishu',
        chatId: 'chat-123',
        sessionId: 'session-456',
        workingDirectory: testDir,
        model: 'test-model',
        mode: 'code',
      });

      assert.ok(binding.id);
      assert.equal(binding.channelType, 'feishu');
      assert.equal(binding.chatId, 'chat-123');

      const retrieved = store.getChannelBinding('feishu', 'chat-123');
      assert.ok(retrieved);
      assert.equal(retrieved.sessionId, 'session-456');
    });

    it('should manage session locks', () => {
      const { store } = createTestContext();
      const sessionId = 'lock-test-session';

      const acquired1 = store.acquireSessionLock(sessionId, 'lock-1', 'owner-1', 60);
      assert.equal(acquired1, true);

      const acquired2 = store.acquireSessionLock(sessionId, 'lock-2', 'owner-2', 60);
      assert.equal(acquired2, false);

      store.releaseSessionLock(sessionId, 'lock-1');

      const acquired3 = store.acquireSessionLock(sessionId, 'lock-3', 'owner-3', 60);
      assert.equal(acquired3, true);
    });

    it('should manage dedup keys', () => {
      const { store } = createTestContext();
      assert.equal(store.checkDedup('key-1'), false);
      store.insertDedup('key-1');
      assert.equal(store.checkDedup('key-1'), true);
    });

    it('should manage permission links', () => {
      const { store } = createTestContext();
      store.insertPermissionLink({
        permissionRequestId: 'perm-1',
        channelType: 'feishu',
        chatId: 'chat-123',
        messageId: 'msg-1',
        toolName: 'bash',
        suggestions: '',
      });

      const link = store.getPermissionLink('perm-1');
      assert.ok(link);
      assert.equal(link!.resolved, false);

      const resolved = store.markPermissionLinkResolved('perm-1');
      assert.equal(resolved, true);

      const resolvedAgain = store.markPermissionLinkResolved('perm-1');
      assert.equal(resolvedAgain, false);
    });
  });

  describe('Conversation Engine', () => {
    it('should process a message end-to-end', async () => {
      const { store, testDir } = createTestContext();
      const session = store.createSession('test-session', 'test-model', undefined, testDir, 'code');
      const binding: ChannelBinding = {
        id: 'binding-1',
        channelType: 'feishu',
        chatId: 'chat-123',
        sessionId: session.id,
        sdkSessionId: '',
        workingDirectory: testDir,
        model: 'test-model',
        mode: 'code',
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = await processMessage(binding, 'Hello');
      assert.equal(result.hasError, false);
      assert.equal(result.responseText, 'Hello from mock');
      assert.ok(result.tokenUsage === null);

      const { messages } = store.getMessages(session.id);
      assert.equal(messages.length, 2);
      assert.equal(messages[0].role, 'user');
      assert.equal(messages[1].role, 'assistant');
      assert.equal(messages[1].content, 'Hello from mock');
    });

    it('should reject when session is locked', async () => {
      const { store, testDir } = createTestContext();
      const session = store.createSession('locked-session', 'test-model');
      store.acquireSessionLock(session.id, 'lock-1', 'owner-1', 600);

      const binding: ChannelBinding = {
        id: 'binding-2',
        channelType: 'feishu',
        chatId: 'chat-456',
        sessionId: session.id,
        sdkSessionId: '',
        workingDirectory: testDir,
        model: 'test-model',
        mode: 'code',
        active: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const result = await processMessage(binding, 'Hello');
      assert.equal(result.hasError, true);
      assert.ok(result.errorMessage!.includes('busy'));
    });
  });

  describe('Delivery Layer', () => {
    it('should deliver a message through the adapter', async () => {
      createTestContext();
      const adapter = new MockFeishuAdapter() as any;
      const address = { channelType: 'feishu' as const, chatId: 'chat-123' };
      const message: OutboundMessage = {
        address,
        text: 'Hello from delivery',
        parseMode: 'plain',
      };

      const result = await deliver(adapter, message);
      assert.equal(result.ok, true);
      assert.equal(adapter.getSentMessages().length, 1);
    });

    it('should chunk long messages', async () => {
      createTestContext();
      const adapter = new MockFeishuAdapter() as any;
      const address = { channelType: 'feishu' as const, chatId: 'chat-123' };
      const message: OutboundMessage = {
        address,
        text: 'a'.repeat(35000),
        parseMode: 'plain',
      };

      const result = await deliver(adapter, message);
      assert.equal(result.ok, true);
      assert.ok(adapter.getSentMessages().length > 1);
    });
  });

  describe('Bridge Manager', () => {
    it('should start and stop the bridge', async () => {
      createTestContext();
      const adapter = new MockFeishuAdapter() as any;

      await bridgeManager.start(adapter);
      const status = bridgeManager.getStatus();
      assert.equal(status.running, true);
      assert.equal(status.adapters.length, 1);

      await bridgeManager.stop();
      const statusAfter = bridgeManager.getStatus();
      assert.equal(statusAfter.running, false);
    });

    it('should handle an inbound message end-to-end', async () => {
      createTestContext();
      const adapter = new MockFeishuAdapter() as any;

      await bridgeManager.start(adapter);

      const inboundMsg: InboundMessage = {
        address: { channelType: 'feishu', chatId: 'chat-e2e' },
        text: 'Hello from Feishu',
        messageId: 'msg-e2e-1',
        timestamp: Date.now(),
        attachments: [],
      };

      adapter.injectMessage(inboundMsg);

      await new Promise(r => setTimeout(r, 500));

      await bridgeManager.stop();

      const sent = adapter.getSentMessages();
      assert.ok(sent.length > 0);
    });
  });
});
