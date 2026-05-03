import { JsonFileStore } from './store.js';
import { FeishuAdapter } from './feishu/feishu-adapter.js';
import { WindowLLMProvider } from './providers/window-provider.js';
import { initBridgeContext } from './core/context.js';
import * as bridgeManager from './core/bridge-manager.js';
import { loadConfig, configToSettings } from './config.js';
import { setupLogger, logger } from './logger.js';

async function main(): Promise<void> {
  setupLogger();
  logger.info('TraeCN-to-IM Bridge starting...');

  const config = loadConfig();
  const settingsMap = configToSettings(config);

  const store = new JsonFileStore(settingsMap);
  const llm = new WindowLLMProvider(
    config.messageTimeoutFirst,
    config.traeMsgSuffix,
  );

  const permissions = {
    resolvePendingPermission: (_id: string, _resolution: { behavior: 'allow' | 'deny'; message?: string }) => {
      logger.info('Permission resolved (MVP no-op)');
    },
  };

  const lifecycle = {
    onBridgeStart: () => logger.info('Bridge started'),
    onBridgeStop: () => logger.info('Bridge stopped'),
  };

  initBridgeContext({ store, llm, permissions, lifecycle });

  const feishuAdapter = new FeishuAdapter();

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await bridgeManager.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await bridgeManager.start(feishuAdapter);
    logger.info('Bridge is running. Press Ctrl+C to stop.');
  } catch (err) {
    logger.error('Failed to start bridge:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
