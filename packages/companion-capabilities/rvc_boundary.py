"""Chatagent CPU/DirectML bridge helpers extracted from its earlier local integration."""
from contextlib import contextmanager
import sys

MAX_SYNTH_FRAMES = 6400

def validate_synth_inputs(torch, cpu):
    """One native chunk only; whole-song duration never expands GPU tensors."""
    if set(cpu) != {"phone", "phone_lengths", "pitch", "nsff0", "sid"}:
        raise ValueError("Unexpected synthesis input names")
    phone = cpu["phone"]
    if (phone.ndim != 3 or phone.shape[0] != 1 or phone.shape[2] != 768
            or not 1 <= phone.shape[1] <= MAX_SYNTH_FRAMES or phone.dtype != torch.float32
            or cpu["nsff0"].dtype != torch.float32 or cpu["nsff0"].shape != (1, phone.shape[1])
            or cpu["pitch"].shape != (1, phone.shape[1]) or cpu["phone_lengths"].shape != (1,)
            or cpu["sid"].shape != (1,) or cpu["phone_lengths"].item() != phone.shape[1]
            or any(cpu[name].dtype != torch.int64 for name in ("phone_lengths", "pitch", "sid"))
            or any(value.device.type != "cpu" or not torch.isfinite(value).all() for value in cpu.values())):
        raise ValueError("Synthesis request exceeds approved batch1/v2/FP32/6400-frame CPU bounds")
    return phone.shape[1]


class RandomTape:
    """Record actual CPU draws before in-place mutation, or replay those exact values."""
    def __init__(self, torch, arrays=None, records=None):
        self.torch = torch
        self.replay = arrays is not None
        self.arrays = {} if arrays is None else arrays
        self.records = [] if records is None else records
        self.position = 0

    def draw(self, kind, *args, **kwargs):
        torch = self.torch
        device = args[0].device if kind == "randn_like" else kwargs.get("device", "cpu")
        shape = tuple(args[0].shape) if kind == "randn_like" else tuple(args[0]) if len(args) == 1 and isinstance(args[0], (list, tuple)) else tuple(args)
        dtype = kwargs.get("dtype", args[0].dtype if kind == "randn_like" else torch.get_default_dtype())
        key = "draw_" + str(self.position)
        if self.replay:
            if self.position >= len(self.records):
                raise ValueError("Additional uncached random draw")
            record = self.records[self.position]
            if record["kind"] != kind or tuple(record["shape"]) != shape or record["dtype"] != str(dtype):
                raise ValueError("Random draw order/shape/dtype changed")
            value = torch.from_numpy(self.arrays[key].copy()).to(device=device, dtype=dtype)
        else:
            if str(device) != "cpu":
                raise ValueError("Capture must observe actual CPU random draws")
            value = getattr(torch, kind)(*args, **kwargs)
            self.arrays[key] = value.detach().cpu().numpy().copy()
            self.records.append(dict(kind=kind, shape=list(value.shape), dtype=str(value.dtype)))
        self.position += 1
        return value

    @contextmanager
    def scoped(self, modules):
        tape = self

        class TorchProxy:
            def __getattr__(self, name):
                if name in ("rand", "randn_like"):
                    return lambda *args, **kwargs: tape.draw(name, *args, **kwargs)
                return getattr(tape.torch, name)
        originals = [(module, module.torch) for module in modules]
        try:
            for module, _ in originals:
                module.torch = TorchProxy()
            yield
            if self.replay and self.position != len(self.records):
                raise ValueError("Cached random draws were not all consumed")
        finally:
            for module, original in originals:
                module.torch = original


def modules_for_rng():
    return [sys.modules[name] for name in ("rvc.lib.algorithm.synthesizers", "rvc.lib.algorithm.generators.hifigan")]


def materialize_weight_norm_cpu(model, torch):
    """After original tensor verification, preserve effective FP32 CPU weights once."""
    from torch.nn.utils import parametrize
    if any(p.device.type != "cpu" for p in model.parameters()):
        raise ValueError("Materialize weight norm before moving any parameter to DML")
    records = []
    with torch.no_grad():
        for name, module in list(model.named_modules()):
            if not parametrize.is_parametrized(module, "weight"):
                continue
            parameters = module.parametrizations.weight
            if len(parameters) != 1 or type(parameters[0]).__name__ != "_WeightNorm":
                raise ValueError("Unexpected weight parametrization: " + name)
            before = module.weight.detach().clone()
            parametrize.remove_parametrizations(module, "weight", leave_parametrized=True)
            if not torch.equal(before, module.weight.detach()):
                raise ValueError("Materialization changed effective weight: " + name)
            records.append(dict(module=name, shape=list(before.shape), dtype=str(before.dtype), effective_weight_exact=True))
    if not records:
        raise ValueError("Expected approved RVC weight norm layers were not found")
    return dict(method="CPU remove_parametrizations(weight, leave_parametrized=True)",
                materialized_layers=len(records), effective_weights_exact=True, layers=records)


def install_cpu_harmonic_source(model, torch):
    """Run the original parameter-free SineGenerator on CPU, then return to its caller's device."""
    sine = model.dec.m_source.l_sin_gen
    if type(sine).__name__ != "SineGenerator" or any(True for _ in sine.parameters()) or any(True for _ in sine.buffers()):
        raise ValueError("CPU harmonic wrapper is restricted to the approved parameter-free SineGenerator")
    original = sine.forward
    state = dict(method="original SineGenerator.forward on CPU; return all three tensors to input device", calls=0)

    def forward(f0, upsampling_factor):
        device = f0.device
        result = original(f0.to("cpu"), upsampling_factor)
        if len(result) != 3 or any(not isinstance(value, torch.Tensor) for value in result):
            raise ValueError("Unexpected SineGenerator output interface")
        state["calls"] += 1
        return tuple(value.to(device) for value in result)
    sine.forward = forward
    return state
