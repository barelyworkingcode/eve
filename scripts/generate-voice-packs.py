#!/usr/bin/env python3
"""Generate Kokoro voice packs for on-device (native) TTS.

FluidAudio's KokoroAne model only ships `af_heart.bin` on HuggingFace, but its
voice-pack format is byte-identical to the upstream Kokoro `<voice>.safetensors`
style tensors ([510, 1, 256] fp32). This script extracts the raw tensor blob
from each safetensors voice and writes it as `public/kokoro-voices/<id>.bin`,
which eve serves statically. The relayClient native app fetches these on first
use (see EveVoice.swift `ensureVoicePack`).

Only English voices are generated — the KokoroAne model uses an English G2P
frontend, so non-English voices would be mispronounced.

Source: the prince-canuma/Kokoro-82M HuggingFace snapshot (already cached by the
Kokoro daemon). Override the voices dir with $KOKORO_VOICES_DIR if needed.
"""
import glob
import json
import os
import struct
import sys

# eve's native voice menu, intersected with the voices available upstream.
VOICES = [
    "af_heart", "af_bella", "af_nicole", "af_nova", "af_sarah", "af_sky",
    "am_adam", "am_echo", "am_eric", "am_michael",
    "bf_lily", "bm_daniel", "bm_george",
]

EXPECTED_SHAPE = [510, 1, 256]
EXPECTED_BYTES = 510 * 256 * 4  # fp32


def find_voices_dir() -> str:
    env = os.environ.get("KOKORO_VOICES_DIR")
    if env and os.path.isdir(env):
        return env
    home = os.path.expanduser("~")
    pattern = os.path.join(
        home, ".cache/huggingface/hub/models--prince-canuma--Kokoro-82M",
        "snapshots/*/voices",
    )
    matches = sorted(glob.glob(pattern))
    if not matches:
        sys.exit(
            "Could not find the Kokoro voices dir. Set KOKORO_VOICES_DIR to the "
            "directory containing <voice>.safetensors files."
        )
    return matches[-1]


def extract_blob(path: str) -> bytes:
    raw = open(path, "rb").read()
    hlen = struct.unpack("<Q", raw[:8])[0]
    hdr = json.loads(raw[8:8 + hlen])
    key = next(k for k in hdr if k != "__metadata__")
    info = hdr[key]
    if info["dtype"] != "F32" or info["shape"] != EXPECTED_SHAPE:
        raise ValueError(f"{path}: unexpected {info['dtype']} {info['shape']}")
    b0, b1 = info["data_offsets"]
    return raw[8 + hlen + b0:8 + hlen + b1]


def main() -> None:
    voices_dir = find_voices_dir()
    out_dir = os.path.join(os.path.dirname(__file__), "..", "public", "kokoro-voices")
    out_dir = os.path.abspath(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    written, missing = 0, []
    for voice in VOICES:
        src = os.path.join(voices_dir, f"{voice}.safetensors")
        if not os.path.exists(src):
            missing.append(voice)
            continue
        blob = extract_blob(src)
        if len(blob) != EXPECTED_BYTES:
            raise ValueError(f"{voice}: got {len(blob)} bytes, expected {EXPECTED_BYTES}")
        open(os.path.join(out_dir, f"{voice}.bin"), "wb").write(blob)
        written += 1

    print(f"Wrote {written} voice packs to {out_dir}")
    if missing:
        print(f"Not available upstream (skipped): {', '.join(missing)}")


if __name__ == "__main__":
    main()
