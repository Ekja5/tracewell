# Buyer video: how it was made and how to remake it

Everything on screen is the running application, recorded with browser automation. Nothing is mocked up.

| Step | Command | What it does |
|---|---|---|
| 1 | `bash scripts/db-local.sh` then create database `tracewell_video` (owner `orthoapp`) | Local PostgreSQL |
| 2 | `npx vite build` | Build the web app |
| 3 | `python3 -m venv video/tools/venv && video/tools/venv/bin/pip install kokoro-onnx soundfile sherpa-onnx` and download `kokoro-v1.0.onnx` + `voices-v1.0.bin` (kokoro-onnx GitHub release `model-files-v1.0`) into `video/tools/` | Speech model (Kokoro, Apache-2.0) |
| 4 | `video/tools/venv/bin/python video/tts.py` | One WAV per narration beat from `narration.json` |
| 5 | `node video/record.mjs main` and `node video/record.mjs preview` | Resets the demo account (`seed-demo.ts`), starts the app on port 3210, records each scene to `video/takes/<scene>/` |
| 6 | `video/tools/venv/bin/python video/build.py main` and `... preview` | Edits takes into `video/out/*.mp4`, `.srt`, script and thumbnail |
| 7 | `video/tools/venv/bin/python video/sync_check.py video/out/Tracewell_Buyer_Demo` | Transcribes the finished audio per caption to confirm sync |

Re-record one scene: `node video/record.mjs main m4_solution` (earlier scenes that change data are replayed off camera first).
Change a line of narration: edit `narration.json`, run step 4, re-record that scene, run step 6.
Change the demo day: `video/reset.sh --day=2026-12-07` (default: the next Monday to Thursday).

Files: `seed-demo.ts` (demo account), `lib.mjs` (capture, cursor, highlight), `record.mjs` (scenes), `build.py` (edit and export),
`slides/slide.html` (opening and closing cards), `asr_check.py` / `sync_check.py` (speech checks).
