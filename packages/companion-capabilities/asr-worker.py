"""One isolated, bounded CPU transcription. Protocol on stdin/stdout only."""
import json
import re
import sys
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx


def main():
    request = json.loads(sys.stdin.buffer.read(32768))
    root = Path(request["root"])
    with wave.open(request["wav"], "rb") as audio:
        if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (16000, 1, 2):
            raise ValueError("ASR_PCM_REQUIRED")
        samples = np.frombuffer(audio.readframes(16000 * 123), dtype="<i2").astype(np.float32) / 32768
    if len(samples) < 8000 or len(samples) > 16000 * 122:
        raise ValueError("ASR_DURATION_LIMIT")
    if float(np.mean(samples * samples)) < 0.000005:
        raise ValueError("ASR_NO_SPEECH")
    model = root / "model"
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(model / "model.int8.onnx"), tokens=str(model / "tokens.txt"),
        num_threads=2, use_itn=True, debug=False, provider="cpu")
    parts = []
    for offset in range(0, len(samples), 16000 * 20):
        chunk = samples[offset:offset + 16000 * 20]
        if float(np.mean(chunk * chunk)) < 0.000005:
            continue
        stream = recognizer.create_stream()
        stream.accept_waveform(16000, chunk)
        recognizer.decode_stream(stream)
        text = re.sub(r"<\|[^|]*\|>", "", stream.result.text).strip()
        if text:
            parts.append(text)
    text = "".join(parts).strip()
    if not text:
        raise ValueError("ASR_NO_SPEECH")
    print(json.dumps({"text": text, "seconds": len(samples) / 16000, "kind": "local-sensevoice-transcription"}, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        code = str(error)
        print(json.dumps({"error": code if re.fullmatch(r"ASR_[A-Z_]+", code) else "ASR_DECODE_FAILED"}))
        sys.exit(1)
