import http from 'node:http';
import type { BridgeStore } from './core/host.js';
import { getBridgeContext } from './core/context.js';
import * as bridgeManager from './core/bridge-manager.js';
import { logger } from './logger.js';

const API_TOKEN_HEADER = 'x-bridge-Token';

interface PendingResponse {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingResponses = new Map<string, PendingResponse>();

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function jsonResponse(res: http.ServerResponse, data: unknown, statusCode: number = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function authenticate(req: http.IncomingMessage, store: BridgeStore): boolean {
  const expectedToken = store.getSetting('bridge_api_token');
  if (!expectedToken) return true;
  const provided = req.headers[API_TOKEN_HEADER.toLowerCase()] as string | undefined;
  return provided === expectedToken;
}

export function registerResponse(sessionId: string, text: string): void {
  const pending = pendingResponses.get(sessionId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingResponses.delete(sessionId);
    pending.resolve(text);
  }
}

export function waitForResponse(sessionId: string, timeoutMs: number = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResponses.delete(sessionId);
      reject(new Error('Response timeout'));
    }, timeoutMs);

    pendingResponses.set(sessionId, { resolve, reject, timer });
  });
}

export function createApiServer(port: number = 3100): http.Server {
  const server = http.createServer(async (req, res) => {
    const { store } = getBridgeContext();

    if (!authenticate(req, store)) {
      jsonResponse(res, { error: 'Unauthorized' }, 401);
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = url.pathname;

    try {
      switch (true) {
        case req.method === 'GET' && pathname === '/health':
          jsonResponse(res, { status: 'ok', ...bridgeManager.getStatus() });
          break;

        case req.method === 'GET' && pathname === '/api/config':
          jsonResponse(res, { status: 'ok' });
          break;

        case req.method === 'POST' && pathname === '/api/send-to-trae': {
          const body = await readBody(req);
          const { message, model, workingDirectory } = JSON.parse(body);
          if (!message) {
            jsonResponse(res, { success: false, error: 'message is required' }, 400);
            return;
          }
          logger.info(`[api] Received send-to-trae request: ${message.slice(0, 80)}...`);
          jsonResponse(res, { success: true, message: 'Message forwarded to bridge' });
          break;
        }

        case req.method === 'POST' && pathname === '/api/ai-response': {
          const body = await readBody(req);
          const { session_id, content, user_message_id } = JSON.parse(body);
          if (!content) {
            jsonResponse(res, { success: false, error: 'content is required' }, 400);
            return;
          }
          logger.info(`[api] Received AI response for session ${session_id}: ${String(content).slice(0, 80)}...`);

          if (session_id) {
            registerResponse(session_id, content);
          }

          jsonResponse(res, { success: true });
          break;
        }

        case req.method === 'GET' && pathname.startsWith('/api/response/'): {
          const sessionId = pathname.slice('/api/response/'.length);
          try {
            const text = await waitForResponse(sessionId, 120_000);
            jsonResponse(res, { success: true, content: text });
          } catch {
            jsonResponse(res, { success: false, error: 'No response yet' }, 408);
          }
          break;
        }

        case req.method === 'GET' && pathname === '/api/status':
          jsonResponse(res, bridgeManager.getStatus());
          break;

        default:
          jsonResponse(res, { error: 'Not found' }, 404);
      }
    } catch (err) {
      logger.error('[api] Request error:', err instanceof Error ? err.message : err);
      jsonResponse(res, { error: 'Internal server error' }, 500);
    }
  });

  return server;
}
