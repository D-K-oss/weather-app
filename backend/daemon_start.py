"""Double-fork daemon launcher for the Clima weather mini-service.

Detaches `bun run dev` (which runs the auto-restart supervisor + app.py)
into its own session so it survives the calling shell being torn down.

Usage:  python3 daemon_start.py   (returns immediately)
"""

import os
import sys

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(SERVICE_DIR, "service.log")


def daemonize() -> None:
    if os.fork() > 0:
        sys.exit(0)  # parent leaves
    os.setsid()
    if os.fork() > 0:
        sys.exit(0)  # intermediate exits, grandchild is adopted by init

    # Re-wire stdio into the service log.
    log = open(LOG_PATH, "ab", 0)
    os.dup2(log.fileno(), 1)
    os.dup2(log.fileno(), 2)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)

    os.chdir(SERVICE_DIR)
    os.execvp("bun", ["bun", "run", "dev"])


if __name__ == "__main__":
    daemonize()
    print("Weather service daemonized; logs ->", LOG_PATH)
