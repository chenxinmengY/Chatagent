"""Own new Windows processes in non-inheritable kill-on-close Job Objects.

Only a newly-created suspended child is assigned/resumed. No lookup or stop by
executable name, port, or unrelated PID is allowed.
"""
import ctypes
from ctypes import wintypes as wt
import os
import subprocess
import time

CREATE_SUSPENDED = 0x00000004
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
KILL_ON_JOB_CLOSE = 0x00002000


class BASIC_LIMIT(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wt.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wt.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wt.DWORD), ("SchedulingClass", wt.DWORD)]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                       "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class EXTENDED_LIMIT(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", BASIC_LIMIT), ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]


class ACCOUNTING(ctypes.Structure):
    _fields_ = [(name, ctypes.c_longlong) for name in ("TotalUserTime", "TotalKernelTime", "ThisPeriodTotalUserTime", "ThisPeriodTotalKernelTime")] + [
        (name, wt.DWORD) for name in ("TotalPageFaultCount", "TotalProcesses", "ActiveProcesses", "TotalTerminatedProcesses")]


class THREADENTRY32(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ThreadID", wt.DWORD),
                ("th32OwnerProcessID", wt.DWORD), ("tpBasePri", wt.LONG), ("tpDeltaPri", wt.LONG), ("dwFlags", wt.DWORD)]


def api():
    if os.name != "nt":
        raise RuntimeError("Owned Job Object launcher is Windows-only")
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    signatures = {
        "CreateJobObjectW": ([ctypes.c_void_p, wt.LPCWSTR], wt.HANDLE),
        "SetInformationJobObject": ([wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD], wt.BOOL),
        "QueryInformationJobObject": ([wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD, ctypes.c_void_p], wt.BOOL),
        "AssignProcessToJobObject": ([wt.HANDLE, wt.HANDLE], wt.BOOL),
        "TerminateJobObject": ([wt.HANDLE, wt.UINT], wt.BOOL),
        "CloseHandle": ([wt.HANDLE], wt.BOOL),
        "SetHandleInformation": ([wt.HANDLE, wt.DWORD, wt.DWORD], wt.BOOL),
        "OpenProcess": ([wt.DWORD, wt.BOOL, wt.DWORD], wt.HANDLE),
        "CreateToolhelp32Snapshot": ([wt.DWORD, wt.DWORD], wt.HANDLE),
        "Thread32First": ([wt.HANDLE, ctypes.POINTER(THREADENTRY32)], wt.BOOL),
        "Thread32Next": ([wt.HANDLE, ctypes.POINTER(THREADENTRY32)], wt.BOOL),
        "OpenThread": ([wt.DWORD, wt.BOOL, wt.DWORD], wt.HANDLE),
        "GetProcessIdOfThread": ([wt.HANDLE], wt.DWORD),
        "ResumeThread": ([wt.HANDLE], wt.DWORD),
    }
    for name, (args, result) in signatures.items():
        function = getattr(kernel, name)
        function.argtypes, function.restype = args, result
    return kernel


def require(result, operation):
    if not result:
        raise ctypes.WinError(ctypes.get_last_error(), operation)
    return result


class OwnedJob:
    def __init__(self):
        self.kernel = api()
        self.handle = require(self.kernel.CreateJobObjectW(None, None), "CreateJobObjectW")
        try:
            require(self.kernel.SetHandleInformation(self.handle, 1, 0), "SetHandleInformation(Job)")
            limits = EXTENDED_LIMIT()
            limits.BasicLimitInformation.LimitFlags = KILL_ON_JOB_CLOSE
            require(self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)),
                    "SetInformationJobObject(KILL_ON_JOB_CLOSE)")
        except BaseException:
            self.close()
            raise

    def assign(self, process):
        # Open only our new suspended child; the retained Popen handle prevents PID reuse.
        handle = require(self.kernel.OpenProcess(0x0100 | 0x0001, False, process.pid), "OpenProcess(owned suspended child)")
        try:
            require(self.kernel.AssignProcessToJobObject(self.handle, handle), "AssignProcessToJobObject(owned child)")
        finally:
            self.kernel.CloseHandle(handle)

    def accounting(self):
        if not self.handle:
            raise RuntimeError("Owned Job Object is already closed")
        value = ACCOUNTING()
        require(self.kernel.QueryInformationJobObject(self.handle, 1, ctypes.byref(value), ctypes.sizeof(value), None),
                "QueryInformationJobObject")
        return dict(active_processes=value.ActiveProcesses, total_processes=value.TotalProcesses,
                    total_terminated_processes=value.TotalTerminatedProcesses)

    def terminate(self):
        require(self.kernel.TerminateJobObject(self.handle, 1), "TerminateJobObject(owned job)")

    def wait_empty(self, timeout=5):
        deadline = time.monotonic() + timeout
        while True:
            value = self.accounting()
            if value["active_processes"] == 0:
                return value
            if time.monotonic() >= deadline:
                raise TimeoutError("Owned Job Object still has active processes: " + repr(value))
            time.sleep(0.02)

    def close(self):
        if self.handle:
            handle, self.handle = self.handle, None
            require(self.kernel.CloseHandle(handle), "CloseHandle(owned job)")

    def __del__(self):
        if getattr(self, "handle", None):
            self.kernel.CloseHandle(self.handle)
            self.handle = None


