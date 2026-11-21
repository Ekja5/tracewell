# Pilot scorecard

Values on the in-app **Scorecard** page are computed live from persisted records, with definitions and drill-down to source records. **All current values are synthetic** (seeded demo data). They are not customer results, and no savings are claimed or implied. Customer value can only be stated after a baseline is collected (below) and compared with pilot-period data from the same sites.

| Metric | Definition (numerator / denominator, range) | Source records | How to collect the baseline (pre-pilot, 4–6 weeks) |
|---|---|---|---|
| Cases ready by facility cutoff | Non-cancelled cases where every mandatory reserved unit was received at the facility before its policy cutoff, trays were verified complete before surgery, and (if required) hospital release was recorded before surgery / all non-cancelled cases scheduled in the range | ledger receive movements, tray verifications, release decisions, facility policy versions | For each case, ask SPD/receiving for the time each tray and implant arrived and was checked. Compare with the hospital's stated cutoff. Record "met / missed / unknown". |
| Emergency transfers per 100 cases | Rescue-transfer shipments created in the range / non-cancelled cases scheduled in the range × 100 | `shipments.kind = rescue_transfer` | Count same-day or overnight transfers from texts, courier invoices and rep mileage logs. Divide by cases from the scheduling log. |
| Minutes to locate a verified item | Median minutes from the first rescue search for a case (per user, 2-hour session) to reserving an eligible unit | audit log `rescue.search` → `rescue.reserve_transfer` | Shadow ops/reps for 10 "find a unit" events: time from the request until someone confirms a physically checked unit is committed. |
| Rep closeout time | Median minutes from the first usage line received to closeout submission | `usage_events`, audit `closeout.submit` | Time how long reps take from end of case to sending the usage sheet or photo to the office. |
| Days from surgery to accepted billing packet | Median days from scheduled start to the packet marked accepted (matching PO plus customer acceptance reference) | `billing_packets.accepted_at` | From the ERP or AR aging: surgery date vs date the PO matched and was accepted. Sample at least 30 cases. |
| Inventory count accuracy | Count lines whose counted quantity equals the ledger at submission / all lines (including implicit zero lines) | `count_lines` | Run one blind count per location against the current system or spreadsheet before go-live, using the same formula. |
| Recall acknowledgment time | Median hours from recall activation to owner acknowledgment for location and open-case tasks; acknowledged / total shown | `recall_tasks` | From the last 2–3 recalls: time from manufacturer notice receipt to each location's written confirmation (email or text). |

Baseline collection instructions:

1. Pick the same two hospitals and the same product line as the pilot.
2. Use the interview guide (`interview-guide.md`) to reconstruct the last five exception cases per role.
3. Record each data point with its source (text, email, spreadsheet, ERP report) so it can be audited.
4. Freeze the baseline before pilot go-live. Do not backfill it from pilot data.
5. Report pilot values next to the baseline, with sample sizes and date ranges. Show "insufficient data" rather than a number when n < 10.
