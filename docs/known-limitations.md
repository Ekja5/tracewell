# Known limitations

**Scope and data**
- Pilot scope is one distributor, one product line (synthetic Meridian Knee System), two hospitals, one warehouse and two reps. A second tenant exists only to prove isolation.
- Travel times and courier costs are seeded estimates. There is no routing or traffic service.
- The application clock is pinned by the seed for a deterministic demo date (`DEMO_CLOCK`). For real use, run without demo seeding and set the clock offset to 0.

**Scanning**
- GS1 parsing covers the AIs common on implant labels (00, 01, 02, 10, 11–17, 20, 21, 22, 240, 241, 250, 30, 37, 400, 7003, 8020). Other AIs are rejected and sent to review.
- HIBCC and ISBT 128 are detected but **not parsed**. They go to reviewed manual entry.
- Camera scanning depends on the browser `BarcodeDetector` API, which iOS Safari lacks. No JavaScript decoder library is bundled.
- Keyboard-wedge scanners must transmit GS (ASCII 29) or Ctrl+], or use the `<GS>` / `{GS}` placeholders. Without a separator, a variable-length lot followed by another AI is ambiguous and is flagged.

**Workflow simplifications**
- Ownership transfer (for example consignment → distributor title) is not modeled as a separate event. Owner is fixed per balance.
- Hospital-owned consignment is excluded from rescue (owner approval workflow not built).
- Tray contents are verified by count against the manifest. Individual instrument serials inside trays are not tracked.
- The replacement instrument and its tray are reconciled by re-verification. The loose instrument stays a separate ledger unit at the facility.
- Instrument return after a case is recorded as status only. Return shipments are created by ops.
- Rejected deliveries remain in in-transit custody. The return leg is a manual shipment.
- A "customer acceptance" on a packet is a reference entered by finance. There is no customer portal.
- Contract maintenance UI is not built. Contracts and prices come from the seed, or would be entered directly or imported.
- Preference card editing UI is minimal (approve a draft version). Card authoring is seeded.
- The scorecard's "minutes to locate" depends on audit events from the rescue screen. Searches done outside the app are not measured.

**Platform**
- Login lockout and rate limits are in-memory (single instance).
- No SSO, MFA or Part 11 e-signatures (see `production-readiness.md`).
- Offline storage is not app-encrypted (see `offline.md`).
- No email or SMS delivery: notifications are in-app only.
- Not load-tested. Readiness is computed per case on request, so caching or materialization may be needed beyond a few hundred cases in the window.
