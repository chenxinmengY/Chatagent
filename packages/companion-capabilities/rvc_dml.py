"""Run the song synthesizer in the installed DirectML environment, once per song."""
from contextlib import contextmanager, redirect_stdout
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import time

import numpy as np


@contextmanager
def song_synth(profile, job, report):
    import torch
    from rvc_boundary import validate_synth_inputs
    from rvc.lib.algorithm.synthesizers import Synthesizer

    # The outer Windows job owns this child too. Only the native Applio chunk
    # crosses environments; the CPU frontend keeps its original RNG sequence.
    with TemporaryDirectory(dir=job) as directory:
        stage = Path(directory)
        settings = stage / "profile.json"
        settings.write_text(json.dumps(profile), encoding="utf8")
        command = [profile["singingDml"]["python"], "-B", "-X", "utf8", "-u",
                   str(Path(__file__).resolve()), str(settings)]
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   encoding="utf8", creationflags=subprocess.CREATE_NO_WINDOW)
        original = Synthesizer.infer
        try:
            ready = json.loads(process.stdout.readline())
            if ready.get("backend") != "directml" or ready["weightsSha256"] != profile["weightsHash"]:
                raise RuntimeError("Unexpected RVC synthesizer")
            report.update(ready, chunks=0, synthesisSeconds=0.0)

            def infer(net, phone, phone_lengths, pitch, nsff0, sid):
                inputs = dict(phone=phone, phone_lengths=phone_lengths, pitch=pitch, nsff0=nsff0, sid=sid)
                validate_synth_inputs(torch, inputs)
                frames = phone.shape[1]
                # The latent normal draw, sine phase and sine noise occur in this order.
                latent = torch.randn(1, net.enc_p.out_channels, frames)
                phase = torch.rand(1, 1, net.dec.m_source.l_sin_gen.waveform_dim)
                noise = torch.randn(1, frames * net.dec.upp, phase.shape[-1])
                np.savez(stage/"chunk.npz", **{k:v.detach().numpy() for k,v in inputs.items()},
                         draw_0=latent.numpy(), draw_1=phase.numpy(), draw_2=noise.numpy())
                seq = report["chunks"] + 1
                process.stdin.write(str(seq) + "\n")
                process.stdin.flush()
                result = json.loads(process.stdout.readline())
                if result["seq"] != seq:
                    raise RuntimeError("Mismatched synthesis chunk")
                audio = np.load(stage/"audio.npy", allow_pickle=False)
                if audio.shape != (1, 1, frames * net.dec.upp) or not np.isfinite(audio).all():
                    raise ValueError("Invalid synthesized audio")
                report["chunks"] = seq
                report["synthesisSeconds"] += result["seconds"]
                return torch.from_numpy(audio), None, None

            Synthesizer.infer = infer
            yield
            process.stdin.close()
            if process.wait(timeout=20) or not report["chunks"]:
                raise RuntimeError("Incomplete DirectML synthesis")
        finally:
            Synthesizer.infer = original
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdin.close()
            process.stdout.close()


def serve(settings):
    import torch
    import torch_directml
    profile = json.loads(settings.read_text(encoding="utf8"))
    repo = Path(profile["rvcRoot"]) / "source/Applio"
    os.chdir(repo)
    sys.path[:0] = [str(repo), str(Path(profile["separation"]) / "rvc-synth-dml")]
    from rvc_boundary import RandomTape, install_cpu_harmonic_source, materialize_weight_norm_cpu, modules_for_rng
    from rvc.lib.algorithm.synthesizers import Synthesizer
    torch.set_num_threads(4)
    weights = Path(profile["root"]) / profile["weights"]
    with weights.open("rb") as src:
        sha = hashlib.file_digest(src, "sha256").hexdigest()
    if sha != profile["weightsHash"]:
        raise ValueError("RVC weights changed")
    ckpt = torch.load(weights, map_location="cpu", weights_only=True)
    config = list(ckpt["config"])
    config[-3] = ckpt["weight"]["emb_g.weight"].shape[0]
    net = Synthesizer(*config, use_f0=ckpt.get("f0",1),
                      text_enc_hidden_dim=768 if ckpt.get("version")=="v2" else 256,
                      vocoder=ckpt.get("vocoder","HiFi-GAN"))
    del net.enc_q
    net.load_state_dict(ckpt["weight"], strict=True)
    del ckpt
    net.eval().float()
    materialize_weight_norm_cpu(net, torch)
    adapter = profile["singingDml"]["adapter"]
    gpu = torch_directml.device_name(adapter).rstrip("\0")
    device = torch_directml.device(adapter)
    net.to(device)
    harmonic = install_cpu_harmonic_source(net, torch)
    print(json.dumps(dict(backend="directml",gpu=gpu,device=str(device),weightsSha256=sha)),file=sys.__stdout__,flush=True)
    for seq, line in enumerate(sys.stdin, 1):
        if int(line) != seq:
            raise ValueError("Invalid synthesis sequence")
        with np.load(settings.parent/"chunk.npz", allow_pickle=False) as data:
            values = {k:torch.from_numpy(data[k]).to(device) for k in ("phone","phone_lengths","pitch","nsff0","sid")}
            draws = {f"draw_{i}":data[f"draw_{i}"] for i in range(3)}
        records = [dict(kind=kind, shape=list(arr.shape), dtype="torch.float32")
                   for kind,arr in zip(("randn_like","rand","randn_like"),draws.values())]
        tape = RandomTape(torch, draws, records)
        start = time.perf_counter()
        with torch.no_grad(), tape.scoped(modules_for_rng()):
            output = net.infer(**values)[0]
        if output.device != device or tape.position != 3 or harmonic["calls"] != seq:
            raise RuntimeError("Synthesis backend or draw sequence changed")
        audio = output.cpu().numpy()
        elapsed = time.perf_counter()-start
        np.save(settings.parent/"audio.npy", audio)
        print(json.dumps(dict(seq=seq,seconds=elapsed)),file=sys.__stdout__,flush=True)


if __name__ == "__main__":
    with redirect_stdout(sys.stderr):
        serve(Path(sys.argv[1]).resolve())
