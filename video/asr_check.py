"""Transcribes each narration WAV with Whisper (base.en via sherpa-onnx) and prints it beside the script,
so pronunciation problems can be found without listening."""
import json, os, re, sys
import numpy as np, soundfile as sf, sherpa_onnx
here = os.path.dirname(os.path.abspath(__file__)); m = f"{here}/tools/sherpa-onnx-whisper-base.en"
rec = sherpa_onnx.OfflineRecognizer.from_whisper(encoder=f"{m}/base.en-encoder.onnx", decoder=f"{m}/base.en-decoder.onnx", tokens=f"{m}/base.en-tokens.txt", num_threads=4)
dur = json.load(open(f"{here}/audio/durations.json"))
norm = lambda t: re.sub(r"[^a-z0-9 ]", "", t.lower().replace("'", "")).split()
bad = 0
for bid, d in dur.items():
    s, sr = sf.read(f"{here}/audio/{bid}.wav", dtype="float32")
    st = rec.create_stream(); st.accept_waveform(sr, s); rec.decode_stream(st)
    heard = st.result.text.strip()
    a, b = norm(d["text"]), norm(heard)
    miss = [w for w in a if w not in b]
    flag = "" if len(miss) <= 0 else f"   <-- not heard: {miss}"
    if miss: bad += 1
    print(f"{bid}: {heard}{flag}")
print("beats with differences:", bad, "of", len(dur))
