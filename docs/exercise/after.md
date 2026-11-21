[migrate] applied 001_core.sql
[migrate] applied 002_ownership_finance_alerts.sql
[migrate] applied 003_indexes.sql
# Workflow exercise (2026-11-21T22:01:23.616Z)

Dataset: demo seed, demo date 2026-11-21, isolated DB. All data synthetic.

## 1. 4 p.m.: move tomorrow's first surgery two hours earlier
- Move API: 200; conflicts returned: ["uncovered"]
- Board status before/after: at_risk → at_risk. Next action: "Pick, pack and dispatch" owner "Sam Okafor" act by 2026-11-21T22:35:00.000Z
- Next action names a person: yes; owner can be assigned/acknowledged from board: yes
- Board explanation: "NP-TRAY-KNEE SN TRY-K-002 is at Central warehouse, main stock on SHP-5007 (planned). Estimated travel 55 min, so it must leave by Sat, Nov 21, 4:35 PM CST. Must be at St. Brigid Regional Medical Center (synthetic) receiving by Sat, Nov 21, 5:30 PM CST. Sam Okafor owns the follow-up."
- People who own an open item on this case after the move: Pat Rivera, Riley Novak, Sam Okafor
- Issue deadline changes recorded by the move: 2
- Planned tray shipment SHP-5007 due_by stored 2026-11-21T23:30:00.000Z vs recomputed tray required-by 2026-11-21T23:30:00.000Z: consistent
- Pick queue dispatch-by for that shipment: 2026-11-21T22:35:00.000Z
- People notified of move: Riley Novak, Riley Novak, Sam Okafor, Morgan Hale (warehouse/receiving told: yes)
- Board explains facility receiving hours/time-zone deadline: yes
- API calls used: 5

## 2. Two reps, one eligible unit, simultaneous reserve
- Riley eligible: SN INS-0002; Jordan eligible: SN INS-0002
- Results: 200 / 409. Loser message: "That unit is no longer available. Riley Novak reserved it for SYN-1001 (Sun, Nov 22, 5:30 AM CST) at Sat, Nov 21, 4:05 PM CST. No other eligible unit of this exact item exists; escalate to ops."
- Loser response includes who won / next eligible option: {"heldBy":{"case_ref":"SYN-1001","scheduled_start":"2026-11-22T11:30:00.000Z","timezone":"America/Chicago","by_name":"Riley Novak","created_at":"2026-11-21T22:05:00.073Z"},"nextEligible":[]}
- Active reservations on unit: 1

## 3. Tray missing a required instrument → assignment → resolution → re-verify → release
- Rep sees: status blocked; top blocker: "Tray TRY-K-002 is missing 1 required instrument: Femoral sizer (NP-INST-SIZER). It stays blocked until a replacement is received and the tray is re-verified complete." owner Morgan Hale
- Discrepancy has a named owner: yes (Morgan Hale); can be acknowledged: ack → 200
- After acknowledgment the issue is "acknowledged" (not resolved) and the case is still blocked
- Rep sees after replacement received, before re-verify: "Tray TRY-K-002 is missing 1 required instrument: Femoral sizer (NP-INST-SIZER). It stays blocked until a replacement is "
- Rep attempts hospital release: 403
- After SPD release: status at_risk; remaining blockers: awaiting_dispatch,stale_feed
- API calls used: 22

## 4. Offline implanted + opened-unused, recall from another account, reconnect
- Offline package download: 200
- Sync results: ["synced","synced"]; retry: ["replayed","replayed"]
  - implanted: usage recorded, movements 1, charges 1
  - opened_unused: usage recorded, movements 1, charges 1
- Quality late-usage review tasks: 1; visible on Quality home tasks: yes
- Event the server rejects (rep not assigned): phone told "needs_review: Case not found. Held on the server for ops review; not lost."; persisted on server for review: yes
- Accidental rescan of the same serial: server says "rejected: Duplicate scan: SN FEM4L-0101 was already recorded as implanted on SYN-1001 at 2026-11-21T22:10:00.000Z. A serialized unit is used once, so "

## 5. Missing contract price, packet, partial PO, one correction
- Worklist row: net 443500, holding: ["1 line(s) cannot be priced"]
- Held line shows owner/age/missing evidence fields: yes (owner Avery Brooks, age 6 d, missing: A contract price for NP-TIB-4 in Prairie Valley Purchase Agreement (synthetic) v1)
- Price change history table exists: yes
- Partial PO (2 of 3 lines): 200; issues []; packet status po_partial
- After credit: net 638500; remaining after PO shown: 321000; inventory movements changed by credit: 0
- Lifecycle shown: usageRecorded=yes, packetPrepared=yes, packetSent=yes, poReceived=yes, disputed=no, credited=yes, accepted=no
- Corrected implant location after credit: consumed
- API calls used: 9

## 6. Hospital A (St. Brigid) probing Hospital B (Prairie Valley)
- /api/cases/eb4be802-1333-47ca-97e1-cc23ecddff5d: 404 → no Hospital B data
- /api/search?q=SYN-1002: 200 → no Hospital B data
- /api/exports/cases.csv?facility=PVS: 200 → no Hospital B data
- /api/notifications: 200 → no Hospital B data
- /api/integrations: 403 → no Hospital B data
- /api/cards/2c38cb3b-ca5f-4713-a9e5-d47fe3b88afa: 403 → no Hospital B data
- /api/exceptions: 200 → no Hospital B data
- /api/meta: 200 → no Hospital B data

Total API calls: 63
