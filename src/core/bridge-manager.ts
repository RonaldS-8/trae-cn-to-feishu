import type { BridgeStatus, InboundMessage, ChannelBinding, ToolCallInfo } from './types.js';
import { getBridgeContext } from './context.js';
import type { FeishuAdapter } from '../feishu/feishu-adapter.js';
import * as engine from './conversation-engine.js';
import * as broker from './permission-broker.js';
import { deliver } from './delivery-layer.js';
import { sanitizeInput } from './security/validators.js';
import { detectMode, parseModelCommand, parseModeCommand, buildModeAnnouncement, shouldAutoDetect } from './mode-detector.js';

const GLOBAL_KEY = '__traecn_feishu_bridge_manager__';

interface BridgeManagerState {
  adapter: FeishuAdapter | null;
  running: boolean;
  startedAt: string | null;
  loopAbort: AbortController | null;
  sessionLocks: Map<string, Promise<void>>;
}

function getState(): BridgeManagerState {
  const g = globalThis as unknown as Record<string, BridgeManagerState>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      adapter: null,
      running: false,
      startedAt: null,
      loopAbort: null,
      sessionLocks: new Map(),
    };
  }
  return g[GLOBAL_KEY];
}

function processWithSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const state = getState();
  const prev = state.sessionLocks.get(sessionId) || Promise.resolve();
  const next = prev.then(() => fn()).catch(err => {
    console.error('[bridge-manager] Session lock error:', err instanceof Error ? err.message : err);
  });
  state.sessionLocks.set(sessionId, next);
  next.finally(() => {
    if (state.sessionLocks.get(sessionId) === next) {
      state.sessionLocks.delete(sessionId);
    }
  });
  return next;
}

export async function start(adapter: FeishuAdapter): Promise<void> {
  const state = getState();
  if (state.running) return;

  state.adapter = adapter;
  await adapter.start();

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.loopAbort = new AbortController();

  const { lifecycle } = getBridgeContext();
  if (lifecycle.onBridgeStart) lifecycle.onBridgeStart();

  runMessageLoop(adapter, state.loopAbort.signal);

  console.log('[bridge-manager] Bridge started');
}

export async function stop(): Promise<void> {
  const state = getState();
  if (!state.running) return;

  if (state.loopAbort) state.loopAbort.abort();
  if (state.adapter) await state.adapter.stop();

  state.running = false;
  state.startedAt = null;
  state.adapter = null;

  const { lifecycle } = getBridgeContext();
  if (lifecycle.onBridgeStop) lifecycle.onBridgeStop();

  console.log('[bridge-manager] Bridge stopped');
}

export function getStatus(): BridgeStatus {
  const state = getState();
  return {
    running: state.running,
    startedAt: state.startedAt,
    adapters: state.adapter ? [{
      channelType: state.adapter.channelType,
      running: state.adapter.isRunning(),
      connectedAt: state.startedAt,
      lastMessageAt: null,
      error: null,
    }] : [],
  };
}

