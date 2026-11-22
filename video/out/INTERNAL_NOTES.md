# Internal notes for the buyer videos (not for prospects)

Recorded 2026-11-22 from the running application at 1920 x 1080, 30 fps, H.264/AAC MP4 with fast start.

## What is simulated or synthetic

| Item | Status | How it is disclosed in the video |
|---|---|---|
| All data (distributor "Northline Orthopedic Supply", hospitals, people, items, lots, cases) | Synthetic demo account built for this recording | App banner "All data is synthetic" on every screen; footer on title cards |
| Dates | Demo clock set to Mon Nov 23, 2026, 9:00 AM Central (cases Tue Nov 24). Recorded on Sun Nov 22; a weekday was used so surgery dates look right | Banner shows the demo clock |
| AI assistant | Local demo provider, not a live model. Wording is templated; tool results, numbers and links are computed from the demo records | On-screen label "Illustrative AI response · assistant in demo mode", the app's own DEMO MODE bar, and narration |
| Label scan on the phone | In-app scan simulator (GS1 label string), not a camera or scanner | On-screen label "Simulated scan input" and narration; usage table shows "label scan (simulated)" |
| Phone | Desktop browser emulating a 375 x 812 phone | Title "Field rep phone" |
| Narration | Synthetic voice (Kokoro "af_heart", Apache-2.0 model) | Not disclosed on screen |
| Travel times | Estimates entered in the demo account | App text and narration say "estimate" |
| Recall notice CO-FSN-2026-14 | Fictional; entered and second-person verified off camera before recording | Not separately labeled |
| Cursor and highlight ring | Drawn by the recording script so viewers can follow | Visual aid only |
| Sign-in | Done off camera so no login screen or password appears | n/a |

No ERP, EHR, courier or hospital system is connected or shown. No real company, patient or customer appears. Arthrex and Stryker are not named.

## Narrated claims checked against the screen

| Claim | Where it is visible |
|---|---|
| Five cases tomorrow, each in hospital-local time | Board: five cards, CST and EST times |
| Needs two inserts, one available; 5 on hand, 4 reserved, 1 available, 2 required, short 1 | Board, case NL-3021 |
| Owner Dana, deadline 3:00 PM today | Board, same card |
| Courier recorded delivery; hospital has not checked in; Marcus can confirm | Board, NL-3022 |
| Evidence: on-hand export, count this morning, reservations with who made them | Evidence list; spreadsheet row opens highlighted |
| One eligible unit in another rep's trunk, counted this morning, arrives before cutoff; travel time is an estimate | Rescue search row (arrival about 10:10 AM vs 3:00 PM cutoff) |
| Four warehouse units excluded: reserved for two later cases | Excluded sources row |
| Transfer is "planned"; picked, dispatched, received all 0 | Shipment XFR page |
| Board then shows transfer waiting on Chris with a leave-by time, and case still short one | Board after transfer |
| Assistant: three items, deadline order, owners; source link opens the case; follow-up uses updated arithmetic | Assistant panel |
| Scans confirmed by server with lot; closeout submitted; finance notified | Phone screens |
| Case completed with item, lot, who, when | Case NL-3018, Recorded usage |
| Recall trace: warehouse, in transit, hospital; two of tomorrow's cases; unit implanted this morning | Recall RCL-001 |
| Activation places holds and creates owner tasks; board flags both cases | Recall tasks; board |

No savings, compliance, certification, endorsement or competitive claims are made.

## Changes made to the application while preparing the recording

- A planned transfer out of a rep's trunk is now owned by that rep (was assigned to the warehouse lead).
- Case page shows a "Recorded usage" table after closeout.
- Scans made while online are no longer marked "captured offline".
- Wording: route travel-time disclaimer; location types shown without underscores on the recall page; duplicate lot label removed in rescue search.

## Review performed

- Both files open; durations and codecs checked with ffprobe; no black sections (blackdetect); longest pause about 3 s.
- Loudness normalized to about -16 LUFS; peak about -4 dB.
- Speech recognition run on every narration clip and on each caption window of the finished files: words match the captions (differences were only digits vs words).
- Frames inspected at regular intervals for both videos.
- Not done: nobody has listened to the audio by ear. Listen once before sending, mainly for the pronunciation of names.
