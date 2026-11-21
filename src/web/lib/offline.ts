/**
 * Durable offline queue (IndexedDB). Events keep their original capture time and a client event id
 * so server-side replay is idempotent. Packages and events are bound to the signed-in user and a
 * single assigned case; other users on the same device never see them.
 *
 * Limitations (documented in docs/offline.md): IndexedDB is not encrypted by this app; the browser
 * may evict storage under pressure (we request persistent storage); a stolen unlocked device
 * exposes the cached case package until it is cleared at sign-out.
 */
import { post } from './api';

export type QueueState = 'pending' | 'synced' | 'needs_review';
export interface QueuedEvent { clientEventId: string; userId: string; caseId: string; payload: any; state: QueueState; reason?: string | null; createdAt: string; syncedAt?: string }

const DB = 'tracewell-offline';
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('packages', { keyPath: 'key' });
      const q = db.createObjectStore('queue', { keyPath: 'clientEventId' });
      q.createIndex('byUser', 'userId');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve((req as IDBRequest | undefined)?.result as T);
    t.onerror = () => reject(t.error);
  });
}

export async function requestPersistence() { try { await (navigator.storage as any)?.persist?.(); } catch { /* best effort */ } }

export async function savePackage(userId: string, caseId: string, pkg: any) {
  await tx('packages', 'readwrite', (s) => s.put({ key: `${userId}:${caseId}`, userId, caseId, pkg }));
}
export async function loadPackage(userId: string, caseId: string): Promise<any | null> {
  const r = await tx<any>('packages', 'readonly', (s) => s.get(`${userId}:${caseId}`));
  return r?.pkg ?? null;
}
export async function enqueue(e: Omit<QueuedEvent, 'state' | 'createdAt'>) {
  await tx('queue', 'readwrite', (s) => s.put({ ...e, state: 'pending', createdAt: new Date().toISOString() }));
}
export async function listQueue(userId: string, caseId?: string): Promise<QueuedEvent[]> {
  const all = await tx<QueuedEvent[]>('queue', 'readonly', (s) => s.index('byUser').getAll(userId));
  return (all ?? []).filter((e) => !caseId || e.caseId === caseId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
async function update(e: QueuedEvent) { await tx('queue', 'readwrite', (s) => s.put(e)); }

let syncing = false;
/** Send pending events. Safe to call repeatedly: the server deduplicates by clientEventId. */
export async function syncQueue(userId: string): Promise<{ sent: number; results: any[] }> {
  if (syncing) return { sent: 0, results: [] };
  syncing = true;
  try {
    const pending = (await listQueue(userId)).filter((e) => e.state === 'pending');
    if (!pending.length) return { sent: 0, results: [] };
    const res = await post<{ results: any[] }>('/api/offline/sync', { events: pending.map((e) => e.payload) });
    for (const r of res.results) {
      const e = pending.find((p) => p.clientEventId === r.clientEventId);
      if (!e) continue;
      e.state = r.state; e.reason = r.reason ?? null; e.syncedAt = new Date().toISOString();
      await update(e);
    }
    return { sent: pending.length, results: res.results };
  } finally { syncing = false; }
}

/** Sign-out clears cached case packages and already-synced events for this user. Pending events are kept so field data is never lost. */
export async function clearForUser(userId: string) {
  const db = await open();
  await new Promise<void>((resolve) => {
    const t = db.transaction(['packages', 'queue'], 'readwrite');
    const ps = t.objectStore('packages');
    ps.openCursor().onsuccess = (ev: any) => { const c = ev.target.result; if (c) { if (c.value.userId === userId) c.delete(); c.continue(); } };
    const qs = t.objectStore('queue').index('byUser');
    qs.openCursor(IDBKeyRange.only(userId)).onsuccess = (ev: any) => { const c = ev.target.result; if (c) { if (c.value.state !== 'pending') c.delete(); c.continue(); } };
    t.oncomplete = () => resolve();
  });
}

let forcedOffline = false;
export const setForcedOffline = (v: boolean) => { forcedOffline = v; window.dispatchEvent(new Event('tw-connectivity')); };
export const isOnline = () => navigator.onLine && !forcedOffline;
export const isForcedOffline = () => forcedOffline;
