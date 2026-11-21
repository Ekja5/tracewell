# Distributor pilot (fourth pass)

A coordinator loads the spreadsheets they already use; the operations manager sees which of tomorrow's cases need
attention; every answer, on the board or from the assistant, links to the row or event behind it. All data is synthetic.

- [Ten-minute demo script](demo-script.md)
- [What to ask a prospect to bring](data-request.md)
- Sample files: `samples/` (regenerate with `npm run pilot:samples`; also downloadable in the app under Load files)
- Browser run timings: `e2e-timings.json`

## Commands

| Command | What it does |
|---|---|
| `npm run pilot:reset` | Reset the database to one **empty** pilot tenant (people, two hospitals, warehouse, receiving rules; no items, stock or cases) |
| `npm run pilot:demo` | Same, then performs the day-before work for the ten-minute demo through the same services as the screens |
| `npm run pilot:samples` | Write today's sample files to `docs/pilot/samples/` |
| `npx vitest run tests/integration/pilot.test.ts` | 37 pilot tests through the HTTP API |
| `npx playwright test tests/e2e/zzz-pilot.spec.ts --trace off` | The whole exercise from an empty tenant through the screens |

## How uploads behave

| Situation | Result |
|---|---|
| First balance file for a location | **Opening balance**: stock is created from the rows |
| Any later file | **Snapshot**: an observation. Equal to the system: accepted. Different: held, a discrepancy opens, stock unchanged |
| Difference explained by recorded movements | Accepted, with "recorded movements explain the change" |
| Row missing from a *partial* export | Nothing happens |
| Row missing from a *complete* export | A "not listed" discrepancy for a person to decide. Never set to zero |
| Same file again (same cell contents, even if re-saved or renamed) | The original result is returned; nothing is imported |
| File exported before newer evidence (later file, physical count, recorded movement) | Skipped as stale, kept as history |
| Reconciliation | Coordinator or operations manager: accept the file's quantity (one linked ledger adjustment) or keep the system's (no movement). Cause and note required. Decisions are append-only |
| Box/pack quantity | Held until a person verifies units per package for that item; then re-checked |
| Catalog number without its leading zeros | Held with the catalog's number shown; no new item is created |
| Catalog number shared by two manufacturers, row has no manufacturer | Held; the row names both manufacturers |
| Ambiguous facility or location name | Held with choices; the choice is remembered |
| Duplicate rows | Identical: counted once. Conflicting: both held |

Preview runs the real load inside a database savepoint and rolls it back, so the preview is exactly what loading will do.

## Board and assistant

`src/server/pilot/tomorrow.ts` adds a type (confirmed shortage / missing information / waiting on hospital / action
needed), evidence, last-verified time and who can resolve to each blocker from the readiness engine. `/api/tomorrow`
and the assistant tools (`call_list`, `shortage_explanation`, `upload_changes`, `awaiting_receipt`) all call it, and
the shortage arithmetic is the single function `computeShortage`. Hospital users get only their facility's cases and
no spreadsheet or reconciliation links.

## What required developer or administrator action

- Creating the account: tenant, users, hospitals, time zones, receiving hours, delivery lead times, locations and
  travel estimates (`src/server/pilot/provision.ts`). There is no setup screen for these.
- Nothing else in the exercise: loading, fixing held rows, reserving, shipping, reconciling, asking and reporting
  were done through the screens in `tests/e2e/zzz-pilot.spec.ts`.

## Limits

- The assistant has only been run in demo mode and against a mock provider; no live model call has been made.
- Demo mode recognises a small set of phrasings (the four pilot questions and those in `docs/assistant.md`).
- An unchanged next-day export counts as the same file, so it does not refresh "last verified" times.
- Items created from a file are typed as implants tracked by lot (or by serial when the row has one). There is no
  screen to edit item type, merge duplicate items, or change a verified conversion.
- Reservations are made by a person (one click per case); nothing reserves automatically from a requirements file.
- `.xls` (old Excel) is refused with instructions; files over 3.5 MB are refused.
- Travel times and receiving rules are whatever was entered at setup; they are estimates, and labelled as such.
- Uploaded files are stored in the database unencrypted. Use synthetic or de-identified data.
- Dates are read as US month/day/year when written with slashes.
