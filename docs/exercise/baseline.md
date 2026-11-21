[migrate] applied 001_core.sql
# Workflow exercise (2026-11-21T21:33:40.688Z)

Dataset: demo seed, demo date 2026-11-21, isolated DB. All data synthetic.

## 1. 4 p.m.: move tomorrow's first surgery two hours earlier
- Move API: 200; conflicts returned: ["uncovered"]
- Board status before/after: at_risk → at_risk. Next action: "Pick, pack and dispatch" owner "Warehouse" act by 2026-11-21T22:35:00.000Z
- Next action names a person: NO (role label only); owner can be assigned/acknowledged from board: NO
- Planned tray shipment SHP-5007 due_by stored 2026-11-22T01:30:00.000Z vs recomputed tray required-by 2026-11-21T23:30:00.000Z: STALE (pick queue orders by old cutoff)
- Pick queue dispatch-by for that shipment: 2026-11-22T00:35:00.000Z
- People notified of move: Riley Novak, Morgan Hale (warehouse/receiving told: no)
- Board explains facility receiving hours/time-zone deadline: no
- API calls used: 5

## 2. Two reps, one eligible unit, simultaneous reserve
- Riley eligible: SN INS-0002; Jordan eligible: SN INS-0002
- Results: 200 / 409. Loser message: "Only 0 unit(s) available; reserved for case SYN-1001"
- Loser response includes who won / next eligible option: NO
- Active reservations on unit: 1

## 3. Tray missing a required instrument → assignment → resolution → re-verify → release
- Rep sees: status blocked; top blocker: "Tray NP-TRAY-KNEE SN TRY-K-002 failed contents verification: Femoral sizer (NP-INST-SIZER). It stays blocked until a replacement is received and the tray is re-verified complete." owner Ops manager
- Discrepancy has an assignee field: NO; can be acknowledged: NO endpoint
- Rep sees after replacement received, before re-verify: "Tray NP-TRAY-KNEE SN TRY-K-002 failed contents verification: Femoral sizer (NP-INST-SIZER). It stays blocked until a rep"
- Rep attempts hospital release: 403
- After SPD release: status at_risk; remaining blockers: awaiting_dispatch,stale_feed
- API calls used: 21

## 4. Offline implanted + opened-unused, recall from another account, reconnect
- Offline package download: 200
- Sync results: ["synced","synced"]; retry: ["replayed","replayed"]
  - implanted: usage recorded, movements 1, charges 1
  - opened_unused: usage recorded, movements 1, charges 1
- Quality late-usage review tasks: 1; visible on Quality home tasks: yes
- Event the server rejects (rep not assigned): phone told "needs_review: Case not found"; persisted on server for review: NO (usage exists only on the phone)
- Accidental rescan of the same serial: server says "needs_review: Ledger does not show 1 sealed unit(s) at St. Brigid Regional Medical Center (synthetic) or the rep's trunk (it shows 1 used at Implanted / c"

## 5. Missing contract price, packet, partial PO, one correction
- Worklist row: net 443500, holding: ["1 charge(s) cannot be priced (finance exception)"]
- Held line shows owner/age/missing evidence fields: NO
- Price change history table exists: NO (only appended rationale text)
- Partial PO (2 of 3 lines): 200; issues ["NP-FEM-4L: missing from PO"]; packet status disputed
- After credit: net 638500; remaining after PO shown: NOT SHOWN; inventory movements changed by credit: 0
- Corrected implant location after credit: consumed
- API calls used: 8

## 6. Hospital A (St. Brigid) probing Hospital B (Prairie Valley)
- /api/cases/0e6d8945-1f10-4950-b248-834242166d2d: 404 → no Hospital B data
- /api/search?q=SYN-1002: 200 → no Hospital B data
- /api/exports/cases.csv?facility=PVS: 200 → no Hospital B data
- /api/notifications: 200 → no Hospital B data
- /api/integrations: 200 → LEAK: Hospital B data visible
- /api/cards/2fc0928d-ef6c-4f39-ba67-0f73c8d1b627: 200 → LEAK: Hospital B data visible
- /api/exceptions: 200 → no Hospital B data
- /api/meta: 200 → no Hospital B data

Total API calls: 61
