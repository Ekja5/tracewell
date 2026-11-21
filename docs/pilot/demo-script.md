# Ten-minute pilot demo

**Before the meeting (2 minutes, at your desk)**

```
npm run db:local && npm run pilot:demo && npm start      # http://127.0.0.1:3001
```

`pilot:demo` creates the synthetic distributor (Summit Ortho Supply, two Ridgeline hospitals) and does
"yesterday's" work through the same services as the screens: loads the day-1 workbook, reserves stock, ships,
delivers and receives. The demo clock starts at 9:00 AM Central. To show the first load live instead, use
`npm run pilot:reset` (empty account) and follow the appendix.

Open two browser windows on the login page. All sign-ins are one click (demo accounts).
The assistant bar says **DEMO MODE**: wording is templated; the numbers, links and checks are the real ones.

| Min | Who / click | Say or ask | The buyer should see |
|---|---|---|---|
| 0:00 | Sign in as **Avery Brooks** (operations manager) → **Tomorrow's cases** | "Three cases tomorrow, each in its own hospital's local time." | SC-24031 **Needs attention**, SC-24032 **In progress**, SC-24033 **Ready**. 7:30 AM CST, 10:00 AM EST, 1:00 PM CST. |
| 0:45 | Point at SC-24031 | "This is a confirmed shortage, with the arithmetic." | *5 physically on hand, 4 reserved for other cases, 1 available, 2 required, short 1.* Owner Dana Whitfield, act by 3:00 PM CST. |
| 1:15 | Click evidence link **summit-day1.xlsx › Inventory › row 2 says 5 on hand** | "Challenge it. Here is the row your coordinator uploaded." | The upload page, row 2 highlighted. Browser Back. |
| 1:45 | Point at SC-24032 and SC-24033 | "Delivered is not received. And this is what ready looks like." | SC-24032: courier Lee Tran recorded delivery; **Can resolve: Marcus Hall**. SC-24033: courier scan plus Priya Nair's check-in. |
| 2:15 | **Ask operations** → click *Which cases do I need to make calls on before 3 today?* | "Same engine as the board." | Two calls in deadline order: SC-24032 (2:00 PM EST, waiting on hospital), SC-24031 (3:00 PM CST, confirmed shortage). SC-24033 is not listed. |
| 3:00 | Click *The spreadsheet says five are on hand. Why are we short?* | "It answers from records, and shows them." | Same sentence as the board; links to the spreadsheet row, the requirement row, and the two reservations with who made them and when. |
| 3:40 | Click *Which case still needs someone at the hospital to confirm receipt?* | | SC-24032; Marcus Hall can confirm; link to the shipment and the courier scan time. |
| 4:00 | Close the panel. Second window: sign in as **Casey Lindqvist** (coordinator) → **Load files** | "Now your turn. This is tomorrow morning's warehouse export. Pick any number for the tibial insert." | Under *Example files*: type the buyer's number (6, 7, anything) → **Download**. Or open the day-2 workbook in Excel and change cell G2. |
| 4:40 | **Choose File** → the downloaded workbook | "It remembers yesterday's column mapping." | Green note: *Using the column mapping Casey Lindqvist saved…*. Select **Yes** (complete list). **Preview**. |
| 5:10 | Read the preview | "Nothing is saved yet. Row 2 disagrees with the system. Row 3 dropped from 3 to 1, and that is explained by the two shipments we recorded." | Row 2 **Held for review**: *The file says 6; the system has 5 (difference +1)… Stock was not changed.* Row 3 **Accepted**: *Recorded movements explain the change.* |
| 5:40 | **Load this worksheet** → **Tomorrow's cases** | "The board does not jump to the new number. It says what it does not know." | Banner: *1 spreadsheet difference waiting to be reconciled.* SC-24031 now **Missing information**, naming DISC-0001. |
| 6:10 | **Open Reconcile** | "A person decides, and says why." | DISC-0001: spreadsheet 6, system 5, previous file 5, unexplained +1, cases affected. Choose cause *Stock received but not recorded*, type a note, **Accept 6 as the current balance**. |
| 7:00 | Back to Avery's window → refresh **Tomorrow's cases** | "Six accepted, four still reserved: two available. The shortage is gone. B and C did not move." | SC-24031 **Action needed**: *6 physically on hand, 4 reserved for other cases, 2 available, 2 required, not short.* SC-24032 and SC-24033 unchanged. |
| 7:30 | **Ask operations** → *What changed since the previous upload?* | "Ask it what changed." | 00417: 5 → 6, *Casey Lindqvist accepted 6 as the current balance (DISC-0001…)* with her note; 00233: 3 → 1 explained; effect on SC-24031; links to both spreadsheet rows and the reconciliation. |
| 8:10 | Click the row link in the answer | "And the evidence is the row you just uploaded." | Day-2 upload, row 2 highlighted: *Reconciled DISC-0001 by Casey Lindqvist…* |
| 8:30 | Casey's window → **Load files** → upload the same workbook again → **Preview** | "Upload it twice by accident." | *Same contents as a file first uploaded…* then *Nothing was imported again; this is the original result.* |
| 9:00 | **Pilot review** → SC-24031: *Your current process predicted* **Ready** → **Record** | "This is how you decide whether to buy. Your process said ready at 9; ours said short." | App prediction captured automatically with a timestamp. Fill in what was verified, what was done, and how the case went. |
| 9:40 | **One-page report** | "Problems found, false alarms, misses, unknowns. Every number lists its cases. Savings only count with evidence." | The report table and *No savings are reported: none has been recorded with supporting evidence.* |

**If the buyer types a different number:** everything follows it. Seven gives three available; four gives *short 2*
after acceptance; five matches the system and opens no discrepancy at all.

**If asked whether this is AI:** in this demo the assistant's wording is templated (labelled DEMO MODE). With a model
key configured, the model chooses which of the same tools to call and writes the summary; the cards, numbers, links
and reconciliation rules are identical. This build has not been run against a live model.

## Appendix: showing the first load from an empty account (about 5 more minutes)

1. `npm run pilot:reset`. Sign in as Casey → **Load files** → download **Day 1 workbook**.
2. Upload it; worksheet **Inventory**; **Yes** (complete); **Preview**; **Load this worksheet**. On the result:
   row 4 (2 BX) → **Verify and re-check** (5 units per box); row 5 stays held (no lot); row 6 skipped (duplicate).
3. Upload again; worksheet **Schedule**; load; row 7 → click **Ridgeline Medical Center**.
4. Upload again; worksheet **Requirements**; load.
5. From the Schedule result, **Open case** on SC-24040, SC-24041, SC-24032, SC-24033 → **Reserve available units**;
   on the last two also **Plan delivery for reserved items**.
6. Warehouse (Sam Ortega): open each shipment → Pick, Pack, Dispatch. Courier (Lee Tran): **Mark delivered** on
   both. Hospital (Priya Nair): **Record receipt** on SC-24033's shipment.
