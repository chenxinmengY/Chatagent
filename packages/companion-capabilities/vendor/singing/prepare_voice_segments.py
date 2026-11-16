"""Offline segmentation of a completed cover. Never sends messages.

Run with the existing mix-env; the small codec helper uses installed Python 3.9.
All cuts are contiguous and on 20 ms boundaries. Only the final packet is padded.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import time

import numpy as np
import soundfile as sf

RATE = 44100
PACKET = 882
ROOT = Path(__file__).resolve().parent


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def plan_segments(lead, frames):
    if lead.ndim != 2 or len(lead) != frames or not np.isfinite(lead).all():
        raise ValueError("Lead must be finite and aligned with completed master")
    if frames <= 0 or frames > RATE * 600:
        raise ValueError("Expected nonempty audio no longer than 600 seconds")
    # Energy of both channels: anti-phase stereo must not appear to be silence.
    power = np.mean(np.square(lead.astype(np.float64)), axis=1)
    bins = np.add.reduceat(power, np.arange(0, frames, PACKET)) / PACKET
    smooth = np.convolve(bins, np.ones(9) / 9, mode="same")
    cuts, start = [0], 0
    while frames - start > 50 * RATE:
        low, high = start // PACKET + 2000, start // PACKET + 2500
        indexes = np.arange(low, high + 1)
        # Prefer a quiet spot, with a small penalty for moving away from 45s.
        score = 10 * np.log10(np.maximum(smooth[indexes], 1e-12))
        score += .25 * np.abs(indexes * .02 - (start / RATE + 45))
        cut = int(indexes[np.argmin(score)]) * PACKET
        cuts.append(cut)
        start = cut
    cuts.append(frames)
    return [{"index": i + 1, "startFrame": a, "endFrame": b,
             "sourceSeconds": (b - a) / RATE,
             "codecFrames": math.ceil((b - a) / PACKET) * PACKET,
             "tailZeroFrames": (- (b - a)) % PACKET}
            for i, (a, b) in enumerate(zip(cuts, cuts[1:]))]


def inspect_silk(path, expected_packets):
    data = path.read_bytes()
    if data[:10] != b"\x02#!SILK_V3":
        raise ValueError("Invalid Tencent SILK header")
    offset, packets = 10, 0
    while offset < len(data):
        if offset + 2 > len(data):
            raise ValueError("Truncated SILK length")
        size = int.from_bytes(data[offset:offset + 2], "little", signed=True)
        offset += 2
        if size <= 0 or offset + size > len(data):
            raise ValueError("Invalid SILK packet")
        offset += size
        packets += 1
    if packets != expected_packets or not 0 < packets * 20 < 60000 or len(data) > 8 * 1024**2:
        raise ValueError("SILK packet duration or payload limit failed")
    return {"sha256": sha(path), "bytes": len(data), "packets": packets, "durationMs": packets * 20}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--master", type=Path, required=True)
    p.add_argument("--master-sha256", required=True)
    p.add_argument("--aligned-lead", type=Path, required=True)
    p.add_argument("--lead-sha256", required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--codec-python", default=sys.executable)
    a = p.parse_args()
    tick = time.perf_counter()
    if sha(a.master) != a.master_sha256 or sha(a.aligned_lead) != a.lead_sha256:
        raise ValueError("Input content differs from completed-cover record")
    if a.out.exists() or not a.out.resolve().is_relative_to(a.master.resolve().parent):
        raise ValueError("Use a fresh candidate output directory")
    master, rate = sf.read(a.master, always_2d=True)
    lead, lead_rate = sf.read(a.aligned_lead, always_2d=True)
    if rate != RATE or lead_rate != RATE or master.shape[1] not in (1, 2):
        raise ValueError("Expected already aligned 44.1 kHz master/lead")
    if not np.isfinite(master).all() or np.max(np.abs(master)) >= 1:
        raise ValueError("Master contains nonfinite or clipped samples")
    segments = plan_segments(lead, len(master))
    a.out.mkdir(parents=True)
    record = {"ok": False, "master": str(a.master.resolve()), "masterSha256": a.master_sha256,
              "lead": str(a.aligned_lead.resolve()), "leadSha256": a.lead_sha256,
              "sampleRate": RATE, "sourceFrames": len(master), "segments": segments,
              "codec": {"pcm_rate": RATE, "max_rate": 24000, "silk_rate": 100000,
                        "complexity": 2, "packet_size": 20, "tencent": True},
              "wechatSends": 0, "listeningAccepted": False}
    try:
        for item in segments:
            stem = f"part-{item['index']:02d}"
            wav, pcm = a.out / (stem + ".wav"), a.out / (stem + ".pcm")
            # Identical downmix matrix to the accepted 44.1k mono reference.
            mono = np.mean(master[item["startFrame"]:item["endFrame"]], axis=1)
            sf.write(wav, mono, RATE, subtype="PCM_24")
            converted = subprocess.run([shutil.which("ffmpeg"), "-nostdin", "-v", "error", "-i", str(wav),
                "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"], check=True, capture_output=True, timeout=30).stdout
            if len(converted) != len(mono) * 2:
                raise ValueError("Unexpected PCM conversion length")
            pcm.write_bytes(converted + bytes(item["tailZeroFrames"] * 2))
            item.update({"wav": wav.name, "pcm": pcm.name, "pcmSha256": sha(pcm),
                         "silk": stem + ".silk", "decoded": stem + "-decoded.wav"})
        request = a.out / "encode-request.json"
        request.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        subprocess.run([a.codec_python, "-B", str(ROOT / "encode_voice_segments.py"), str(request)], check=True, timeout=180)
        for item in segments:
            item["encoded"] = inspect_silk(a.out / item["silk"], item["codecFrames"] // PACKET)
            decoded, decode_rate = sf.read(a.out / item["decoded"], always_2d=True)
            if decode_rate != 24000 or decoded.shape != (item["encoded"]["packets"] * 480, 1):
                raise ValueError("Decoded segment shape/duration failed")
            if not np.isfinite(decoded).all() or np.max(np.abs(decoded)) >= 1:
                raise ValueError("Decoded segment clipped or nonfinite")
        record["ok"] = True
    finally:
        record["elapsedSeconds"] = time.perf_counter() - tick
        (a.out / "segments.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": record["ok"], "parts": len(segments), "seconds": record["elapsedSeconds"]}))


if __name__ == "__main__":
    main()
