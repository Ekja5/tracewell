# Known limitations (ordered by impact on a first customer pilot)

1. **Not proven on real devices or scanners.** All phone and offline tests ran in Chromium with iPhone emulation and browser-emulated offline mode. Real keyboard-wedge scanners differ in how they send the GS1 separator. Camera scanning relies on `BarcodeDetector`, which is unavailable in iOS Safari; no JS decoder is bundled. iOS may evict offline storage. Pilot with the customer's actual phones, scanners and MDM settings before go-live.
2. **No live integrations.** ERP, hospital schedule and procurement links are simulated. Case times are not reconfirmed automatically (stale-feed warnings stay visible), and payment status never flows back.
3. **Identity.** Local accounts only: no SSO, MFA or SCIM. Login lockout and rate limits are in-memory, for a single instance.
4. **Issue owners default to the first active user in a role** (first ops manager, first warehouse user, first receiving user at the facility). There is no on-call roster or shift schedule yet, so ops should reassign on the board. Escalation goes to all ops managers once per missed deadline; there is no second escalation tier.
5. **Board first load is slow on very large windows.** About 6.6 s for 600 cases on first sight, because issues are created once (the worker normally does this ahead of time). Steady state is about 0.85 s. Not tested under concurrent HTTP load.
6. **Finance:**
   - PO coverage is matched by catalog item and quantity, not by PO line number.
   - One open draft packet per case and type; supplemental packets after sending.
   - Price "approval" is the resolving finance user; there is no second-approver threshold.
   - There is no customer portal for acceptance.
7. **Usage corrections:** a rep can void a confirmed line only before its packet is sent; afterwards Finance issues a credit, and ops must correct stock with a count or adjustment. A voided line restores the case reservation only while the case is still scheduled.
8. **Receiving hours are one daily window per facility.** There are no weekend or holiday calendars.
9. **Workflow gaps carried from the first build:**
   - owner-approval transfers of hospital-owned consignment;
   - instrument-level serials inside trays;
   - contract and preference-card authoring UIs;
   - HIBCC parsing (detected and routed to review only).
10. **Offline storage is not app-encrypted** (see `offline.md`).
