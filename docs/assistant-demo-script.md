# Three-minute demo: Ask operations

Setup (before the meeting): `npm start -- --reset`, open http://127.0.0.1:3001, sign in as **Morgan Hale
(ops@lakeshore.example)**. The demo clock starts at 8:00 AM Central. The panel shows a yellow **DEMO MODE** bar:
answers are deterministic and come from the live demo database; no AI model is called.

| Time | Do | Say |
|---|---|---|
| 0:00 | On the readiness board click **Ask operations**, then the first suggestion: *"Which of tomorrow's cases do I need to make calls on before 3 today?"* | "This is the morning question. It reads the same records as the board." |
| 0:20 | Point at the list: earliest act-by first, each facility's local time, owner per line. Point at the yellow **Unassigned** row (SYN-1002, TIB4-0205) and at **Deadline already passed (1)** (SYN-1004 tray). | "Five calls, in the order I have to make them. One has no owner. One deadline is already gone, so it is listed apart rather than mixed in." |
| 0:40 | Click **Draft assignment: SYN-1002**, choose *Jordan Ames (rep)*, **Confirm assignment**. | "It drafts; I decide. Nothing changes until I confirm." |
| 0:55 | Close the panel. Open **SYN-1005**. Click **Ask about this case** and type: *"We have five of these patella buttons on hand. Why does this case still show short?"* | "I don't repeat the case number. It knows where I am." |
| 1:15 | Read the grey line aloud: **6 physically on hand, 4 reserved for other cases, 1 on quality hold, 1 available, 2 required, short 1.** Show the unit table and the links (requirement, balances, the two cases holding reservations). | "The arithmetic is done by the application, not by a language model. Every number links to its record." |
| 1:35 | Type: *"Where can I get one more of this exact item before receiving closes?"* | "Best is PAT-0005 in Jordan's trunk. The closer one, in Riley's trunk, is on a quality hold, and it says so. Travel time is labeled as an estimate, and it flags that this unit has never been physically scanned there." |
| 1:55 | Type: *"Draft the transfer and give me a text I can send Jordan."* Show the draft: item, quantity, from, to, affected cases. Edit a word in the message, click **Copy text**. | "Two drafts. The message is never sent by the system; I copy it into my own phone." |
| 2:20 | Click **Confirm transfer** (double-click on purpose). | "At confirmation it rechecks permissions, availability, holds and the hospital's cutoff. Two taps, one transfer." |
| 2:35 | Type: *"Why does this case still show short?"* | "Same question, new answer: 1 already reserved for this case, 0 available, still short 1. It follows the ledger." |
| 2:50 | (If time) *"If I move Tray 14 to the urgent case, which other cases would I put at risk?"* | "A what-if. Nothing moves. It tells me SYN-1005 would have no replacement tray." |

Optional phone segment (1 minute): sign in as **Riley Novak** on a phone-sized window, **Handoff note** on SYN-1005,
tick **Work offline**, paste *"Dropped Tray 14 at North receiving at 2:10. Jamie counted 23 pieces. The count sheet
says 24. Jamie couldn't identify which one was missing."*, **Save note** (shows pending), untick offline. The draft
asks which facility "North" is and whether 2:10 was morning or afternoon, shows expected 24 / observed 23 /
discrepancy 1 / component unknown / release unchanged, and keeps Jamie's count as the rep's report.

If asked "is this the AI?": in this demo the wording is templated. With an API key configured the model chooses
the tools and writes the summary; the cards, numbers, links and confirmation checks are identical.
