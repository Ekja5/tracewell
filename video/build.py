"""Edits the recorded takes into the finished videos.

  python build.py main      -> out/Tracewell_Buyer_Demo.mp4  (+ .srt, script, thumbnail)
  python build.py preview   -> out/Tracewell_Quick_Preview.mp4 (+ .srt)

Per scene: frames (with capture timestamps) -> 30 fps video; narration WAVs placed at the recorded beat
times; on-screen labels for anything simulated. Then scenes are joined with clean cuts, captions are burned
into a band under the application picture, audio is loudness-normalized, and the result is exported as
H.264/AAC MP4 with fast start.
"""
import json, os, re, subprocess, sys, shutil
import numpy as np, soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = f"{HERE}/out"; WORK = f"{HERE}/work"
os.makedirs(OUT, exist_ok=True); os.makedirs(WORK, exist_ok=True)
N = json.load(open(f"{HERE}/narration.json")); DUR = json.load(open(f"{HERE}/audio/durations.json"))
FONT = "/usr/share/fonts/opentype/inter/Inter-SemiBold.otf"; FONT_R = "/usr/share/fonts/opentype/inter/Inter-Regular.otf"
BAND = "0x0f3d5e"; W, H, APP_H = 1920, 1080, 972; FPS = 30; SR = 48000
LABELS = {  # anything simulated is labeled on screen for the whole scene
    "m5_assistant": "Illustrative AI response  ·  assistant in demo mode", "p3_assistant": "Illustrative AI response  ·  assistant in demo mode",
    "m6_rep": "Simulated scan input", }
NAMES = {"main": "Tracewell_Buyer_Demo", "preview": "Tracewell_Quick_Preview"}

def run(cmd): 
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode: print(" ".join(cmd)[:400]); print(r.stderr[-1500:]); sys.exit(1)
    return r

def esc(t): return t.replace("\\", "\\\\").replace(":", "\\:").replace("'", "’").replace(",", "\\,")

def pill(text, x, y, size=30):
    return (f"drawtext=fontfile={FONT}:text='{esc(text)}':fontsize={size}:fontcolor=0x13202b:x={x}:y={y}:box=1:boxcolor=0xffd66b@0.96:boxborderw=14")

def scene_video(name):
    d = json.load(open(f"{HERE}/takes/{name}/scene.json")); fr = d["frames"]; total = d["duration"]
    lst = f"{WORK}/{name}.txt"
    with open(lst, "w") as f:
        for i, x in enumerate(fr):
            nxt = fr[i + 1]["t"] if i + 1 < len(fr) else total
            f.write(f"file '{HERE}/takes/{name}/{x['file']}'\nduration {max(0.001, nxt - x['t']):.4f}\n")
        f.write(f"file '{HERE}/takes/{name}/{fr[-1]['file']}'\n")
    if d["phone"]:
        ph = 940; pw = round(750 * ph / 1624 / 2) * 2
        vf = (f"fps={FPS},scale={pw}:{ph}:flags=lanczos,pad={pw + 12}:{ph + 12}:6:6:color=0x0b1620,"
              f"pad={W}:{APP_H}:(ow-iw)/2:(oh-ih)/2:color=0x1c2f3f,"
              f"drawtext=fontfile={FONT}:text='{esc('Field rep phone')}':fontsize=44:fontcolor=white:x=250:y=330,"
              f"drawtext=fontfile={FONT_R}:text='{esc('Dana Whitfield, case closeout')}':fontsize=30:fontcolor=0xb9d0df:x=250:y=396")
        if name in LABELS: vf += "," + pill(LABELS[name], 1290, 340)
    else:
        vf = f"fps={FPS},scale={W}:{APP_H}:flags=lanczos"
        if name in LABELS: vf += "," + pill(LABELS[name], 40, APP_H - 70)
    vf += f",pad={W}:{H}:0:0:color={BAND},trim=duration={total:.3f},format=yuv420p"
    out = f"{WORK}/{name}.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-vf", vf, "-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-an", out])
    return d, out

