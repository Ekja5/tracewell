# Ask operations (assistant) and field quick notes

Third pass. Adds a logistics assistant to the readiness board and case pages, reviewable action drafts, and a
typed/dictated handoff note for reps on the phone. All data is synthetic.

## How it works

```
browser panel ──POST /api/assistant/ask──► engine ──► planner (model OR demo rules) picks a tool
                                             │
                                             ▼
                              typed tools (src/server/assistant/tools.ts)
                              run in the app, under the signed-in user's
                              tenant / facility / role, on the same domain
                              functions the screens use
                                             │
                     cards (facts + source links) ──► shown to the user
                     modelData (minimal fields)   ──► sent to the model (provider mode only)
```

- **Facts never come from model text.** Every quantity, deadline, time-zone conversion and eligibility decision is
  computed by the app and returned as a typed *card* with source links and the time checked. The model (or the demo
  planner) only chooses which tool to call and writes a short summary.
- **Tools** (all permission-checked on every call): `call_list`, `case_readiness`, `shortage_explanation`,
  `find_exact_item`, `transfer_impact`, `case_history`, `draft_action`.
- **Clarifications stop the loop.** If a case or catalog number matches more than one record (for example two
  manufacturers sharing `NP-PAT-32`), the user chooses; the choice (manufacturer, package size, facility, case) is
  stored in the conversation context and carried through follow-ups.
- **Drafts** (`assign_followup`, `transfer`, `message`) are rows in `assistant_drafts`. Confirming a transfer goes
  through the existing `reserveAndTransfer` service after re-running the preview (permissions, availability,
  reservations, holds, facility cutoff). The draft row is locked, so repeated taps produce one transfer. If the unit
  was taken meanwhile, nothing is written; the draft becomes `stale` with what changed and refreshed options.
  Messages are never sent: copy the text and send it yourself.
- **Scope.** Clinical product choice and sterile-processing release are declined before any tool runs.
- **Record text is data.** Notes, descriptions, filenames and imported cells reach the model only inside tool
  results; the system prompt says to treat them as data, and no tool can act without a user confirmation.

## Modes

| Mode | When | Model calls | Label in the panel |
|---|---|---|---|
| `provider` | `ANTHROPIC_API_KEY` set (or `ASSISTANT_MODE=provider`) | Anthropic Messages API, server-side key | `AI model: <model>` |
| `demo` | default in development with no key | none | `DEMO MODE: deterministic sample responses from live records; no AI model is called` |
| `off` | default in production with no key | none | `Assistant off` |

Demo mode uses the same tools and database; only the tool choice (regex rules) and the wording (fixed templates) are
deterministic. A reservation change therefore changes the next answer. It understands the phrasings listed in the
panel's suggestions and in `src/server/assistant/demo.ts`.

Provider settings (`.env`): `ASSISTANT_MODEL` (default `claude-opus-5-5`), `ASSISTANT_TIMEOUT_MS` (20000, one
deadline for the whole exchange), `ASSISTANT_EFFORT`, `ASSISTANT_MAX_TOOL_ROUNDS`, `ASSISTANT_BASE_URL`.
Every request writes a row to `assistant_usage` (mode, model, input/output/cached tokens, tool calls, latency,
status `ok|error|timeout|refused`).

**Outage behavior.** On timeout, error or refusal the panel says the answer cannot be generated and links to the
board and Item finder. The board, exact-item lookup and draft review/confirmation do not depend on the model.
Quick notes fall back to rule-based extraction.

## Field quick note (phone)

`/cases/:id/handoff` (from "Handoff note" on the rep's home screen). The note is saved in IndexedDB under the
signed-in user and case first, shown as pending, and sent when online. Each note has one client id; the server
de-duplicates on it, and approval locks the row, so lost connections and repeated taps create one handoff.

The server turns the text into a draft: tray, facility, time, expected and observed counts, discrepancy, component.
- "Jamie counted 23" is stored as the rep's report, explicitly not Jamie's authenticated acknowledgment.
- A missing piece that the note does not identify is recorded as component `unknown`.
- Release status is never changed by a note.
- Ambiguous tray, facility or time produces a short question with options.
- Approving a shortfall opens a `missing_instrument` discrepancy on the tray and notifies operations. The original
  text stays on the note and in the audit entry.

## Evaluation

`npm run eval:assistant` (demo mode, no cost) or `npm run eval:assistant:provider` (real model; needs
`ANTHROPIC_API_KEY`). Each case declares expected facts, allowed sources and permitted actions and is checked
against cards and database state, not wording. Every source link is fetched as the same user to prove it opens
within their scope. Results: `docs/eval/assistant-eval-<mode>.json`.

| Case | Checks |
|---|---|
| E0 | 3 p.m. call list: ordered by act-by, owner or Unassigned (+ assignment draft), passed deadlines separate, links |
| E1 | 5 on hand, 4 reserved for other cases, 2 required: short 1; links to requirement, balances, reservations |
| E1b | Approved transfer changes the next answer; three concurrent confirms create one transfer; message stays a draft |
| E2 | Two manufacturers share a catalog number: clarification, choice kept in follow-ups |
| E3 | Closest exact unit on quality hold: excluded with the reason |
| E4 | Stale transfer draft: no movement, no shipment, explanation of what changed |
| E5 | Hospital user asks a regional question: only their facility; other facility's case invisible; transfer draft 403 |
| E6 | Rep reports one unidentified missing instrument: discrepancy 1, component unknown, release unchanged, one note |
| E7 | "What changed yesterday" with only today's snapshot: history gap stated |
| E8 | Model timeout: user told; board, exact-item lookup and draft confirmation still work |
| S1, S2 | Clinical/release questions declined; other tenant and other users cannot reach records or drafts |

`tests/integration/assistant-provider.test.ts` runs the real SDK client against a local mock of the Messages API:
tool loop, server-side credential, minimal fields to the model, injected record text confined to tool results,
clarification stops the loop, permissions on model-requested tools, error/429/refusal/timeout handling.

## Limits

- Demo mode recognizes a small set of phrasings; anything else gets a help message.
- Travel times are seeded estimates and are labeled as such.
- History answers rely on recorded events; there are no point-in-time snapshots of readiness.
- The assistant has not been run against a live model in this environment (no API key available here).
- Dictation uses the browser speech API where present, otherwise the keyboard's microphone.
- Quick-note text saved offline is in IndexedDB, unencrypted, like the rest of the offline queue.
