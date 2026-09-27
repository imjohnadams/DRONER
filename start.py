#!/usr/bin/env python3
"""Start the DRONER Vite dev server and open it in the default browser."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEV_URL = "http://127.0.0.1:5173"
READY_TIMEOUT_S = 60
POLL_INTERVAL_S = 0.25


def npm_executable() -> str:
    name = "npm.cmd" if os.name == "nt" else "npm"
    found = shutil.which(name) or shutil.which("npm")
    if not found:
        sys.exit(
            "npm was not found on PATH. Install Node.js (https://nodejs.org) "
            "and try again."
        )
    return found


def run_install(npm: str) -> None:
    if (ROOT / "node_modules").is_dir():
        return
    print("node_modules missing; running npm install...")
    completed = subprocess.run([npm, "install"], cwd=ROOT)
    if completed.returncode != 0:
        sys.exit(f"npm install failed with exit code {completed.returncode}.")


def start_dev_server(npm: str) -> subprocess.Popen[bytes]:
    kwargs: dict[str, object] = {"cwd": ROOT}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen([npm, "run", "dev"], **kwargs)


def wait_until_ready(proc: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + READY_TIMEOUT_S
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            sys.exit(
                f"Dev server exited before becoming ready (code {proc.returncode})."
            )
        try:
            with urllib.request.urlopen(DEV_URL, timeout=1) as response:
                if 200 <= response.status < 500:
                    return
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            pass
        time.sleep(POLL_INTERVAL_S)
    sys.exit(
        f"Timed out after {READY_TIMEOUT_S}s waiting for {DEV_URL}. "
        "Is another process using port 5173?"
    )


def terminate_tree(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
    try:
        proc.wait(timeout=8)
    except subprocess.TimeoutExpired:
        proc.kill()


def main() -> None:
    npm = npm_executable()
    run_install(npm)
    print(f"Starting Vite at {DEV_URL} ...")
    proc = start_dev_server(npm)

    def _shutdown(_signum=None, _frame=None) -> None:
        terminate_tree(proc)

    if os.name != "nt":
        signal.signal(signal.SIGTERM, _shutdown)

    try:
        wait_until_ready(proc)
        print(f"Opening {DEV_URL}")
        webbrowser.open(DEV_URL)
        proc.wait()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        terminate_tree(proc)


if __name__ == "__main__":
    main()
