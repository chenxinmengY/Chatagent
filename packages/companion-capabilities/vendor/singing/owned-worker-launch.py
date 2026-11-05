"""Own one Python script and all descendants without consuming its IPC stdin.

The caller must launch this file with an actual (non-venv-redirector) Python
executable. The non-inheritable Windows Job handle exists only in this owner;
terminating the owner therefore closes the handle and stops its entire tree.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


def save(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + "." + uuid.uuid4().hex + ".tmp")
    with temporary.open("x", encoding="utf-8") as output:
        json.dump(value, output, indent=2)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, file)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--worker-python", required=True)
    parser.add_argument("--entry", required=True)
    parser.add_argument("--ownership-module", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--args-json", default="[]")
    args = parser.parse_args()
    arguments = json.loads(args.args_json)
    if not isinstance(arguments, list) or len(arguments) > 256 or any(
            not isinstance(value, str) or "\0" in value for value in arguments):
        raise ValueError("Script arguments must be a bounded JSON string array")
    entry = Path(args.entry).resolve(strict=True)
    python = Path(args.worker_python).resolve(strict=True)
    module = Path(args.ownership_module).resolve(strict=True) / "owned_process.py"
    spec = importlib.util.spec_from_file_location("singing_owned_process", module)
    owned = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(owned)
    report_file = Path(args.report).resolve()
    record = {"schema": "singing-owned-launch-v1", "ownerPid": os.getpid(),
              "ownerPython": sys.executable, "state": "creating",
              "killOnOwnerExit": True, "modelsLoadedByOwner": False}
    # Written before child code can emit readiness; no paths or arguments are
    # copied to stdout, whose protocol belongs solely to the requested script.
    save(report_file, record)
    process = None
    result = 125
    try:
        process = owned.spawn_owned(
            [str(python), "-X", "utf8", "-u", "-B", str(entry), *arguments],
            stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr,
            creationflags=subprocess.CREATE_NO_WINDOW)
        record.update(state="running", workerPid=process.pid,
                      lifecycle=process.owned_lifecycle)
        save(report_file, record)
        result = process.wait()
        record["workerExitCode"] = result
    except BaseException as error:
        record.update(state="failed", errorType=type(error).__name__)
        # No script arguments, auth values, or upstream output in diagnostics.
        print("SINGING_OWNED_LAUNCH_FAILED: " + type(error).__name__, file=sys.stderr, flush=True)
    finally:
        try:
            if process is not None:
                record["cleanup"] = owned.stop_owned_tree(process)
                if record["cleanup"]["after"]["active_processes"] != 0:
                    raise RuntimeError("Owned tree did not become empty")
            record["state"] = "closed" if result == 0 else "failed"
        except BaseException as error:
            result = 125
            record.update(state="cleanup_failed", cleanupErrorType=type(error).__name__)
        save(report_file, record)
    return result


if __name__ == "__main__":
    raise SystemExit(main())
