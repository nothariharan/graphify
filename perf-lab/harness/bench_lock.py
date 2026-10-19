"""Exclusive gate for performance measurements in this lab.

This host's throughput drifts ~3x between batches, so two agents benchmarking at the same
time do not just slow each other down - they silently corrupt each other's numbers. Every
measured run MUST go through this gate.

  python harness/bench_lock.py status
  python harness/bench_lock.py run --why "ab-rsl-v7 certified" -- node harness/ab_drag.mjs ...
  python harness/bench_lock.py run --why "sweep" -- powershell -NoProfile -File harness/sweep.ps1 ...

`run` is the interface to use. It acquires the lock, runs the command with its stdio passed
through, then releases and appends one line to results/bench-runs.log. That log is the audit
trail of every measurement taken in this lab: when, what command, how long, exit code. Need
several commands under one hold? Wrap them: `run --why ... -- powershell -Command "a; b"`.

`acquire` / `release` exist for same-process use only (the lock records the pid that took it
and refuses a foreign release), so across two shells they do not pair up. A lock is stolen
after STALE_SECONDS - long enough that a crashed holder cannot block the lab forever, short
enough that a live measurement is never interrupted. Use `--force` to steal immediately.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
LAB = os.path.dirname(HERE)
LOCK = os.path.join(LAB, ".bench.lock")
LOG = os.path.join(LAB, "results", "bench-runs.log")
POLL = 5.0
STALE_SECONDS = 20 * 60
MAX_WAIT = 45 * 60


def _now() -> str:
    return dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S%z")


def _read():
    try:
        with open(LOCK, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _alive(pid) -> bool:
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except (OSError, ValueError, TypeError):
        return False
    return True


def _holder() -> str:
    info = _read()
    if not info:
        return "free"
    age = int(time.time() - info.get("started_epoch", 0))
    dead = "" if _alive(info.get("pid")) else f"  (its pid {info.get('pid')} has exited)"
    stale = "  STALE - the next acquire will steal it" if age > STALE_SECONDS else ""
    return (f"{info.get('who')} since {info.get('started')} ({age}s ago): "
            f"{info.get('why')}{dead}{stale}")


def status() -> int:
    print("bench lock:", _holder())
    if os.path.exists(LOG):
        with open(LOG, encoding="utf-8") as fh:
            tail = fh.read().strip().splitlines()[-5:]
        print("last runs:")
        for ln in tail:
            print(" ", ln)
    return 0


def _try_acquire(why: str, force: bool = False):
    info = _read()
    if info:
        age = time.time() - info.get("started_epoch", 0)
        # Time-based, not pid-based: `run` holds the lock from a live process, and a manual
        # acquire whose process has exited must still be respected until it goes stale.
        stealable = force or age > STALE_SECONDS
        if not stealable:
            return False
        pid_note = "" if _alive(info.get("pid")) else " (its pid is gone)"
        print(f"[bench_lock] stealing lock from {info.get('who')} held for {int(age)}s{pid_note}", file=sys.stderr)
        # Clear the dead holder's file, but only if it is still the same lock we just read -
        # otherwise a fresh holder could have replaced it between our read and our remove.
        now = _read()
        if now and now.get("started_epoch") == info.get("started_epoch"):
            try:
                os.remove(LOCK)
            except OSError:
                pass
        else:
            return False
    payload = {
        "pid": os.getpid(),
        "who": f"{socket.gethostname()}:{os.getpid()}",
        "why": why,
        "started": _now(),
        "started_epoch": time.time(),
    }
    # O_EXCL so two agents cannot both believe they won the race.
    try:
        fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    return True


def acquire(why: str, wait: bool = True, force: bool = False) -> bool:
    deadline = time.time() + MAX_WAIT
    while True:
        if _try_acquire(why, force):
            print(f"[bench_lock] acquired by {os.getpid()} for: {why}")
            return True
        force = False
        if not wait or time.time() > deadline:
            return False
        print(f"[bench_lock] waiting: {_holder()}", file=sys.stderr)
        time.sleep(POLL)


def release() -> None:
    info = _read() or {}
    if info.get("pid") and int(info["pid"]) != os.getpid():
        print(f"[bench_lock] not releasing a lock held by {info.get('who')}", file=sys.stderr)
        return
    try:
        os.remove(LOCK)
    except OSError:
        pass


def _log(why: str, cmd: list, seconds: float, code: int) -> None:
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    line = "\t".join([_now(), f"{seconds:.1f}s", f"exit={code}", why, " ".join(cmd)])
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    for name in ("acquire", "run"):
        p = sub.add_parser(name)
        p.add_argument("--why", required=True, help="what is being measured, in one line")
        p.add_argument("--force", action="store_true", help="steal the lock without waiting out STALE_SECONDS")
        if name == "run":
            p.add_argument("rest", nargs=argparse.REMAINDER, help="-- <command> [args...]")
    sub.add_parser("release")
    args = ap.parse_args()

    if args.cmd == "status":
        return status()
    if args.cmd == "release":
        release()
        return 0
    if args.cmd == "acquire":
        return 0 if acquire(args.why, force=args.force) else 75
    rest = [a for a in args.rest if a != "--"]
    if not rest:
        print("bench_lock run: no command given", file=sys.stderr)
        return 2
    if not acquire(args.why, force=args.force):
        print("[bench_lock] gave up waiting; command NOT run", file=sys.stderr)
        return 75
    t0 = time.time()
    try:
        code = subprocess.call(rest)
    except KeyboardInterrupt:
        code = 130
    finally:
        _log(args.why, rest, time.time() - t0, code)
        release()
    print(f"[bench_lock] {args.why}: exit={code} in {time.time() - t0:.1f}s (logged to results/bench-runs.log)")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
