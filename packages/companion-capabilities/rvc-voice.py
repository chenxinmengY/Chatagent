"""Convert a single local voice reply or a separated song using an installed RVC profile."""
import argparse
from contextlib import nullcontext
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from uuid import uuid4

import numpy as np
import soundfile as sf
from scipy.ndimage import gaussian_filter1d, maximum_filter1d
from scipy.signal import resample_poly


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def convert(profile, source, dest, synthesis=None):
    import faiss
    import torch

    root = Path(profile["root"])
    rvc = Path(profile["rvcRoot"])
    repo = rvc / "source/Applio"
    weights, index = root / profile["weights"], root / profile["index"]
    if digest(weights) != profile["weightsHash"] or digest(index) != profile["indexHash"]:
        raise ValueError("Installed RVC model or index changed")
    os.chdir(repo)
    os.environ.update(APPLIO_ROOT=str(repo), APPLIO_CODE_ROOT=str(repo),
                      APPLIO_CONFIG_FILE=str(root / "settings.json"), APPLIO_LOGS_DIR=str(root))
    sys.path[:0] = [str(repo), str(rvc / "vendor/server")]
    from feiyu_runtime.common import prepare, verify_audio_library
    cpu = json.loads((rvc / "runtime.cpu.json").read_text(encoding="utf8"))
    prepare(torch, cpu)
    verify_audio_library(cpu)
    from rvc.infer.infer import VoiceConverter
    faiss.omp_set_num_threads(4)
    loaded = []
    features = faiss.deserialize_index(np.frombuffer(index.read_bytes(), dtype=np.uint8))
    original_read = faiss.read_index

    def read_index(name, *args, **kwargs):
        if isinstance(name, (str, os.PathLike)) and Path(name).resolve() == index:
            loaded.append(features.ntotal)
            return features
        return original_read(name, *args, **kwargs)

    faiss.read_index = read_index
    try:
        route = nullcontext()
        if synthesis is not None and profile.get("singingDml"):
            sys.path.insert(0, str(Path(profile["separation"]) / "rvc-synth-dml"))
            from rvc_dml import song_synth
            route = song_synth(profile, dest.parent, synthesis)
        with route:
            torch.manual_seed(42)
            VoiceConverter().convert_audio(str(source), str(dest), str(weights), str(index),
                                           pitch=0, index_rate=.3, protect=.33)
    finally:
        faiss.read_index = original_read
    audio, rate = sf.read(dest, dtype="float32")
    if not loaded or rate != 40000 or audio.ndim != 1 or not np.isfinite(audio).all() or abs(len(audio)/rate - sf.info(source).duration) > .12:
        raise ValueError(f"Incomplete RVC output index={loaded}, rate={rate}, shape={audio.shape}, input={sf.info(source).duration}")
    return audio


def envelope(audio):
    width = 441
    frames = audio[:len(audio)//width*width].reshape(-1, width)
    return np.sqrt(np.mean(frames**2, axis=1))


def sing(profile, source, folder, mode, source_hash):
    if digest(source) != source_hash:
        raise ValueError("Singing input changed")
    accel = Path(profile["separation"])
    job = "mansui-" + uuid4().hex
    subprocess.run([str(accel/"dml-env/Scripts/python.exe"), "-X", "utf8", str(accel/"run-local-separation.py"),
                    "--input", str(source), "--input-sha256", source_hash, "--job-id", job, "--timeout", "420"], check=True)
    separation = json.loads((accel/"runs"/job/"manifest.json").read_text(encoding="utf8"))
    if not separation["ok"] or separation["sourceSha256"] != source_hash:
        raise ValueError("Invalid separation")
    stems = {name: Path(data["path"]) for name, data in separation["outputs"].items()}
    reference, rate = sf.read(stems["lead"], dtype="float32", always_2d=True)
    reference = reference.mean(axis=1)
    synthesis = {"backend":"cpu"}
    voice = resample_poly(convert(profile, stems["lead"], folder/"converted.wav", synthesis), 441, 400)
    if rate != 44100 or abs(len(reference)-len(voice)) > .12*rate:
        raise ValueError("Lead duration mismatch")
    voice = np.pad(voice[:len(reference)], (0, max(0,len(reference)-len(voice))))
    original, converted = envelope(reference), envelope(voice)
    active = original > max(.0001, original.max()*.09)
    if active.any():
        gain = np.percentile(original[active],65) / max(.0001,np.percentile(converted[active],65))
        voice *= np.clip(gain,.1,8)
    mask = gaussian_filter1d(np.clip(maximum_filter1d(original,15)/.003,0,1),2)
    voice *= np.interp(np.arange(len(voice))/441-.5, np.arange(len(mask)), mask).astype("float32")
    inst,_ = sf.read(stems["instrumental"],dtype="float32",always_2d=True)
    harmony,_ = sf.read(stems["harmony"],dtype="float32",always_2d=True)
    mix = inst * 10**(-3/20) + harmony*.84 + voice[:,None]
    if not np.isfinite(mix).all() or len(mix) != separation["sourceFrames"]:
        raise ValueError("Invalid mix")
    master = folder/"master.wav"
    sf.write(master,mix*(.92/max(.0001,np.max(np.abs(mix)))),rate,subtype="PCM_24")
    if mode == "clip":
        aligned = folder/"lead.wav"
        sf.write(aligned,np.column_stack((voice,voice)),rate,subtype="FLOAT")
        segments_script = Path(profile.get("segmentsScript", Path(profile["root"])/"prepare_voice_segments.py"))
        codec_args = ["--codec-python", profile["codecPython"]] if profile.get("codecPython") else []
        if not segments_script.exists():
            segments_script = Path(__file__).parent/"vendor/singing/prepare_voice_segments.py"
            if not codec_args:
                codec_args = ["--codec-python", sys.executable]
        subprocess.run([sys.executable,str(segments_script),
                        "--master",str(master),"--master-sha256",digest(master),
                        "--aligned-lead",str(aligned),"--lead-sha256",digest(aligned),
                        "--out",str(folder/"segments"),*codec_args],check=True)
    manifest = {"master":{"path":str(master),"sha256":digest(master),"frames":len(mix),"sampleRate":rate},
                "mode":mode,"inputSha256":source_hash,"weightsSha256":profile["weightsHash"],"synthesis":synthesis}
    (folder/"result.json").write_text(json.dumps(manifest), encoding="utf8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("profile", type=Path)
    parser.add_argument("mode", choices=["speech","clip","whole"])
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("source_hash", nargs="?")
    args = parser.parse_args()
    config = json.loads(args.profile.read_text(encoding="utf8"))
    source, output = args.source.resolve(strict=True), args.output.resolve()
    if args.mode == "speech":
        if output.exists():
            raise FileExistsError(output)
        audio = convert(config, source, output)
        sf.write(output, resample_poly(audio, 3, 5), 24000, subtype="PCM_16")
    else:
        sing(config, source, output, args.mode, args.source_hash)
