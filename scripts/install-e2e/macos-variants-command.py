#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Run one owned child session; drain the whole group before restoring tools."""
import os
import signal
import subprocess
import sys
import time


def group_running(group):
    # ps is portable across the Linux controls and actual hosted Macs. Ignore
    # zombies, which cannot execute or retain a tool file open for mutation.
    output = subprocess.check_output(['ps', '-axo', 'pgid=,stat='], text=True, timeout=5)
    return any(int(parts[0]) == group and not parts[1].startswith('Z')
               for line in output.splitlines() if len(parts := line.split()) == 2)


def signal_group(group, sig):
    try:
        os.killpg(group, sig)
    except ProcessLookupError:
        pass


def retire(child, grace_seconds):
    # The runtime helper owns two separate daemon sessions. Its TERM cleanup
    # needs up to 2 * (30s grace + 15s forced exit), so production grants 110s.
    signal_group(child.pid, signal.SIGTERM)
    deadline = time.monotonic() + grace_seconds
    while True:
        child.poll()
        if not group_running(child.pid):
            break
        if time.monotonic() >= deadline:
            signal_group(child.pid, signal.SIGKILL)
            forced_deadline = time.monotonic() + 10
            while group_running(child.pid):
                child.poll()
                if time.monotonic() >= forced_deadline:
                    raise RuntimeError('owned command group survived forced retirement')
                time.sleep(0.05)
            break
        time.sleep(0.05)
    child.wait(timeout=5)


def supervise(argv, grace_seconds=110):
    child = None
    try:
        child = subprocess.Popen(argv, start_new_session=True)
        return child.wait()
    finally:
        if child is not None:
            retire(child, grace_seconds)


if __name__ == '__main__':
    def interrupted(*_):
        raise InterruptedError('owned command interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    sys.exit(supervise(sys.argv[1:]))
