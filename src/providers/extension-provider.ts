import http from 'node:http';
import type { LLMProvider, StreamChatParams } from '../core/host.js';
import { sseEvent } from '../sse-utils.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const REQUEST_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 150;

interface TraeApiResponse {
  success: boolean;
  error?: string;
  message?: string;
  content?: string;
  response?: string;
  [key: string]: unknown;
}

function httpPost(host: string, port: number, path: string, body: unknown, timeout: number): Promise<TraeApiResponse> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: host, port, path, method: 'POST', timeout,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let buf = '';
        res.on('data', (chunk: Buffer) => { buf += chunk.toString(); });
        res.on('end', () => {
          try { resolve(JSON.parse(buf) as TraeApiResponse); }
          catch { resolve({ success: false, error: `Parse error: ${buf.slice(0, 200)}` }); }
        });
      },
    );
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(data);
    req.end();
  });
}

function httpGet(host: string, port: number, path: string, timeout: number): Promise<TraeApiResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: host, port, path, method: 'GET', timeout },
      (res) => {
        let buf = '';
        res.on('data', (chunk: Buffer) => { buf += chunk.toString(); });
        res.on('end', () => {
          try { resolve(JSON.parse(buf) as TraeApiResponse); }
          catch { resolve({ success: false, error: `Parse error: ${buf.slice(0, 200)}` }); }
        });
      },
    );
    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

export class ExtensionLLMProvider implements LLMProvider {
  private host: string;
  private port: number;
  private msgSuffix: string;

  constructor(host: string = DEFAULT_HOST, port: number = DEFAULT_PORT, msgSuffix: string = '') {
    this.host = host;
    this.port = port;
    this.msgSuffix = msgSuffix;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const { prompt, abortController } = params;
    const fullMessage = prompt + this.msgSuffix;
    const host = this.host;
    const port = this.port;

    return new ReadableStream<string>({
      start(controller) {
        const run = async () => {
          try {
            controller.enqueue(sseEvent('status', JSON.stringify({ status: 'sending_to_trae' })));

            const sendResult = await httpPost(
              host,
              port,
              '/api/send-to-trae',
              { message: fullMessage, model: params.model, workingDirectory: params.workingDirectory },
              REQUEST_TIMEOUT_MS,
            );

            if (!sendResult.success) {
              controller.enqueue(sseEvent('error', JSON.stringify({ error: sendResult.error || 'Failed to send message to Trae' })));
              controller.enqueue(sseEvent('done', ''));
              controller.close();
              return;
            }

            controller.enqueue(sseEvent('status', JSON.stringify({ status: 'waiting_response' })));

            const responseText = await pollForResponse(
              params.sessionId,
              host,
              port,
              abortController,
            );

            if (responseText) {
              controller.enqueue(sseEvent('text', responseText));
              controller.enqueue(sseEvent('result', JSON.stringify({ text: responseText, tokenUsage: null })));
            } else {
              controller.enqueue(sseEvent('error', JSON.stringify({ error: 'No response received from Trae' })));
            }

            controller.enqueue(sseEvent('done', ''));
            controller.close();
          } catch (err) {
            if (abortController.signal.aborted) {
              controller.enqueue(sseEvent('result', JSON.stringify({ text: '', interrupted: true })));
            } else {
              controller.enqueue(sseEvent('error', JSON.stringify({ error: err instanceof Error ? err.message : String(err) })));
            }
            controller.enqueue(sseEvent('done', ''));
            controller.close();
          }
        };

        run();
      },
    });
  }
}

async function pollForResponse(
  sessionId: string,
  host: string,
  port: number,
  abortController: AbortController,
): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    if (abortController.signal.aborted) return null;

    try {
      const result = await httpGet(host, port, `/api/response/${sessionId}`, 10000);
      if (result.success && result.content) {
        return result.content;
      }
    } catch {
      // continue polling
    }

    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, POLL_INTERVAL_MS);
      abortController.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  return null;
}
