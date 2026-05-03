import type { BridgeStore, LLMProvider, PermissionGateway, LifecycleHooks } from './host.js';

export interface BridgeContext {
  store: BridgeStore;
  llm: LLMProvider;
  permissions: PermissionGateway;
  lifecycle: LifecycleHooks;
}

const CONTEXT_KEY = '__traecn_feishu_bridge_context__';

export function initBridgeContext(ctx: BridgeContext): void {
  (globalThis as Record<string, unknown>)[CONTEXT_KEY] = ctx;
}

export function getBridgeContext(): BridgeContext {
  const ctx = (globalThis as Record<string, unknown>)[CONTEXT_KEY] as BridgeContext | undefined;
  if (!ctx) {
    throw new Error(
      '[bridge] Context not initialized. Call initBridgeContext() before using bridge modules.',
    );
  }
  return ctx;
}

export function hasBridgeContext(): boolean {
  return !!(globalThis as Record<string, unknown>)[CONTEXT_KEY];
}
