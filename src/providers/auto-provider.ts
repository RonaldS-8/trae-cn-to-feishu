import type { LLMProvider, StreamChatParams } from '../core/host.js';
import { sseEvent } from '../sse-utils.js';
import { ExtensionLLMProvider } from './extension-provider.js';
import { WindowLLMProvider } from './window-provider.js';
import { logger } from '../logger.js';

type ProviderType = 'extension' | 'window';

export class AutoLLMProvider implements LLMProvider {
  private extensionProvider: ExtensionLLMProvider;
  private windowProvider: WindowLLMProvider;
  private activeProvider: ProviderType;
  private failCount = 0;
  private lastFailTime = 0;
  private readonly FAIL_THRESHOLD = 3;
  private readonly COOLDOWN_MS = 5 * 60 * 1000;

  constructor(extensionHost: string, extensionPort: number, msgSuffix: string, windowTimeout: number) {
    this.extensionProvider = new ExtensionLLMProvider(extensionHost, extensionPort, msgSuffix);
    this.windowProvider = new WindowLLMProvider(windowTimeout, msgSuffix);
    this.activeProvider = 'extension';
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    this.maybeResetFailCount();

    if (this.activeProvider === 'extension' && this.failCount >= this.FAIL_THRESHOLD) {
      logger.warn('[auto-provider] Extension failed too many times, falling back to window automation');
      this.activeProvider = 'window';
    }

    if (this.activeProvider === 'extension') {
      return this.streamChatWithFallback(params);
    }

    return this.windowProvider.streamChat(params);
  }

  private streamChatWithFallback(params: StreamChatParams): ReadableStream<string> {
    const extensionStream = this.extensionProvider.streamChat(params);
    const self = this;
    const windowProvider = this.windowProvider;

    return new ReadableStream<string>({
      start(controller) {
        const reader = extensionStream.getReader();
        let hasError = false;

        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              if (value.includes('event: error')) {
                hasError = true;
              }

              controller.enqueue(value);
            }

            if (hasError) {
              self.failCount++;
              self.lastFailTime = Date.now();
              logger.warn(`[auto-provider] Extension error (fail count: ${self.failCount})`);
            }

            controller.close();
          } catch (err) {
            self.failCount++;
            self.lastFailTime = Date.now();

            logger.warn('[auto-provider] Extension stream failed, falling back to window automation');

            try { reader.releaseLock(); } catch { /* ignore */ }

            const fallbackStream = windowProvider.streamChat(params);
            const fallbackReader = fallbackStream.getReader();

            try {
              while (true) {
                const { done, value } = await fallbackReader.read();
                if (done) break;
                controller.enqueue(value);
              }
            } catch (fallbackErr) {
              controller.enqueue(sseEvent('error', JSON.stringify({
                error: `Both providers failed. Extension: ${err instanceof Error ? err.message : String(err)}, Window: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
              })));
            }

            controller.close();
          }
        };

        pump();
      },
    });
  }

  private maybeResetFailCount(): void {
    if (this.failCount >= this.FAIL_THRESHOLD && Date.now() - this.lastFailTime > this.COOLDOWN_MS) {
      logger.info('[auto-provider] Cooldown elapsed, retrying extension provider');
      this.failCount = 0;
      this.activeProvider = 'extension';
    }
  }

  getActiveProvider(): ProviderType {
    return this.activeProvider;
  }
}
