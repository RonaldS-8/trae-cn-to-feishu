import { JsonFileStore } from './store.js';
import { FeishuAdapter } from './feishu/feishu-adapter.js';
import { AutoLLMProvider } from './providers/auto-provider.js';
import { WindowLLMProvider } from './providers/window-provider.js';
import type { LLMProvider } from './core/host.js';
import { initBridgeContext } from './core/context.js';
import * as bridgeManager from './core/bridge-manager.js';
import { createApiServer } from './api-server.js';
import { loadConfig, configToSettings } from './config.js';
import { setupLogger, logger } from './logger.js';

const API_PORT = 3100;

async function main(): Promise<void> {
  setupLogger();
  logger.info('TraeCN-to-IM Bridge starting...');

  const config = loadConfig();
  const settingsMap = configToSettings(config);

  const store = new JsonFileStore(settingsMap);

  let llm: LLMProvider;
  if (config.runtime === 'window') {
    logger.info('Using WindowLLMProvider (window automation mode)');
    llm = new WindowLLMProvider(config.messageTimeoutFirst, config.traeMsgSuffix);
  } else {
    const extensionHost = settingsMap.get('bridge_extension_host') || '127.0.0.1';
    const extensionPort = parseInt(settingsMap.get('bridge_extension_port') || '3000', 10);
    llm = new AutoLLMProvider(
      extensionHost,
      extensionPort,
      config.traeMsgSuffix,
      config.messageTimeoutFirst,
    );
  }

  const permissions = {
    resolvePendingPermission: (_id: string, _resolution: { behavior: 'allow' | 'deny'; message?: string }) => {
      logger.info('Permission resolved');
    },
  };

  const lifecycle = {
    onBridgeStart: () => logger.info('Bridge started'),
    onBridgeStop: () => logger.info('Bridge stopped'),
  };

  initBridgeContext({ store, llm, permissions, lifecycle });

  const apiServer = createApiServer(API_PORT);
  apiServer.listen(API_PORT, () => {
    logger.info(`API server listening on http://127.0.0.1:${API_PORT}`);
  });

  const feishuAdapter = new FeishuAdapter();

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    apiServer.close();
    await bridgeManager.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await bridgeManager.start(feishuAdapter);
    const providerName = 'getActiveProvider' in llm ? (llm as any).getActiveProvider() : 'window';
    logger.info(`Bridge is running (provider: ${providerName}). Press Ctrl+C to stop.`);
  } catch (err) {
    logger.error('Failed to start bridge:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