def resume_initial_thread(kernel, pid):
    snapshot = kernel.CreateToolhelp32Snapshot(0x00000004, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error(), "CreateToolhelp32Snapshot")
    try:
        entry = THREADENTRY32()
        entry.dwSize = ctypes.sizeof(entry)
        result = kernel.Thread32First(snapshot, ctypes.byref(entry))
        threads = []
        while result:
            if entry.th32OwnerProcessID == pid:
                threads.append(entry.th32ThreadID)
            entry.dwSize = ctypes.sizeof(entry)
            result = kernel.Thread32Next(snapshot, ctypes.byref(entry))
        if ctypes.get_last_error() != 18:
            raise ctypes.WinError(ctypes.get_last_error(), "Thread32First/Next")
    finally:
        kernel.CloseHandle(snapshot)
    if len(threads) != 1:
        raise RuntimeError("Suspended owned child must have exactly one initial thread: " + repr(threads))
    thread = require(kernel.OpenThread(0x0002 | 0x0800, False, threads[0]), "OpenThread(owned initial thread)")
    try:
        if kernel.GetProcessIdOfThread(thread) != pid:
            raise RuntimeError("Initial thread no longer belongs to owned child")
        previous = kernel.ResumeThread(thread)
        if previous != 1:
            raise RuntimeError("Unexpected initial thread suspend count: " + str(previous))
    finally:
        kernel.CloseHandle(thread)
    return threads[0]


def spawn_owned(*args, **kwargs):
    """Return Popen with retained owned_job; no child code runs before assignment."""
    flags = kwargs.pop("creationflags", 0)
    if flags & (CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB):
        raise ValueError("Caller must not supply suspended/breakaway flags")
    if kwargs.get("close_fds", True) is not True:
        raise ValueError("Owned launcher requires close_fds=True")
    kwargs["close_fds"] = True
    job, process, assigned = OwnedJob(), None, False
    try:
        process = subprocess.Popen(*args, creationflags=flags | CREATE_SUSPENDED, **kwargs)
        job.assign(process)
        assigned = True
        thread_id = resume_initial_thread(job.kernel, process.pid)
        process.owned_job = job
        process.owned_lifecycle = dict(method="suspended_assign_job_resume", owned_pid=process.pid,
                                       initial_thread_id=thread_id, kill_on_job_close=True,
                                       handle_inheritable=False, breakaway_allowed=False)
        return process
    except BaseException as exc:
        cleanup_error = None
        try:
            if process is not None:
                if assigned:
                    job.terminate()
                elif process.poll() is None:
                    process.terminate()  # Never resumed: no descendants can exist.
                process.wait(timeout=5)
                if assigned:
                    job.wait_empty()
                for stream in (process.stdin, process.stdout, process.stderr):
                    if stream is not None:
                        stream.close()
        except BaseException as cleanup:
            cleanup_error = repr(cleanup)
        finally:
            job.close()
        raise RuntimeError("Owned launch failed before successful resume; suspended child cleanup attempted; "
                           f"owned_pid={getattr(process, 'pid', None)}, cleanup_error={cleanup_error}: {exc}") from exc


def stop_owned_tree(process):
    """Stop members of our retained Job even if the original root already exited."""
    job = getattr(process, "owned_job", None)
    if job is None:
        raise RuntimeError("Refusing to stop a Popen not created by spawn_owned")
    if not job.handle:
        return dict(method="owned_job_already_closed", owned_pid=process.pid, exit_code=process.poll())
    try:
        before = job.accounting()
        killed = before["active_processes"] > 0
        if killed:
            job.terminate()
        after = job.wait_empty()
        process.wait(timeout=5)
        return dict(method="terminate_owned_job" if killed else "owned_job_already_empty",
                    owned_pid=process.pid, exit_code=process.returncode, job_terminated=killed,
                    before=before, after=after, lifecycle=process.owned_lifecycle,
                    kill_on_job_close=True)
    finally:
        job.close()