def scene_audio(d):
    n = int(round(d["duration"] * SR)); mix = np.zeros(n, dtype=np.float32)
    for b in d["beats"]:
        s, sr = sf.read(f"{HERE}/audio/{b['id']}.wav", dtype="float32")
        if sr != SR:  # 24 kHz -> 48 kHz (exact x2) by linear interpolation
            x = np.arange(len(s) * SR // sr) * (sr / SR); s = np.interp(x, np.arange(len(s)), s).astype(np.float32)
        i = int(round((b["start"] + 0.12) * SR)); mix[i:i + len(s)] += s[: max(0, n - i)]
    return mix

def wrap(text, width=58):
    """Caption cues: at most two lines of ~58 characters, split at sentence and clause boundaries."""
    parts = re.findall(r"[^.?!,:]+[.?!,:]?\s*", text); cues, cur = [], ""
    for p in parts:
        if len((cur + p).strip()) > width * 2 and cur.strip(): cues.append(cur.strip()); cur = p
        else: cur += p
        if re.search(r"[.?!]\s*$", cur) and len(cur.strip()) > width * 0.9: cues.append(cur.strip()); cur = ""
    if cur.strip(): cues.append(cur.strip())
    out = []
    for c in cues:
        if len(c) <= width: out.append(c); continue
        words = c.split(); best, bi = 10**9, 1
        for i in range(1, len(words)):
            a, b = " ".join(words[:i]), " ".join(words[i:])
            if max(len(a), len(b)) <= width + 6 and abs(len(a) - len(b)) < best: best, bi = abs(len(a) - len(b)), i
        out.append(" ".join(words[:bi]) + "\n" + " ".join(words[bi:]))
    return out

def ts(t, sep=","): h = int(t // 3600); m = int(t % 3600 // 60); s = t % 60; return f"{h:02d}:{m:02d}:{int(s):02d}{sep}{int(round((s % 1) * 1000)):03d}"[:12]

def build(part):
    scenes = [s["scene"] for s in N[part]]; texts = {b[0]: b[1] for s in N[part] for b in s["beats"]}
    vids, auds, cues, t0 = [], [], [], 0.0
    for name in scenes:
        d, v = scene_video(name); vids.append(v); auds.append(scene_audio(d))
        for b in d["beats"]:
            cs = wrap(texts[b["id"]]); tot = sum(len(c) for c in cs); a = t0 + b["start"] + 0.12; dur = DUR[b["id"]]["seconds"]
            for c in cs: e = a + dur * len(c) / tot; cues.append((a, e + 0.15, c)); a = e
        t0 += d["duration"]
        print(f"  {name}: {d['duration']:.1f} s")
    for i in range(len(cues) - 1):  # no overlaps
        if cues[i][1] > cues[i + 1][0]: cues[i] = (cues[i][0], cues[i + 1][0] - 0.02, cues[i][2])
    base = f"{OUT}/{NAMES[part]}"
    with open(base + ".srt", "w") as f:
        for i, (a, e, c) in enumerate(cues, 1): f.write(f"{i}\n{ts(a)} --> {ts(e)}\n{c}\n\n")
    ass = f"{WORK}/{part}.ass"
    with open(ass, "w") as f:
        f.write("[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n")
        f.write("Style: Cap,Inter,38,&H00FFFFFF,&H00FFFFFF,&H005E3D0F,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,60,60,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n")
        for a, e, c in cues:
            hh = lambda t: f"{int(t // 3600)}:{int(t % 3600 // 60):02d}:{t % 60:05.2f}"
            f.write(f"Dialogue: 0,{hh(a)},{hh(e)},Cap,,0,0,0,,{{\\pos(960,{APP_H + (H - APP_H) // 2})}}" + c.replace("\n", "\\N") + "\n")
    audio = np.concatenate(auds); wav = f"{WORK}/{part}.wav"; sf.write(wav, audio, SR)
    cat = f"{WORK}/{part}_cat.txt"; open(cat, "w").write("".join(f"file '{v}'\n" for v in vids))
    total = len(audio) / SR
    vf = f"ass={ass},fade=t=in:st=0:d=0.4,fade=t=out:st={total - 0.7:.2f}:d=0.7,format=yuv420p"
    af = f"loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.15,afade=t=out:st={total - 0.7:.2f}:d=0.7,aresample={SR}"
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", cat, "-i", wav, "-vf", vf, "-af", af,
         "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-maxrate", "6M", "-bufsize", "12M", "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p", "-r", str(FPS), "-g", "60",
         "-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", str(SR), "-movflags", "+faststart", "-metadata", f"title=Tracewell Case Logistics: {'buyer demo' if part == 'main' else 'quick preview'}", base + ".mp4"])
    with open(base + "_Narration_Script.md", "w") as f:
        f.write(f"# {NAMES[part].replace('_', ' ')}: narration script\n\nVoice: Kokoro \"{N['voice']}\" (synthetic speech). Scene times are from the finished video.\n\n")
        t = 0.0
        for s in N[part]:
            d = json.load(open(f"{HERE}/takes/{s['scene']}/scene.json")); f.write(f"## {s['scene']}  ({ts(t, '.')[3:8]} to {ts(t + d['duration'], '.')[3:8]})\n\n")
            for bid, text in s["beats"]: f.write(f"{text}\n\n")
            t += d["duration"]
    print(f"{base}.mp4  {total:.1f} s, {len(cues)} captions")

if __name__ == "__main__":
    part = sys.argv[1] if len(sys.argv) > 1 else "main"; build(part)
    if part == "main":  # thumbnail: a real frame of the application (the readiness board with the shortage highlighted)
        d = json.load(open(f"{HERE}/takes/m2_board/scene.json")); b = [x for x in d["beats"] if x["id"] == "m2b"][0]
        fr = [x for x in d["frames"] if x["t"] <= b["start"] + 3.0][-1]
        run(["ffmpeg", "-y", "-loglevel", "error", "-i", f"{HERE}/takes/m2_board/{fr['file']}", "-vf",
             f"scale={W}:{APP_H},pad={W}:{H}:0:0:color={BAND},drawtext=fontfile={FONT}:text='{esc('Tracewell  ·  See what needs attention before the deadline')}':fontsize=46:fontcolor=white:x=(w-text_w)/2:y={APP_H}+(108-text_h)/2",
             "-frames:v", "1", "-q:v", "2", f"{OUT}/Tracewell_Thumbnail.jpg"])
