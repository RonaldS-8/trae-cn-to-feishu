import { execFile } from 'node:child_process';
import path from 'node:path';
import type { LLMProvider, StreamChatParams } from '../core/host.js';
import { sseEvent } from '../sse-utils.js';

const SCRIPTS_DIR = path.join(import.meta.dirname, '..', '..', 'scripts');
const TRAE_WINDOW_SCRIPT = path.join(SCRIPTS_DIR, 'trae_window.py');
const TRAE_MONITOR_SCRIPT = path.join(SCRIPTS_DIR, 'trae_monitor.py');

export class WindowLLMProvider implements LLMProvider {
  private timeout: number;
  private msgSuffix: string;

  constructor(timeout: number = 30000, msgSuffix: string = '') {
    this.timeout = timeout;
    this.msgSuffix = msgSuffix;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const { prompt, abortController } = params;
    const fullMessage = prompt + this.msgSuffix;
    const monitorTimeoutMs = Math.max(this.timeout, 60000);

    return new ReadableStream<string>({
      start(controller) {
        const sendAndMonitor = async () => {
          try {
            const sendResult = await execPython(TRAE_WINDOW_SCRIPT, [fullMessage], abortController);
            if (!sendResult.success) {
              controller.enqueue(sseEvent('error', JSON.stringify({ error: sendResult.error || 'Failed to send message to Trae' })));
              controller.enqueue(sseEvent('done', ''));
              controller.close();
              return;
            }

            controller.enqueue(sseEvent('status', JSON.stringify({ status: 'message_sent' })));

            const monitorTimeout = params.abortController.signal.aborted ? 0 : monitorTimeoutMs;
            const monitorTimeoutSeconds = Math.ceil(monitorTimeout / 1000);
            const monitorResult = await execPython(TRAE_MONITOR_SCRIPT, [String(monitorTimeoutSeconds), fullMessage], abortController);

            if (monitorResult.success && monitorResult.response) {
              controller.enqueue(sseEvent('text', monitorResult.response));
              controller.enqueue(sseEvent('result', JSON.stringify({
                text: monitorResult.response,
                tokenUsage: null,
              })));
            } else if (monitorResult.timeout) {
              controller.enqueue(sseEvent('text', monitorResult.response || 'Response is still being generated...'));
              controller.enqueue(sseEvent('result', JSON.stringify({
                text: monitorResult.response || 'Response is still being generated...',
                tokenUsage: null,
              })));
            } else {
              controller.enqueue(sseEvent('error', JSON.stringify({ error: monitorResult.error || 'Failed to monitor Trae response' })));
            }

            controller.enqueue(sseEvent('done', ''));
            controller.close();
          } catch (err) {
            if (abortController.signal.aborted) {
              controller.enqueue(sseEvent('result', JSON.stringify({ text: '', interrupted: true })));
              controller.enqueue(sseEvent('done', ''));
            } else {
              controller.enqueue(sseEvent('error', JSON.stringify({ error: err instanceof Error ? err.message : String(err) })));
              controller.enqueue(sseEvent('done', ''));
            }
            controller.close();
          }
        };

        sendAndMonitor();
      },
    });
  }
}

interface PythonResult {
  success: boolean;
  message?: string;
  error?: string;
  response?: string;
  timeout?: boolean;
}

function execPython(scriptPath: string, args: string[], abortController: AbortController): Promise<PythonResult> {
  return new Promise((resolve, reject) => {
    const pythonCmd = process.env.CTI_PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
    const proc = execFile(
      pythonCmd,
      [scriptPath, ...args],
      { encoding: 'utf-8', timeout: 120000, windowsHide: true },
      (error, stdout, stderr) => {
        if (abortController.signal.aborted) {
          reject(new Error('Aborted'));
          return;
        }
        if (error && !stdout) {
          const detail = stderr.trim().split('\n').pop() || error.message;
          resolve({ success: false, error: detail });
          return;
        }
        try {
          const lastLine = stdout.trim().split('\n').pop() || '';
          const result = JSON.parse(lastLine) as PythonResult;
          resolve(result);
        } catch {
          resolve({ success: false, error: stderr.trim() || stdout.trim() || 'Unknown error' });
        }
      },
    );

    abortController.signal.addEventListener('abort', () => {
      proc.kill();
    }, { once: true });
  });
}
