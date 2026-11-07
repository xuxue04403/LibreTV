/**
 * 订阅自动刷新。
 *
 * 只做「到期才跑」的后台静默同步：单次最多 5 个、并发 2，
 * 页面不可见或离线时跳过；失败累计到阈值后订阅自己暂停，不反复打扰用户。
 */

import { isSubscriptionDue, parseSubscription, type SubscriptionEntry } from '@libretv/core';
import { http } from './bridge';
import { useAppStore } from './store';

const MAX_PER_RUN = 5;
const CONCURRENCY = 2;
const FETCH_TIMEOUT_MS = 20_000;

export interface SubscriptionSyncResult {
  synced: number;
  failed: number;
  skipped: boolean;
}

function canRunNow(): boolean {
  if (typeof document !== 'undefined' && document.hidden) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  return true;
}

async function syncOne(entry: SubscriptionEntry): Promise<boolean> {
  const store = useAppStore.getState();
  try {
    const res = await http.request(entry.url, { timeoutMs: FETCH_TIMEOUT_MS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseSubscription(res.text, entry.url);
    store.importSources(parsed.sources, parsed.liveSources);
    store.recordSubscriptionSync(entry.key, true);
    if (parsed.name && parsed.name !== entry.name) {
      store.updateSubscription(entry.key, { name: parsed.name });
    }
    return true;
  } catch {
    store.recordSubscriptionSync(entry.key, false);
    return false;
  }
}

/** 手动同步单个订阅（设置页的「立即同步」） */
export async function syncSubscription(key: string): Promise<boolean> {
  const entry = useAppStore.getState().subscriptions.find((x) => x.key === key);
  if (!entry) return false;
  return syncOne(entry);
}

/** 跑一轮到期订阅；返回本轮结果，调用方可据此提示 */
export async function syncDueSubscriptions(now = Date.now()): Promise<SubscriptionSyncResult> {
  if (!canRunNow()) return { synced: 0, failed: 0, skipped: true };
  const due = useAppStore
    .getState()
    .subscriptions.filter((entry) => isSubscriptionDue(entry, now))
    .slice(0, MAX_PER_RUN);
  if (due.length === 0) return { synced: 0, failed: 0, skipped: false };

  let cursor = 0;
  let synced = 0;
  let failed = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, due.length) }, async () => {
    while (cursor < due.length) {
      const entry = due[cursor];
      cursor += 1;
      if (await syncOne(entry)) synced += 1;
      else failed += 1;
    }
  });
  await Promise.all(workers);
  return { synced, failed, skipped: false };
}
