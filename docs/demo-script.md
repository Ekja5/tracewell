# Ten-minute pilot demo script

Audience: operations director at a regional orthopedic distributor. Everything shown is synthetic.

**Before the demo:** `npm start -- --reset`. This re-seeds and pins the demo clock to the demo date at 08:00 America/Chicago (the yellow banner shows it). The same story runs automatically as `tests/e2e/demo-story.spec.ts`, so you can rehearse with `npm run test:e2e`.

Use the development-only account buttons on the login page. Sign out between roles, or use separate browser profiles.

| Min | Who | Do this | Point out |
|---|---|---|---|
| 0:00 | Ops manager (Morgan Hale) | Sign in. The home screen is the 72-hour readiness board. | **SYN-1001** (St. Brigid, tomorrow 07:30 CST) is *at risk*. Each blocker is a plain sentence with an owner and an act-by time. The tray must leave the warehouse by about 18:35 because St. Brigid's policy v3 needs trays 12 h early and the seeded travel estimate is 55 min. **SYN-1002** at Prairie Valley shows Eastern time and a stale *simulated* schedule feed. That warning stays visible rather than being hidden. |
| 1:00 | Ops | Open SYN-1001 and click **Find exact item** on NP-INS-4-10. | Only the exact catalog item is searched; substitutes are never suggested. The closest units are excluded, each with a reason: Riley's trunk unit **expired yesterday**; the warehouse unit is **reserved for SYN-1003** on Tuesday; another is on a **quality hold**; the Prairie Valley unit is **hospital-owned**. The eligible unit is in **Jordan's trunk** (95 min, meets the cutoff). Travel and cost figures are labeled as estimates. |
| 2:00 | Ops | **Preview transfer**, then **Reserve and create transfer**. | The preview lists affected cases. The reservation and the transfer shipment are created in one transaction. A second user racing for the same unit gets a clear refusal (tested). |
| 2:30 | Ops | Back on the case, **Plan delivery for reserved items**. | Creates the tray shipment from the warehouse. |
| 3:00 | Warehouse (Sam) | The home screen is the pick queue, ordered by dispatch cutoff. Open the SHP for SYN-1001: **Pick**, **Pack**, **Dispatch**. | Picking verifies the exact serial. Dispatch posts a ledger movement to in-transit. |
| 3:30 | Rep Jordan | Open the XFR shipment, then **Pick** and **Dispatch** from the trunk. | |
| 4:00 | Courier | On both shipments, **Mark delivered (courier)**. Then show ops the board. | SYN-1001 is still not ready: *"A courier scan does not make the case ready."* |
| 4:30 | St. Brigid receiving (Alex) | **Record receipt** on both. On the tray, **Verify tray contents** and set the Femoral sizer to 0. | The result is incomplete against manifest v2. The case turns **Blocked**, and the discrepancy can only close through a complete re-verification. |
| 5:30 | Rep Riley | Open the case. | No release controls appear: only St. Brigid staff may record the hospital's decision. The API refuses too (tested). |
| 6:00 | Ops | On the case, **Send exact replacement from warehouse**. Warehouse picks and dispatches. Receiving records receipt, then re-verifies the tray as complete. | The missing-instrument discrepancy resolves itself with evidence. |
| 7:00 | St. Brigid SPD (Robin) | Enter the hospital processing record reference, then **Record: released for use**. | St. Brigid's policy decides which evidence is required. The statement makes clear the software does not infer sterility. The case is now **Ready**. |
| 7:30 | Rep Riley, **on a phone** | Open **My cases**, then **Close case** on SYN-1001. Tick **Work offline** (or switch on airplane mode). Choose **Implanted** and use the scan simulator (or a scanner, camera or manual entry) for the insert, femoral and tibial labels. Turn the connection back on. | Each event is queued with its original time ("pending"), then syncs ("synced"). The snapshot banner separates downloaded data from confirmed current availability. Show the screw **box-of-5** label: it requires an explicit unit count. Show the **HIBCC** label: it is routed to reviewed manual entry. Then **Submit closeout**. |
| 8:30 | Finance (Avery) | The worklist shows SYN-1001. Open it and **Generate billing packet**. | One **bill-and-replace** packet for **$6,780.00**. Each line shows the rule, contract version (v3), price date and rationale. Download the usage report and the packet. **Send to ERP (simulated)**, then on Integrations **Process outbox now**. The packet reads *ERP received (simulated)*, never "paid". |
| 9:15 | Quality (Quinn, then Val) | Quinn enters a recall on NP-INS-4-10 lot **L26C014**. Val re-enters the scope to verify it, then **Activate**. | Matches: the warehouse unit (reserved for SYN-1003, whose rep is alerted), the Prairie Valley consignment unit, and **completed case SYN-1001**, listed separately with its usage preserved. Allocation and dispatch of the lot are blocked. |

Optional extras if time allows:
- **Import** with the template: a dry run, then a commit, then a repeat commit (all rows `already imported`; ledger unchanged).
- **Counts:** a blind count and its variance review.
- **Scorecard:** each metric's definition and drill-down.
- **Integrations:** inject failures to show retries and the exception queue.
