# Operations command center

Built in response to the first outside review. The reviewer's point: the app explained problems well but did not let
Operations work them. This pass makes the work queue the home page and puts the fix next to each problem.

## What is here

| Screen | What it does |
|---|---|
| **Needs attention** (`/attention`, home for managers and coordinators) | Every open problem in the planning window, ranked Critical / High / Medium, each with *why*, the *safest fix*, an act-by time, who it is waiting on, and the buttons. "Fix before 12 / 3 / 5 PM" filters to what is due by then. |
| **Evidence panel** (on a case) | Required / Physical on hand / Reserved for other cases / Available / Short. Each number opens to the units, cases, timestamps and source spreadsheet rows behind it, and Short lists the ways to cover it. |
| **Transfers** | A transfer is a *request*: owner, who collects, when it leaves, who receives, required-by. The unit is held at once, but nothing moves until the holder accepts (a manager answering for a holder must record how they agreed). Status: Requested → Accepted → Reserved → Pickup confirmed → In transit → Delivered → Received. The giving side's own upcoming cases are checked and stored with the request. |
| **Loaners** | Requests to the account's outside loaner source, with the last cutoff that still arrives in time, then confirmation, inbound tracking, check-in (stock enters the ledger owned by the manufacturer and is reserved for the case), due-back date and return. Append-only chain of custody. |
| **Allocation** | Demand against free stock for every item in the window, served in the account's rule order. One button reserves what is free; existing reservations are never taken away. |
| **Par levels** / **Expiring stock** | Par against usable stock, reservations, case demand in the window and recorded usage; stock expiring inside the warning window with the earliest case that could use it first. |
| **Case tracker** | Each case from entry to close in seven stages (Entered, Items reserved, Shipped, Checked in at hospital, Surgery done, Usage recorded, Closed) with the one thing it is waiting on. |
| **Where everything is** | Every unit by where it is now: warehouse, with reps, at hospitals, in transit, quarantine, being returned; reserved against free; items short for the window listed first. |
| **Run sheet** | What has to leave, grouped by origin, in order of latest safe departure (required-by minus the route's travel estimate). A deadline order, not a distance-optimized route. Printable. |
| **Whose work** (on the queue) | Filter the queue by owner or by who it is waiting on, with a count per person. |
| **Usage and consumption** | From closeout records over 30/60/90 days: units used by item, hospital and rep; waste; days between uses; per-week average; weeks of cover; value at contract price (draft charges); replacements owed and average days from use to replaced. The demo carries nine finished cases over four weeks, recorded through the closeout services. |
| **Enter a case** | Hospital, date, time, procedure, surgeon code, rep and required items. "Check stock" runs the real save and rolls it back, so the answer shown is exact: what the case would be given under the allocation rule (cases ahead of it are served first) and what it would be short. Saving reserves that stock and queues the rest. |
| **Demand plan** | Usable stock minus what each week's scheduled cases require, 2 to 8 weeks out, with the recent weekly average, par and replacements owed beside it. Arithmetic on the schedule, not a statistical forecast. |
| **Urgent / assign** (on the queue) | Mark a case urgent with a reason (raises its items one level, alerts the rep) and assign an issue to a person. |
| **Recall** | An action summary at the top: units affected, physically checked, needing verification, upcoming cases, and a numbered action list. |
| **Move from another system** | What to export from RedSpot or Salesforce, where to load it, and where the move stands. |
| **Settings** | Planning window, allocation rule, loaner source (name, daily cutoff, time zone, transit hours, return days), expiry warning. |

## How "safest fix" is decided

In order: (1) reserve stock that needs no movement; (2) request a transfer that arrives before the required-by time and
does not leave the giving side short; (3) move a warehouse unit held by a case more than 48 hours out, which then shows as
needing resupply; (4) request a loaner while its cutoff is still open; (5) otherwise say plainly that nothing on record
arrives in time. Exact catalog item only. The assistant's `work_queue` tool returns this same list.

Priority: **Critical** when a deadline has passed, or a confirmed shortage is on a case less than 30 hours away. **High**
when the deadline is within 8 hours or the case within 30. Otherwise **Medium**. Missing information is never Critical.

## What is deliberately not built

- **Demand forecasting and courier route optimization.** With synthetic data these would be invented numbers. Par and
  expiry suggestions are arithmetic on recorded quantities and say so on the page.
- **A direct connection to RedSpot or Salesforce.** The move is file-based. Standard Salesforce report headings are
  recognized; no RedSpot export layout was available, so RedSpot files are matched by the user once and remembered.
- **Sending a loaner request to the source.** The app records and tracks it; a person places it.
- The planning window, "first entered, first served" and the loaner source are settings, not one manufacturer's process.

## Tests

`tests/integration/command.test.ts` (20 tests) covers ranking, the before-3 filter, assistant parity, permissions, the
five numbers, transfer request / accept-on-behalf / decline / chain, reallocation, loaner lifecycle, allocation, par
set and import, expiry, the recall summary, settings, and previous-system IDs. `scripts/dev/review-walk.mjs` walks the
reviewer guide in a browser.
