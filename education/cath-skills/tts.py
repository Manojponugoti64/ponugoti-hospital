#!/usr/bin/env python3
"""Narration for the cath-skills video.

Reads script.json, synthesises each beat with Kokoro (offline, ONNX), and writes:
  build/narration.wav   one mono track, beats laid out on the video timeline
  build/timings.json    scene/beat start times the renderer syncs to
  build/captions.srt    sentence-level captions (written form, not phonetic)
  build/phonemes.txt    what the voice was actually asked to say (pronunciation audit)

Acronyms are mapped to phonemes explicitly: the default G2P reads "LAD" as the
word "lad" and swallows the "A" in "L-A-O".
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

HERE = Path(__file__).resolve().parent
BUILD = HERE / "build"
MODELS = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "models"

SR = 24000
LEAD_IN = 0.6      # silence before a scene's first beat
BEAT_GAP = 0.45    # silence between beats
TAIL = 1.1         # silence after a scene's last beat

LEXICON = {
    "LAD": "ˈɛlˈeɪdˈiː",
    "LAO": "ˈɛlˈeɪˈoʊ",
    "RAO": "ˈɑːɹˈeɪˈoʊ",
    "AP": "ˈeɪpˈiː",
    "PCI": "pˈiːsˈiːˈaɪ",
    "ECG": "ˈiːsˈiːdʒˈiː",
    "ST": "ˈɛstˈiː",
    "EBU": "ˈiːbˈiːjˈuː",
    "BMW": "bˈiːˈɛmdˈʌbəljˌuː",
    "NC": "ˈɛnsˈiː",
    "IVUS": "ˈaɪvəs",
    "OCT": "ˈoʊsˈiːtˈiː",
    "ACT": "ˈeɪsˈiːtˈiː",
    "ACE": "ˈeɪs",
    "SGLT2": "ˈɛsdʒˈiːˈɛltˈiː tˈuː",
    "P2Y12": "pˈiː tˈuːwˈaɪ twˈɛlv",
    "TIMI": "tˈɪmi",
    "posterolateral": "pˌɑːstəɹoʊlˈæɾəɹəl",
    "hemostasis": "hˌiːmoʊstˈeɪsɪs",
}
LEX_RE = re.compile(r"\b(" + "|".join(sorted(map(re.escape, LEXICON), key=len, reverse=True)) + r")\b")


def to_phonemes(kokoro, text):
    """Phonemise text, splicing lexicon entries in verbatim."""
    out = []
    pos = 0
    for m in LEX_RE.finditer(text):
        chunk = text[pos:m.start()]
        if chunk.strip():
            out.append(kokoro.tokenizer.phonemize(chunk.strip(), "en-us"))
        out.append(LEXICON[m.group(1)])
        pos = m.end()
    tail = text[pos:]
    if tail.strip():
        ph = kokoro.tokenizer.phonemize(tail.strip(), "en-us")
        # keep punctuation glued to the previous word ("LAD," not "LAD ,")
        if out and tail[:1] in ",.;:!?":
            out[-1] += ph
        else:
            out.append(ph)
    return " ".join(p for p in out if p)


def srt_time(s):
    ms = int(round(s * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    sec, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{sec:02},{ms:03}"


def main():
    script = json.loads((HERE / "script.json").read_text())
    BUILD.mkdir(exist_ok=True)
    kokoro = Kokoro(str(MODELS / "kokoro-v1.0.onnx"), str(MODELS / "voices-v1.0.bin"))

    track = []
    t = 0.0
    timings = {"fps": 30, "scenes": []}
    captions = []
    audit = []

    def silence(sec):
        track.append(np.zeros(int(round(sec * SR)), dtype=np.float32))

    for scene in script["scenes"]:
        s_start = t
        silence(LEAD_IN)
        t += LEAD_IN
        beats = {}
        for i, beat in enumerate(scene["beats"]):
            if i:
                silence(BEAT_GAP)
                t += BEAT_GAP
            ph = to_phonemes(kokoro, beat["text"])
            audio, sr = kokoro.create(ph, voice=script["voice"], speed=script["speed"], is_phonemes=True)
            assert sr == SR, sr
            audio = audio.astype(np.float32)
            dur = len(audio) / SR
            track.append(audio)
            beats[beat["id"]] = {"start": round(t - s_start, 3), "dur": round(dur, 3)}
            audit.append(f"[{beat['id']}] {beat['text']}\n    /{ph}/\n")

            # sentence captions, timed by character share of the beat
            sentences = [x for x in re.split(r"(?<=[.?!])\s+", beat["text"]) if x]
            total = sum(len(x) for x in sentences)
            c0 = t
            for sent in sentences:
                c1 = c0 + dur * len(sent) / total
                captions.append((c0, c1, sent))
                c0 = c1
            t += dur
            print(f"{beat['id']:>3}  {dur:5.1f}s  {beat['text'][:70]}")
        silence(TAIL)
        t += TAIL
        timings["scenes"].append({
            "id": scene["id"], "step": scene["step"],
            "start": round(s_start, 3), "dur": round(t - s_start, 3), "beats": beats,
        })

    timings["total"] = round(t, 3)
    wav = np.concatenate(track)
    peak = float(np.max(np.abs(wav)))
    if peak > 0:
        wav = wav * (0.89 / peak)
    sf.write(BUILD / "narration.wav", wav, SR)
    (BUILD / "timings.json").write_text(json.dumps(timings, indent=1))
    (BUILD / "phonemes.txt").write_text("\n".join(audit))
    (BUILD / "captions.srt").write_text("".join(
        f"{i}\n{srt_time(a)} --> {srt_time(b)}\n{txt}\n\n" for i, (a, b, txt) in enumerate(captions, 1)))
    print(f"total {t:.1f}s ({t / 60:.1f} min), {len(captions)} captions")


if __name__ == "__main__":
    main()
