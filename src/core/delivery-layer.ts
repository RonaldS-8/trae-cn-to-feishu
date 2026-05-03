import type { ChannelAddress, OutboundMessage, SendResult } from './types.js';
import { PLATFORM_LIMITS } from './types.js';
import type { FeishuAdapter } from '../feishu/feishu-adapter.js';
import { getBridgeContext } from './context.js';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const JITTER_MAX_MS = 500;
const INTER_CHUNK_DELAY_MS = 300;

function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', maxLength);
    if (splitIdx <= 0 || splitIdx < maxLength * 0.5) splitIdx = maxLength;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, '');
  }
  return chunks;
}

function backoffDelay(attempt: number): number {
  const base = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * JITTER_MAX_MS;
  return base + jitter;
}

type ErrorCategory = 'rate_limit' | 'server_error' | 'client_error' | 'parse_error' | 'network';

function classifyError(result: SendResult): ErrorCategory {
  const status = result.httpStatus;
  const error = result.error ?? '';
  if (status === 429) return 'rate_limit';
  if (status && status >= 500) return 'server_error';
  if (status && status >= 400 && status < 500) {
    if (/can't parse entities|parse entities/i.test(error)) return 'parse_error';
    return 'client_error';
  }
  if (/too many requests|rate limit/i.test(error)) return 'rate_limit';
  return 'network';
}

function shouldRetry(category: ErrorCategory): boolean {
  return category === 'rate_limit' || category === 'server_error' || category === 'network';
}

async function sendWithRetry(adapter: FeishuAdapter, message: OutboundMessage): Promise<SendResult> {
  let lastResult: SendResult = { ok: false, error: 'No attempts made' };
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    lastResult = await adapter.send(message);
    if (lastResult.ok) return lastResult;
    const category = classifyError(lastResult);
    if (!shouldRetry(category)) return lastResult;
    if (attempt < MAX_RETRIES - 1) {
      const delay = lastResult.retryAfter ? lastResult.retryAfter * 1000 + 200 : backoffDelay(attempt);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return lastResult;
}

export async function deliver(
  adapter: FeishuAdapter,
  message: OutboundMessage,
  opts?: { sessionId?: string; dedupKey?: string },
): Promise<SendResult> {
  const { store } = getBridgeContext();

  if (opts?.dedupKey && store.checkDedup(opts.dedupKey)) {
    return { ok: true };
  }

  if (Math.random() < 0.01) {
    try { store.cleanupExpiredDedup(); } catch { /* best effort */ }
  }

  const limit = PLATFORM_LIMITS[adapter.channelType] || 30000;
  const chunks = chunkText(message.text, limit);

  let lastMessageId: string | undefined;

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, INTER_CHUNK_DELAY_MS));

    const chunkMessage: OutboundMessage = {
      ...message,
      text: chunks[i],
      inlineButtons: i === chunks.length - 1 ? message.inlineButtons : undefined,
    };

    const result = await sendWithRetry(adapter, chunkMessage);
    if (!result.ok) return result;
    lastMessageId = result.messageId;

    if (result.messageId && opts?.sessionId) {
      try {
        store.insertAuditLog({
          channelType: adapter.channelType,
          chatId: message.address.chatId,
          direction: 'outbound',
          messageId: result.messageId,
          summary: chunks[i].slice(0, 100),
        });
      } catch { /* best effort */ }
    }
  }

  if (opts?.dedupKey) {
    try { store.insertDedup(opts.dedupKey); } catch { /* best effort */ }
  }

  return { ok: true, messageId: lastMessageId };
}
