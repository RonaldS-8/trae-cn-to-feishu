import * as lark from '@larksuiteoapi/node-sdk';
import type { ChannelType, InboundMessage, OutboundMessage, SendResult } from '../core/types.js';
import type { FileAttachment } from '../core/types.js';
import { getBridgeContext } from '../core/context.js';
import {
  hasComplexMarkdown,
  preprocessFeishuMarkdown,
  buildCardContent,
  buildPostContent,
  htmlToFeishuMarkdown,
  buildPermissionButtonCard,
} from './feishu-markdown.js';

const DEDUP_MAX = 1000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const TYPING_EMOJI = 'Typing';
const EDIT_THROTTLE_MS = 500;

type FeishuMessageEventData = {
  sender: {
    sender_id?: { open_id?: string; union_id?: string; user_id?: string };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string; user_id?: string };
      name: string;
    }>;
  };
};

interface EditPreviewState {
  chatId: string;
  messageId: string;
  lastSentText: string;
  lastSentAt: number;
  throttleTimer: ReturnType<typeof setTimeout> | null;
  pendingText: string;
}

export class FeishuAdapter {
  readonly channelType: ChannelType = 'feishu';

  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private seenMessageIds = new Map<string, boolean>();
  private botOpenId: string | null = null;
  private botIds = new Set<string>();
  private lastIncomingMessageId = new Map<string, string>();
  private typingReactions = new Map<string, string>();
  private activePreviews = new Map<string, EditPreviewState>();

