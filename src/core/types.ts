export type ChannelType = string;

export interface ChannelAddress {
  channelType: ChannelType;
  chatId: string;
  userId?: string;
  displayName?: string;
}

export interface InboundMessage {
  messageId: string;
  address: ChannelAddress;
  text: string;
  timestamp: number;
  callbackData?: string;
  callbackMessageId?: string;
  raw?: unknown;
  updateId?: number;
  attachments?: FileAttachment[];
}

export interface OutboundMessage {
  address: ChannelAddress;
  text: string;
  parseMode?: 'HTML' | 'Markdown' | 'plain';
  inlineButtons?: InlineButton[][];
  replyToMessageId?: string;
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  httpStatus?: number;
  retryAfter?: number;
}

export interface FileAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  data: string;
  filePath?: string;
}

export interface ChannelBinding {
  id: string;
  channelType: ChannelType;
  chatId: string;
  sessionId: string;
  sdkSessionId: string;
  workingDirectory: string;
  model: string;
  mode: 'code' | 'plan' | 'ask';
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeStatus {
  running: boolean;
  startedAt: string | null;
  adapters: AdapterStatus[];
}

export interface AdapterStatus {
  channelType: ChannelType;
  running: boolean;
  connectedAt: string | null;
  lastMessageAt: string | null;
  error: string | null;
}

export interface SSEEvent {
  type: SSEEventType;
  data: string;
}

export type SSEEventType =
  | 'text'
  | 'tool_use'
  | 'tool_result'
  | 'tool_output'
  | 'tool_timeout'
  | 'status'
  | 'result'
  | 'error'
  | 'permission_request'
  | 'mode_changed'
  | 'task_update'
  | 'keep_alive'
  | 'done';

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cost_usd?: number;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  status: 'running' | 'complete' | 'error';
}

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions?: unknown[];
}

export const PLATFORM_LIMITS: Record<string, number> = {
  feishu: 30000,
};
