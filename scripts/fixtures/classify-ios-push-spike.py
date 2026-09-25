#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Classify the signed simulator spike without conflating launch and retention."""

import json
import sys
from pathlib import Path


def classify(report_path: Path, state_path: Path, pipeline_path: Path | None = None):
    report = json.loads(report_path.read_text(encoding="utf-8"))
    rows = [
        row
        for row in report["delivered"]
        if row["title"] == "Fetched title from the paired gateway"
    ]
    events = [
        json.loads(line)
        for line in state_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    pipeline = (
        pipeline_path.read_text(encoding="utf-8", errors="replace")
        if pipeline_path is not None
        else ""
    )
    expected_events = [
        {"path": "/notifications/claim", "body": {}},
        {
            "path": "/notifications/confirm",
            "body": {"id": "delivery_spike_1"},
        },
    ]
    if (
        len(rows) != 1
        or rows[0].get("body") != "Fetched body from the paired gateway."
        or events != expected_events
    ):
        bridge_injected_request = (
            "CoreSimulatorBridge" in pipeline
            and "Adding notification request" in pipeline
        )
        return {
            "result": "blocked",
            "reason": (
                "simctl injected the payload as a local notification request; "
                "separate extension completion was not proven"
                if bridge_injected_request
                else "separate extension completion was not proven"
            ),
            "simulatorBridgeInjectedRequest": bridge_injected_request,
            "report": report,
            "events": events,
        }

    row = rows[0]
    retained = (
        row.get("badge") == 7
        and row.get("interruptionLevel") == "time-sensitive"
    )
    return {
        "result": "positive" if retained else "negative",
        "row": row,
        "events": events,
    }


if __name__ == "__main__":
    pipeline_path = Path(sys.argv[3]) if len(sys.argv) > 3 else None
    print(json.dumps(classify(Path(sys.argv[1]), Path(sys.argv[2]), pipeline_path)))