  async start(): Promise<void> {
    if (this.running) return;

    const configError = this.validateConfig();
    if (configError) {
      console.warn('[feishu-adapter] Cannot start:', configError);
      return;
    }

    const { store } = getBridgeContext();
    const appId = store.getSetting('bridge_feishu_app_id') || '';
    const appSecret = store.getSetting('bridge_feishu_app_secret') || '';
    const domainSetting = store.getSetting('bridge_feishu_domain') || 'feishu';
    const domain = domainSetting === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;

    this.restClient = new lark.Client({ appId, appSecret, domain });
    await this.resolveBotIdentity(appId, appSecret, domain);

    this.running = true;

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        await this.handleIncomingEvent(data as FeishuMessageEventData);
      },
      'card.action.trigger': (async (data: unknown) => {
        return await this.handleCardAction(data);
      }) as any,
    });

    this.wsClient = new lark.WSClient({ appId, appSecret, domain });

    const wsClientAny = this.wsClient as any;
    if (typeof wsClientAny.handleEventData === 'function') {
      const origHandleEventData = wsClientAny.handleEventData.bind(wsClientAny);
      wsClientAny.handleEventData = (data: any) => {
        const msgType = data.headers?.find?.((h: any) => h.key === 'type')?.value;
        if (msgType === 'card') {
          const patchedData = {
            ...data,
            headers: data.headers.map((h: any) =>
              h.key === 'type' ? { ...h, value: 'event' } : h,
            ),
          };
          return origHandleEventData(patchedData);
        }
        return origHandleEventData(data);
      };
    }

    this.wsClient.start({ eventDispatcher: dispatcher });
    console.log('[feishu-adapter] Started (botOpenId:', this.botOpenId || 'unknown', ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.wsClient) {
      try { this.wsClient.close({ force: true }); } catch { /* ignore */ }
      this.wsClient = null;
    }
    this.restClient = null;

    for (const waiter of this.waiters) waiter(null);
    this.waiters = [];

    for (const [, state] of this.activePreviews) {
      if (state.throttleTimer) clearTimeout(state.throttleTimer);
    }
    this.activePreviews.clear();

    this.seenMessageIds.clear();
    this.lastIncomingMessageId.clear();
    this.typingReactions.clear();
    console.log('[feishu-adapter] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (!this.running) return Promise.resolve(null);
    return new Promise<InboundMessage | null>(resolve => {
      this.waiters.push(resolve);
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!this.restClient) return { ok: false, error: 'Adapter not running' };

    const { address, text, inlineButtons, replyToMessageId } = message;

    try {
      if (inlineButtons && inlineButtons.length > 0) {
        const flatButtons = inlineButtons.flat();
        if (flatButtons.length > 0) {
          const permBtn = flatButtons[0];
          const parts = permBtn.callbackData.split(':');
          const action = parts[1] || 'allow';
          const permId = parts.slice(2).join(':');
          const cardJson = buildPermissionButtonCard(text, permId, address.chatId);
          return await this.sendCard(address.chatId, cardJson, replyToMessageId);
        }
      }

      const processedText = preprocessFeishuMarkdown(text);
      if (hasComplexMarkdown(processedText)) {
        const cardJson = buildCardContent(processedText);
        return await this.sendCard(address.chatId, cardJson, replyToMessageId);
      }

      return await this.sendPost(address.chatId, processedText, replyToMessageId);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[feishu-adapter] Send failed:', errorMsg);
      return { ok: false, error: errorMsg };
    }
  }

  onMessageStart(chatId: string): void {
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (!messageId || !this.restClient) return;

    this.restClient.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: TYPING_EMOJI } },
    }).then((res: any) => {
      const reactionId = res?.data?.reaction_id;
      if (reactionId) this.typingReactions.set(chatId, reactionId);
    }).catch(() => { /* ignore */ });
  }

  onMessageEnd(chatId: string): void {
    const reactionId = this.typingReactions.get(chatId);
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (!reactionId || !messageId || !this.restClient) return;
    this.typingReactions.delete(chatId);
    this.restClient.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    }).catch(() => { /* ignore */ });
  }

  onStreamText(chatId: string, fullText: string): void {
    let state = this.activePreviews.get(chatId);
    if (!state) {
      state = {
        chatId,
        messageId: '',
        lastSentText: '',
        lastSentAt: 0,
        throttleTimer: null,
        pendingText: '',
      };
      this.activePreviews.set(chatId, state);
    }
    state.pendingText = fullText;

    const elapsed = Date.now() - state.lastSentAt;
    if (elapsed < EDIT_THROTTLE_MS && state.lastSentAt > 0) {
      if (!state.throttleTimer) {
        state.throttleTimer = setTimeout(() => {
          if (state) state.throttleTimer = null;
          this.flushPreview(chatId);
        }, EDIT_THROTTLE_MS - elapsed);
      }
      return;
    }

    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    this.flushPreview(chatId);
  }

  onStreamEnd(chatId: string, _status: string, _responseText: string): Promise<boolean> {
    const state = this.activePreviews.get(chatId);
    if (state?.throttleTimer) clearTimeout(state.throttleTimer);
    this.activePreviews.delete(chatId);
    return Promise.resolve(false);
  }

  validateConfig(): string | null {
    const { store } = getBridgeContext();
    const appId = store.getSetting('bridge_feishu_app_id');
    const appSecret = store.getSetting('bridge_feishu_app_secret');
    if (!appId) return 'Missing bridge_feishu_app_id';
    if (!appSecret) return 'Missing bridge_feishu_app_secret';
    return null;
  }

  isAuthorized(userId: string, _chatId: string): boolean {
    const { store } = getBridgeContext();
    const allowedStr = store.getSetting('bridge_feishu_allowed_users');
    if (!allowedStr) return true;
    const allowed = allowedStr.split(',').map(s => s.trim()).filter(Boolean);
    return allowed.length === 0 || allowed.includes(userId);
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(msg);
    else this.queue.push(msg);
  }

  private async resolveBotIdentity(appId: string, appSecret: string, domain: lark.Domain): Promise<void> {
    try {
      const tempClient = new lark.Client({ appId, appSecret, domain });
      const resp = await (tempClient as any).bot.info.get();
      const botInfo = resp?.data?.bot;
      if (botInfo) {
        this.botOpenId = botInfo.open_id || null;
        if (botInfo.open_id) this.botIds.add(botInfo.open_id);
        if (botInfo.user_id) this.botIds.add(botInfo.user_id);
        if (botInfo.union_id) this.botIds.add(botInfo.union_id);
      }
    } catch (err) {
      console.warn('[feishu-adapter] Failed to resolve bot identity:', err instanceof Error ? err.message : err);
    }
  }

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    try {
      const { sender, message } = data;
      const messageId = message.message_id;
      const chatId = message.chat_id;
      const userId = sender.sender_id?.open_id || sender.sender_id?.user_id || '';

      if (this.seenMessageIds.has(messageId)) return;
      this.seenMessageIds.set(messageId, true);
      if (this.seenMessageIds.size > DEDUP_MAX) {
        const arr = Array.from(this.seenMessageIds.keys());
        for (let i = 0; i < arr.length - DEDUP_MAX; i++) {
          this.seenMessageIds.delete(arr[i]);
        }
      }

      if (sender.sender_type !== 'user') return;
      if (this.botIds.has(userId)) return;

      this.lastIncomingMessageId.set(chatId, messageId);

      let text = '';
      if (message.message_type === 'text') {
        try {
          const parsed = JSON.parse(message.content);
          text = parsed.text || '';
        } catch { text = message.content; }
      } else if (message.message_type === 'post') {
        try {
          const parsed = JSON.parse(message.content);
          const lang = Object.keys(parsed)[0];
          const contentArr = parsed[lang]?.content || [];
          text = contentArr
            .flat()
            .map((el: any) => {
              if (el.tag === 'text') return el.text || '';
              if (el.tag === 'a') return el.text || el.href || '';
              if (el.tag === 'at') return `@${el.user_name || el.user_id || ''}`;
              return '';
            })
            .join('');
        } catch { text = message.content; }
      }

      if (message.mentions && message.mentions.length > 0) {
        for (const mention of message.mentions) {
          text = text.replace(mention.key, '').trim();
        }
      }

      text = text.trim();
      if (!text) return;

      if (!this.isAuthorized(userId, chatId)) {
        console.warn('[feishu-adapter] Unauthorized user:', userId);
        return;
      }

      const attachments: FileAttachment[] = [];
      if (message.message_type === 'image' && this.restClient) {
        try {
          const parsed = JSON.parse(message.content);
          const imageKey = parsed.image_key;
          if (imageKey) {
            const resp = await this.restClient.im.messageResource.get({
              path: { message_id: messageId, file_key: imageKey },
              params: { type: 'image' },
            });
            const fileData = (resp as any)?.data;
            if (fileData) {
              attachments.push({
                id: imageKey,
                name: `image_${imageKey}.png`,
                type: 'image/png',
                size: 0,
                data: fileData,
              });
            }
          }
        } catch (err) {
          console.warn('[feishu-adapter] Failed to download image:', err instanceof Error ? err.message : err);
        }
      }

      const inbound: InboundMessage = {
        messageId,
        address: { channelType: 'feishu', chatId, userId },
        text,
        timestamp: Date.now(),
        attachments: attachments.length > 0 ? attachments : undefined,
      };
      this.enqueue(inbound);

      const { store } = getBridgeContext();
      try {
        store.setChannelOffset(`feishu_${chatId}`, messageId);
      } catch { /* best effort */ }
    } catch (err) {
      console.error('[feishu-adapter] Error handling incoming event:', err instanceof Error ? err.message : err);
    }
  }

  private async handleCardAction(data: unknown): Promise<unknown> {
    const FALLBACK_TOAST = { toast: { type: 'info' as const, content: '已收到' } };
    try {
      const event = data as any;
      const value = event?.action?.value ?? {};
      const callbackData = value.callback_data;
      if (!callbackData) return FALLBACK_TOAST;

      const chatId = event?.context?.open_chat_id || value.chatId || '';
      const messageId = event?.context?.open_message_id || '';
      const userId = event?.operator?.open_id || '';
      if (!chatId) return FALLBACK_TOAST;

      const callbackMsg: InboundMessage = {
        messageId: messageId || `card_action_${Date.now()}`,
        address: { channelType: 'feishu', chatId, userId },
        text: '',
        timestamp: Date.now(),
        callbackData,
        callbackMessageId: messageId,
      };
      this.enqueue(callbackMsg);
      return { toast: { type: 'info' as const, content: '已收到，正在处理...' } };
    } catch (err) {
      console.error('[feishu-adapter] Card action handler error:', err instanceof Error ? err.message : err);
      return FALLBACK_TOAST;
    }
  }

  private async sendCard(chatId: string, cardJson: string, replyToMessageId?: string): Promise<SendResult> {
    if (!this.restClient) return { ok: false, error: 'Adapter not running' };
    try {
      const content = JSON.stringify({ type: 'card', data: JSON.parse(cardJson) });
      let resp;
      if (replyToMessageId) {
        resp = await this.restClient.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: 'interactive' },
        });
      } else {
        resp = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content },
        });
      }
      const msgId = (resp as any)?.data?.message_id;
      return { ok: true, messageId: msgId };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: errorMsg };
    }
  }

  private async sendPost(chatId: string, text: string, replyToMessageId?: string): Promise<SendResult> {
    if (!this.restClient) return { ok: false, error: 'Adapter not running' };
    try {
      const content = buildPostContent(text);
      let resp;
      if (replyToMessageId) {
        resp = await this.restClient.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: 'post' },
        });
      } else {
        resp = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'post', content },
        });
      }
      const msgId = (resp as any)?.data?.message_id;
      return { ok: true, messageId: msgId };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: errorMsg };
    }
  }

  private flushPreview(chatId: string): void {
    const state = this.activePreviews.get(chatId);
    if (!state || !this.restClient || !state.pendingText) return;

    const text = state.pendingText.length > 29000
      ? state.pendingText.slice(0, 29000) + '...'
      : state.pendingText;

    state.lastSentText = text;
    state.lastSentAt = Date.now();

    const processedText = preprocessFeishuMarkdown(text);
    const content = hasComplexMarkdown(processedText)
      ? JSON.stringify({ type: 'card', data: JSON.parse(buildCardContent(processedText)) })
      : JSON.stringify({ type: 'post', data: JSON.parse(buildPostContent(processedText)) });

    const msgType = hasComplexMarkdown(processedText) ? 'interactive' : 'post';

    if (state.messageId) {
      this.restClient.im.message.patch({
        path: { message_id: state.messageId },
        data: { content },
      }).then((resp: any) => {
        const msgId = resp?.data?.message_id;
        if (msgId) state.messageId = msgId;
      }).catch(() => { /* best effort */ });
    } else {
      this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: msgType as any, content },
      }).then((resp: any) => {
        const msgId = resp?.data?.message_id;
        if (msgId) state.messageId = msgId;
      }).catch(() => { /* best effort */ });
    }
  }
}
