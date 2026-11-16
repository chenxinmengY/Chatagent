"""Small installed Python 3.9/pilk helper, with the accepted codec parameters."""
import hashlib
import json
from pathlib import Path
import sys
import wave
import pilk


def main():
    request = Path(sys.argv[1]).resolve(strict=True)
    data = json.loads(request.read_text(encoding="utf-8"))
    expected = {"pcm_rate": 44100, "max_rate": 24000, "silk_rate": 100000,
                "complexity": 2, "packet_size": 20, "tencent": True}
    if data["codec"] != expected or not 1 <= len(data["segments"]) <= 20:
        raise ValueError("Unexpected codec profile or segment count")
    for part in data["segments"]:
        paths = {key: request.parent / part[key] for key in ("pcm", "silk", "decoded")}
        if any(path.resolve().parent != request.parent for path in paths.values()):
            raise ValueError("Segment paths must stay in the request directory")
        raw = paths["pcm"].read_bytes()
        if hashlib.sha256(raw).hexdigest() != part["pcmSha256"] or len(raw) != part["codecFrames"] * 2:
            raise ValueError("PCM integrity failed")
        if paths["silk"].exists() or paths["decoded"].exists():
            raise ValueError("Refuse to overwrite existing encoded result")
        pilk.encode(str(paths["pcm"]), str(paths["silk"]), **expected)
        raw_decode = paths["decoded"].with_suffix(".pcm")
        pilk.decode(str(paths["silk"]), str(raw_decode), pcm_rate=24000)
        with wave.open(str(paths["decoded"]), "wb") as wav:
            wav.setparams((1, 2, 24000, 0, "NONE", "NONE"))
            wav.writeframes(raw_decode.read_bytes())


if __name__ == "__main__":
    main()
