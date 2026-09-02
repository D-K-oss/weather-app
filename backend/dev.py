"""Tiny stdlib dev supervisor: runs app.py and restarts it whenever a
.py file in this directory changes. Keeps the mini-service resilient
(crash -> auto restart) with zero third-party dependencies.
"""

import glob
import os
import subprocess
import sys
import time

WATCH_PATTERN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "*.py")
POLL_SECONDS = 1.0


def latest_mtime() -> float:
    newest = 0.0
    for path in glob.glob(WATCH_PATTERN):
        try:
            newest = max(newest, os.path.getmtime(path))
        except OSError:
            pass
    return newest


def main() -> None:
    proc = None
    last_mtime = latest_mtime()
    while True:
        if proc is None or proc.poll() is not None:
            if proc is not None:
                print("[supervisor] app.py exited, restarting...", flush=True)
            print("[supervisor] starting app.py", flush=True)
            proc = subprocess.Popen([sys.executable, "app.py"])
        time.sleep(POLL_SECONDS)
        current = latest_mtime()
        if current != last_mtime:
            last_mtime = current
            print("[supervisor] source changed, restarting app.py...", flush=True)
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            proc = None


if __name__ == "__main__":
    main()
