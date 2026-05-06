import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  runtime: 'window' | 'extension' | 'auto';
  enabledChannels: string[];
  defaultWorkDir: string;
  defaultModel?: string;
  defaultMode: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  feishuDomain?: string;
  feishuAllowedUsers?: string[];
  feishuChatId?: string;
  messageTimeoutFirst: number;
  messageTimeoutRetry: number;
  traeMsgSuffix: string;
  autoApprove: boolean;
}

export const CTI_HOME = process.env.CTI_HOME || path.join(process.cwd(), '.traecn-to-feishu');
export const CONFIG_PATH = path.join(CTI_HOME, 'config.env');

function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.set(key, value);
  }
  return entries;
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  let env = new Map<string, string>();
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    env = parseEnvFile(content);
  } catch {
    // config file not found, use defaults
  }

  const pythonPath = env.get('CTI_PYTHON_PATH');
  if (pythonPath && !process.env.CTI_PYTHON_PATH) {
    process.env.CTI_PYTHON_PATH = pythonPath;
  }
  const monitorDebug = env.get('CTI_MONITOR_DEBUG');
  if (monitorDebug && !process.env.CTI_MONITOR_DEBUG) {
    process.env.CTI_MONITOR_DEBUG = monitorDebug;
  }

  const rawRuntime = env.get('CTI_RUNTIME') || 'window';
  const runtime = (['window', 'extension', 'auto'].includes(rawRuntime)
    ? rawRuntime
    : 'window') as Config['runtime'];

  return {
    runtime,
    enabledChannels: splitCsv(env.get('CTI_ENABLED_CHANNELS')) ?? ['feishu'],
    defaultWorkDir: env.get('CTI_DEFAULT_WORKDIR') || process.cwd(),
    defaultModel: env.get('CTI_DEFAULT_MODEL') || undefined,
    defaultMode: env.get('CTI_DEFAULT_MODE') || 'code',
    feishuAppId: env.get('CTI_FEISHU_APP_ID') || undefined,
    feishuAppSecret: env.get('CTI_FEISHU_APP_SECRET') || undefined,
    feishuDomain: env.get('CTI_FEISHU_DOMAIN') || undefined,
    feishuAllowedUsers: splitCsv(env.get('CTI_FEISHU_ALLOWED_USERS')),
    feishuChatId: env.get('CTI_FEISHU_CHAT_ID') || undefined,
    messageTimeoutFirst: parseInt(env.get('CTI_MESSAGE_TIMEOUT_FIRST') || '20000', 10),
    messageTimeoutRetry: parseInt(env.get('CTI_MESSAGE_TIMEOUT_RETRY') || '20000', 10),
    traeMsgSuffix: env.get('CTI_TRAE_MSG_SUFFIX') || '',
    autoApprove: env.get('CTI_AUTO_APPROVE') === 'true',
  };
}

function formatEnvLine(key: string, value: string | undefined): string {
  if (value === undefined || value === '') return '';
  return `${key}=${value}\n`;
}

export function saveConfig(config: Config): void {
  let out = '';
  out += formatEnvLine('CTI_RUNTIME', config.runtime);
  out += formatEnvLine('CTI_ENABLED_CHANNELS', config.enabledChannels.join(','));
  out += formatEnvLine('CTI_DEFAULT_WORKDIR', config.defaultWorkDir);
  if (config.defaultModel) out += formatEnvLine('CTI_DEFAULT_MODEL', config.defaultModel);
  out += formatEnvLine('CTI_DEFAULT_MODE', config.defaultMode);
  out += formatEnvLine('CTI_FEISHU_APP_ID', config.feishuAppId);
  out += formatEnvLine('CTI_FEISHU_APP_SECRET', config.feishuAppSecret);
  out += formatEnvLine('CTI_FEISHU_DOMAIN', config.feishuDomain);
  out += formatEnvLine('CTI_FEISHU_ALLOWED_USERS', config.feishuAllowedUsers?.join(','));
  out += formatEnvLine('CTI_FEISHU_CHAT_ID', config.feishuChatId);
  out += formatEnvLine('CTI_MESSAGE_TIMEOUT_FIRST', String(config.messageTimeoutFirst));
  out += formatEnvLine('CTI_MESSAGE_TIMEOUT_RETRY', String(config.messageTimeoutRetry));
  out += formatEnvLine('CTI_TRAE_MSG_SUFFIX', config.traeMsgSuffix);
  if (config.autoApprove) out += formatEnvLine('CTI_AUTO_APPROVE', 'true');

  fs.mkdirSync(CTI_HOME, { recursive: true });
  const tmpPath = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmpPath, out, { mode: 0o600 });
  fs.renameSync(tmpPath, CONFIG_PATH);
}

export function maskSecret(value: string): string {
  if (value.length <= 4) return '****';
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

export function configToSettings(config: Config): Map<string, string> {
  const m = new Map<string, string>();
  m.set('remote_bridge_enabled', 'true');
  m.set('bridge_feishu_enabled', config.enabledChannels.includes('feishu') ? 'true' : 'false');
  if (config.feishuAppId) m.set('bridge_feishu_app_id', config.feishuAppId);
  if (config.feishuAppSecret) m.set('bridge_feishu_app_secret', config.feishuAppSecret);
  if (config.feishuDomain) m.set('bridge_feishu_domain', config.feishuDomain);
  if (config.feishuAllowedUsers) {
    m.set('bridge_feishu_allowed_users', config.feishuAllowedUsers.join(','));
  }
  if (config.feishuChatId) m.set('bridge_feishu_chat_id', config.feishuChatId);
  if (config.defaultModel) m.set('default_model', config.defaultModel);
  m.set('bridge_default_cwd', config.defaultWorkDir);
  m.set('bridge_model', config.defaultModel || '');
  return m;
}
