"""Generates one WAV per narration beat with Kokoro (Apache-2.0 model, voice from narration.json).
Skips beats whose text has not changed. Writes audio/durations.json."""
import json, hashlib, os, sys
import numpy as np, soundfile as sf
from kokoro_onnx import Kokoro
here = os.path.dirname(os.path.abspath(__file__))
n = json.load(open(f"{here}/narration.json"))
os.makedirs(f"{here}/audio", exist_ok=True)
dpath = f"{here}/audio/durations.json"
dur = json.load(open(dpath)) if os.path.exists(dpath) else {}
k = None
for part in ("main", "preview"):
    for sc in n[part]:
        for bid, text in sc["beats"]:
            h = hashlib.sha1(f"{n['voice']}|{n['speed']}|{text}".encode()).hexdigest()[:12]
            wav = f"{here}/audio/{bid}.wav"
            if dur.get(bid, {}).get("hash") == h and os.path.exists(wav): continue
            if k is None: k = Kokoro(f"{here}/tools/kokoro-v1.0.onnx", f"{here}/tools/voices-v1.0.bin")
            s, sr = k.create(text, voice=n["voice"], speed=n["speed"], lang="en-us")
            s = np.asarray(s, dtype=np.float32)
            # trim leading/trailing near-silence, keep a short natural tail
            idx = np.where(np.abs(s) > 0.004)[0]
            if len(idx): s = s[max(0, idx[0] - int(0.03 * sr)): min(len(s), idx[-1] + int(0.12 * sr))]
            sf.write(wav, s, sr)
            dur[bid] = {"hash": h, "seconds": round(len(s) / sr, 3), "text": text}
            print(bid, dur[bid]["seconds"])
json.dump(dur, open(dpath, "w"), indent=1)
tot = lambda p: sum(dur[b[0]]["seconds"] for sc in n[p] for b in sc["beats"])
print("main narration seconds:", round(tot("main"), 1), "preview:", round(tot("preview"), 1))
