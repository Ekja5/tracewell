# Offline capture

## What works

- When a rep opens **Close case** online, the app downloads a **case package**: the case, its reservations with their ledger locations, the catalog items and package configurations it needs, and any usage already recorded. The package is stored in IndexedDB, keyed by `userId:caseId`. The server issues packages **only to the assigned rep** and **only for that case** (`GET /api/offline/cases/:id/package`, tested).
- The service worker caches the app shell, so the app reloads with no connection. If `/api/auth/me` cannot be reached, a non-secret cached profile (role and name) is used. The session cookie stays HttpOnly.
- Every scan or manual entry is first written to a durable IndexedDB queue with a `clientEventId` (UUID) and its original `occurredAt` (device time corrected by the skew measured at last contact). Events survive app restarts.
- The sync bar shows **Online/Offline**, the count of **pending** and **needs review** events, and the last sync time. Each captured line shows *pending*, *synced* or *needs review* with the server's reason.
- On reconnect, pending events are posted to `/api/offline/sync`. The server runs the same `recordUsage` path as online capture. Effects:
  - Replays are idempotent. Retries never double-post movements, charges or replenishment (tested).
  - Each event is reconciled against **current** server state: a cancelled case, a unit not where the ledger expects, an unknown label or a package without a unit count all become *needs review*. Nothing is guessed.
  - A unit placed under a quality hold while the device was offline is still **recorded as used** (a fact is preserved). A **late-usage review task** and a critical exception are also raised, stating whether use happened before or after the hold (tested).
- The banner separates **"Offline snapshot downloaded at …; NOT confirmed current availability"** from **"Confirmed with server at …"**.
- Signing out deletes cached case packages and already-synced events for that user. **Pending events are kept**, so field data is never lost; they sync when that user signs in again.

## Device and local-storage limitations (resolve before real deployment)

1. **No app-level encryption of IndexedDB.** Anyone with access to an unlocked device profile can read cached packages and queued events. Require managed devices (MDM), a device passcode or biometrics, and OS full-disk encryption. Do not enable patient-linked data offline without a privacy review.
2. **Storage eviction.** Browsers may evict IndexedDB under storage pressure. The app requests persistent storage, but iOS Safari may still evict after about 7 days without use. Sync daily; the pending count is always visible.
3. **iOS limitations.** Safari has no `BarcodeDetector`, so camera scanning there falls back to a hardware scanner, the simulator or manual entry. Background sync is not available, so sync happens when the app is open.
4. **Clock.** `occurredAt` uses device time corrected by the last measured server skew. A device whose clock is changed while offline can misstate times. The server stores both `occurred_at` and `recorded_at` and rejects times more than 5 minutes in the future.
5. **Shared devices.** Queues are partitioned by user, but a shared unlocked device is still a risk. Use per-user OS profiles.
6. **Session expiry.** If the 12-hour session expires while offline, sync waits for sign-in. Pending events remain on the device.
7. **Not verified on physical hardware** in this build: tested in Chromium with desktop and iPhone 13 emulation and real network-offline mode (Playwright `setOffline`). Validate on the customer's actual phones, scanners and MDM configuration.
