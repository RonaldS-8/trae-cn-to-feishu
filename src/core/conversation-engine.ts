import crypto from 'node:crypto';
import type { ChannelBinding, FileAttachment, PermissionRequestInfo, ToolCallInfo } from './types.js';
import type { ConversationResult } from './host.js';
import { getBridgeContext } from './context.js';

export type OnPermissionRequest = (perm: PermissionRequestInfo) => Promise<void>;
export type OnPartialText = (fullText: string) => void;
export type OnToolEvent = (toolId: string, toolName: string, status: 'running' | 'complete' | 'error') => void;

export async function processMessage(
  binding: ChannelBinding,
  text: string,
  onPermissionRequest?: OnPermissionRequest,
  abortSignal?: AbortSignal,
  files?: FileAttachment[],
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
): Promise<ConversationResult> {
  const { store, llm } = getBridgeContext();
  const sessionId = binding.sessionId;

  const lockId = crypto.randomBytes(8).toString('hex');
  const lockAcquired = store.acquireSessionLock(sessionId, lockId, `bridge-${binding.channelType}`, 600);
  if (!lockAcquired) {
    return {
      responseText: '',
      tokenUsage: null,
      hasError: true,
      errorMessage: 'Session is busy processing another request',
      permissionRequests: [],
      sdkSessionId: null,
    };
  }

  store.setSessionRuntimeStatus(sessionId, 'running');

  const renewalInterval = setInterval(() => {
    try { store.renewSessionLock(sessionId, lockId, 600); } catch { /* best effort */ }
  }, 60_000);

  try {
    const session = store.getSession(sessionId);
    let savedContent = text;
    if (files && files.length > 0) {
      savedContent = `[${files.length} image(s) attached] ${text}`;
    }
    store.addMessage(sessionId, 'user', savedContent);

    const effectiveModel = binding.model || session?.model || store.getSetting('default_model') || undefined;

    let permissionMode: string;
    switch (binding.mode) {
      case 'plan': permissionMode = 'plan'; break;
      case 'ask': permissionMode = 'default'; break;
      default: permissionMode = 'acceptEdits'; break;
    }

    const { messages: recentMsgs } = store.getMessages(sessionId, { limit: 50 });
    const historyMsgs = recentMsgs.slice(0, -1).map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const abortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) abortController.abort();
      else abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
    }

    const stream = llm.streamChat({
      prompt: text,
      sessionId,
      sdkSessionId: binding.sdkSessionId || undefined,
      model: effectiveModel,
      systemPrompt: session?.system_prompt || undefined,
      workingDirectory: binding.workingDirectory || session?.working_directory || undefined,
      abortController,
      permissionMode,
      conversationHistory: historyMsgs,
      files,
      onRuntimeStatusChange: (status: string) => {
        try { store.setSessionRuntimeStatus(sessionId, status); } catch { /* best effort */ }
      },
    });

    return await consumeStream(stream, sessionId, onPermissionRequest, onPartialText, onToolEvent);
  } finally {
    clearInterval(renewalInterval);
    store.releaseSessionLock(sessionId, lockId);
    store.setSessionRuntimeStatus(sessionId, 'idle');
  }
}

async function consumeStream(
  stream: ReadableStream<string>,
  sessionId: string,
  onPermissionRequest?: OnPermissionRequest,
  onPartialText?: OnPartialText,
  onToolEvent?: OnToolEvent,
): Promise<ConversationResult> {
  const { store } = getBridgeContext();
  const reader = stream.getReader();

  let responseText = '';
  let tokenUsage: import('./types.js').TokenUsage | null = null;
  let hasError = false;
  let errorMessage = '';
  const permissionRequests: PermissionRequestInfo[] = [];
  let sdkSessionId: string | null = null;

  try {
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentType = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const dataStr = line.slice(6);
          try {
            const data = JSON.parse(dataStr);
            switch (currentType) {
              case 'text':
                responseText += data.text || data;
                if (onPartialText) onPartialText(responseText);
                break;
              case 'tool_use':
                if (onToolEvent) onToolEvent(data.id || '', data.name || '', 'running');
                break;
              case 'tool_result':
                if (onToolEvent) onToolEvent(data.tool_use_id || '', '', 'complete');
                break;
              case 'permission_request': {
                const permInfo: PermissionRequestInfo = {
                  permissionRequestId: data.permissionRequestId || data.id || '',
                  toolName: data.toolName || data.tool_name || '',
                  toolInput: data.toolInput || data.tool_input || {},
                  suggestions: data.suggestions,
                };
                permissionRequests.push(permInfo);
                if (onPermissionRequest) {
                  onPermissionRequest(permInfo).catch(() => { /* best effort */ });
                }
                break;
              }
              case 'result':
                if (data.tokenUsage) tokenUsage = data.tokenUsage;
                if (data.sdkSessionId) sdkSessionId = data.sdkSessionId;
                if (data.text && !responseText) responseText = data.text;
                break;
              case 'status':
                if (data.sdkSessionId) sdkSessionId = data.sdkSessionId;
                break;
              case 'error':
                hasError = true;
                errorMessage = data.error || data.message || 'Unknown error';
                break;
            }
          } catch {
            if (currentType === 'text') {
              responseText += dataStr;
              if (onPartialText) onPartialText(responseText);
            }
          }
        }
      }
    }
  } catch (err) {
    hasError = true;
    errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    reader.releaseLock();
  }

  store.addMessage(sessionId, 'assistant', responseText, tokenUsage ? JSON.stringify(tokenUsage) : null);

  return {
    responseText,
    tokenUsage,
    hasError,
    errorMessage,
    permissionRequests,
    sdkSessionId,
  };
}
