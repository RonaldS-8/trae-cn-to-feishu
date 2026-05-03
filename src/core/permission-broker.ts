import type { ChannelAddress, OutboundMessage } from './types.js';
import type { FeishuAdapter } from '../feishu/feishu-adapter.js';
import { deliver } from './delivery-layer.js';
import { getBridgeContext } from './context.js';

const recentPermissionForwards = new Map<string, number>();

export async function forwardPermissionRequest(
  adapter: FeishuAdapter,
  address: ChannelAddress,
  permissionRequestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId?: string,
  suggestions?: unknown[],
  replyToMessageId?: string,
): Promise<void> {
  const { store } = getBridgeContext();

  const now = Date.now();
  if (recentPermissionForwards.has(permissionRequestId)) return;
  recentPermissionForwards.set(permissionRequestId, now);
  for (const [id, ts] of recentPermissionForwards) {
    if (now - ts > 30_000) recentPermissionForwards.delete(id);
  }

  const inputStr = JSON.stringify(toolInput, null, 2);
  const truncatedInput = inputStr.length > 300 ? inputStr.slice(0, 300) + '...' : inputStr;

  const plainText = [
    `⚠️ Permission Required`,
    ``,
    `Tool: ${toolName}`,
    truncatedInput,
    ``,
    `Reply:`,
    `1 - Allow once`,
    `2 - Allow session`,
    `3 - Deny`,
    ``,
    `Or use:`,
    `/perm allow ${permissionRequestId}`,
    `/perm allow_session ${permissionRequestId}`,
    `/perm deny ${permissionRequestId}`,
  ].join('\n');

  const message: OutboundMessage = {
    address,
    text: plainText,
    parseMode: 'plain',
    inlineButtons: [[
      { text: 'Allow', callbackData: `perm:allow:${permissionRequestId}` },
      { text: 'Allow Session', callbackData: `perm:allow_session:${permissionRequestId}` },
      { text: 'Deny', callbackData: `perm:deny:${permissionRequestId}` },
    ]],
    replyToMessageId,
  };

  const result = await deliver(adapter, message, { sessionId });

  if (result.ok && result.messageId) {
    try {
      store.insertPermissionLink({
        permissionRequestId,
        channelType: adapter.channelType,
        chatId: address.chatId,
        messageId: result.messageId,
        toolName,
        suggestions: suggestions ? JSON.stringify(suggestions) : '',
      });
    } catch { /* best effort */ }
  }
}

export function handlePermissionCallback(
  callbackData: string,
  callbackChatId: string,
  _callbackMessageId?: string,
): boolean {
  const { store, permissions } = getBridgeContext();

  if (!callbackData.startsWith('perm:')) return false;

  const parts = callbackData.split(':');
  if (parts.length < 3) return false;

  const action = parts[1];
  const permId = parts.slice(2).join(':');

  const link = store.getPermissionLink(permId);
  if (!link) return false;
  if (link.chatId !== callbackChatId) return false;

  const resolved = store.markPermissionLinkResolved(permId);
  if (!resolved) return false;

  let behavior: 'allow' | 'deny';
  let message: string;

  switch (action) {
    case 'allow':
      behavior = 'allow';
      message = 'Allowed (once)';
      break;
    case 'allow_session':
      behavior = 'allow';
      message = 'Allowed for session';
      break;
    case 'deny':
      behavior = 'deny';
      message = 'Denied';
      break;
    default:
      return false;
  }

  permissions.resolvePendingPermission(permId, { behavior, message });
  return true;
}
