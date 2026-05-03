import fs from 'node:fs';
import path from 'node:path';
import { CTI_HOME } from './config.js';

const LOGS_DIR = path.join(CTI_HOME, 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'bridge.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024;
const MAX_LOG_FILES = 5;

const SECRET_PATTERNS = [
  /CTI_FEISHU_APP_SECRET=\S+/gi,
  /bridge_feishu_app_secret['":\s]+\S+/gi,
  /app_secret['":\s]+\S+/gi,
  /tenant_access_token['":\s]+\S+/gi,
  /Bearer\s+\S+/gi,
];

function maskSecrets(text: string): string {
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match) => {
      const eqIdx = match.indexOf('=');
      if (eqIdx >= 0) return match.slice(0, eqIdx + 1) + '****';
      const colonIdx = match.indexOf(':');
      if (colonIdx >= 0) return match.slice(0, colonIdx + 1) + '****';
      return '****';
    });
  }
  return text;
}

function rotateLog(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_LOG_SIZE) return;

    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const oldPath = `${LOG_FILE}.${i}`;
      const newPath = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch { /* ignore */ }
}

export function setupLogger(): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function writeLog(level: string, ...args: unknown[]): void {
  const timestamp = new Date().toISOString();
  const message = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  const line = maskSecrets(`[${timestamp}] [${level}] ${message}\n`);

  try {
    rotateLog();
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch { /* ignore */ }

  if (level === 'error') console.error(line.trim());
  else if (level === 'warn') console.warn(line.trim());
}

export const logger = {
  info: (...args: unknown[]) => writeLog('info', ...args),
  warn: (...args: unknown[]) => writeLog('warn', ...args),
  error: (...args: unknown[]) => writeLog('error', ...args),
  debug: (...args: unknown[]) => writeLog('debug', ...args),
};