function runMessageLoop(adapter: FeishuAdapter, signal: AbortSignal): void {
  const loop = async () => {
    while (!signal.aborted) {
      try {
        const msg = await adapter.consumeOne();
        if (!msg || signal.aborted) break;
        handleMessage(adapter, msg).catch(err => {
          console.error('[bridge-manager] Message handling error:', err instanceof Error ? err.message : err);
        });
      } catch (err) {
        if (signal.aborted) break;
        console.error('[bridge-manager] Message loop error:', err instanceof Error ? err.message : err);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  };
  loop();
}

async function handleMessage(adapter: FeishuAdapter, msg: InboundMessage): Promise<void> {
  const { store } = getBridgeContext();

  try {
    store.insertAuditLog({
      channelType: msg.address.channelType,
      chatId: msg.address.chatId,
      direction: 'inbound',
      messageId: msg.messageId,
      summary: msg.text.slice(0, 100),
    });
  } catch { /* best effort */ }

  if (msg.callbackData) {
    const handled = broker.handlePermissionCallback(
      msg.callbackData,
      msg.address.chatId,
      msg.callbackMessageId,
    );
    if (handled) {
      await deliver(adapter, {
        address: msg.address,
        text: '✅ Permission updated',
        parseMode: 'plain',
        replyToMessageId: msg.callbackMessageId,
      });
      return;
    }
  }

  const text = msg.callbackData || msg.text;
  if (!text.trim()) return;

  const sanitized = sanitizeInput(text);

  const permMatch = sanitized.match(/^\/perm\s+(allow|allow_session|deny)\s+(.+)$/);
  if (permMatch) {
    const [, action, permId] = permMatch;
    broker.handlePermissionCallback(`perm:${action}:${permId}`, msg.address.chatId);
    await deliver(adapter, {
      address: msg.address,
      text: `✅ Permission ${action} for ${permId}`,
      parseMode: 'plain',
    });
    return;
  }

  const modelCmd = parseModelCommand(sanitized);
  if (modelCmd) {
    const binding = resolveBinding(adapter, msg);
    if (binding) {
      try { store.updateSessionModel(binding.sessionId, modelCmd); } catch { /* best effort */ }
    }
    await deliver(adapter, {
      address: msg.address,
      text: `🔄 Model switched to: ${modelCmd}`,
      parseMode: 'plain',
    });
    return;
  }

  const modeCmd = parseModeCommand(sanitized);
  if (modeCmd) {
    const binding = resolveBinding(adapter, msg);
    if (binding) {
      try { store.updateChannelBinding(binding.id, { mode: modeCmd }); } catch { /* best effort */ }
    }
    await deliver(adapter, {
      address: msg.address,
      text: buildModeAnnouncement(modeCmd),
      parseMode: 'plain',
    });
    return;
  }

  const helpMatch = sanitized.match(/^\/(help|帮助)$/i);
  if (helpMatch) {
    await deliver(adapter, {
      address: msg.address,
      text: [
        '🤖 **TraeCN-to-IM Bridge Commands**',
        '',
        '/mode code — Switch to Code mode (AI can edit files)',
        '/mode plan — Switch to Plan mode (AI plans first)',
        '/mode ask — Switch to Ask mode (Q&A only)',
        '/model <name> — Switch AI model',
        '/perm allow <id> — Approve permission request',
        '/perm deny <id> — Deny permission request',
        '/help — Show this help',
      ].join('\n'),
      parseMode: 'Markdown',
    });
    return;
  }

  const binding = resolveBinding(adapter, msg);
  if (!binding) return;

  let effectiveMode = binding.mode;
  if (shouldAutoDetect(binding)) {
    const detection = detectMode(sanitized, binding.mode);
    if (detection.confidence > 0.5 && detection.mode !== binding.mode) {
      effectiveMode = detection.mode;
      try { store.updateChannelBinding(binding.id, { mode: effectiveMode }); } catch { /* best effort */ }
    }
  }

  processWithSessionLock(binding.sessionId, async () => {
    adapter.onMessageStart(msg.address.chatId);

    const activeTools: ToolCallInfo[] = [];

    try {
      const result = await engine.processMessage(
        binding,
        sanitized,
        async (perm) => {
          await broker.forwardPermissionRequest(
            adapter,
            msg.address,
            perm.permissionRequestId,
            perm.toolName,
            perm.toolInput,
            binding.sessionId,
            perm.suggestions,
            msg.messageId,
          );
        },
        undefined,
        msg.attachments,
        (fullText) => {
          adapter.onStreamText(msg.address.chatId, fullText, activeTools);
        },
        (toolId, toolName, status) => {
          const idx = activeTools.findIndex(t => t.id === toolId);
          if (idx >= 0) activeTools[idx].status = status;
          else activeTools.push({ id: toolId, name: toolName, status });
        },
      );

      const cardFinalized = await adapter.onStreamEnd(
        msg.address.chatId,
        result.hasError ? 'error' : 'completed',
        result.responseText,
      );

      if (!cardFinalized && result.responseText) {
        await deliver(adapter, {
          address: msg.address,
          text: result.responseText,
          parseMode: 'Markdown',
          replyToMessageId: msg.messageId,
        }, { sessionId: binding.sessionId });
      }

      if (result.hasError) {
        await deliver(adapter, {
          address: msg.address,
          text: `❌ Error: ${result.errorMessage}`,
          parseMode: 'plain',
        });
      }

      if (result.sdkSessionId) {
        try { store.updateSdkSessionId(binding.sessionId, result.sdkSessionId); } catch { /* best effort */ }
      }
    } catch (err) {
      adapter.onStreamEnd(msg.address.chatId, 'error', '');
      await deliver(adapter, {
        address: msg.address,
        text: `❌ Internal error: ${err instanceof Error ? err.message : String(err)}`,
        parseMode: 'plain',
      });
    } finally {
      adapter.onMessageEnd(msg.address.chatId);
    }
  });
}

function resolveBinding(adapter: FeishuAdapter, msg: InboundMessage): ChannelBinding | null {
  const { store } = getBridgeContext();
  const { chatId, channelType } = msg.address;

  let binding = store.getChannelBinding(channelType, chatId);
  if (binding) return binding;

  const defaultCwd = store.getSetting('bridge_default_cwd') || process.cwd();
  const defaultModel = store.getSetting('bridge_model') || store.getSetting('default_model') || '';

  const session = store.createSession(
    `feishu-${chatId}`,
    defaultModel,
    undefined,
    defaultCwd,
    'code',
  );

  binding = store.upsertChannelBinding({
    channelType,
    chatId,
    sessionId: session.id,
    workingDirectory: defaultCwd,
    model: defaultModel,
    mode: 'code',
  });

  return binding;
}
