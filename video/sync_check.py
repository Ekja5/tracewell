"""Checks narration/caption sync in a finished MP4: for each caption cue in the SRT, the audio inside that
time window is transcribed and compared with the caption text."""
import re, sys, subprocess, numpy as np, soundfile as sf, sherpa_onnx, os
here = os.path.dirname(os.path.abspath(__file__)); m = f"{here}/tools/sherpa-onnx-whisper-base.en"
rec = sherpa_onnx.OfflineRecognizer.from_whisper(encoder=f"{m}/base.en-encoder.onnx", decoder=f"{m}/base.en-decoder.onnx", tokens=f"{m}/base.en-tokens.txt", num_threads=4)
base = sys.argv[1]; wav = f"{here}/work/_check.wav"
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", base + ".mp4", "-ac", "1", "-ar", "16000", wav], check=True)
s, sr = sf.read(wav, dtype="float32")
t = lambda x: int(x[:2]) * 3600 + int(x[3:5]) * 60 + float(x[6:].replace(",", "."))
norm = lambda x: re.sub(r"[^a-z0-9 ]", "", x.lower().replace("'", "")).split()
cues = re.findall(r"\d+\n(\S+) --> (\S+)\n(.*?)\n\n", open(base + ".srt").read(), re.S); ok = 0
for a, e, text in cues:
    seg = s[int(max(0, t(a) - 0.25) * sr): int((t(e) + 0.25) * sr)]
    st = rec.create_stream(); st.accept_waveform(sr, seg); rec.decode_stream(st)
    want, got = norm(text), norm(st.result.text)
    hit = sum(1 for w in want if w in got) / max(1, len(want)); ok += hit >= 0.7
    if hit < 0.7: print(f"  {a} low match {hit:.0%}: caption={text!r} heard={st.result.text.strip()!r}")
print(f"{os.path.basename(base)}: {ok}/{len(cues)} caption windows contain their words")
