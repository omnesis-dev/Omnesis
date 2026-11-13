# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Measure deployed artifact bytes and deterministic gzip level-6 sizes, not RAM."""

import argparse
import gzip
import hashlib
import json
import pathlib
import platform


class CountingSink:
    def __init__(self):
        self.bytes = 0

    def write(self, block):
        self.bytes += len(block)
        return len(block)

    def flush(self):
        pass


def measure(path):
    digest = hashlib.sha256()
    compressed = CountingSink()
    size = 0
    with path.open("rb") as source, gzip.GzipFile(
        filename="", mode="wb", compresslevel=6, fileobj=compressed, mtime=0
    ) as target:
        while block := source.read(1024 * 1024):
            size += len(block)
            digest.update(block)
            target.write(block)
    return {"bytes": size, "gzip6_bytes": compressed.bytes, "sha256": digest.hexdigest()}


def totals(files, roles):
    # A caller may supply a one-pass generator; both measurements need all roles.
    selected = tuple(roles)
    return {key: sum(files[role][key] for role in selected)
            for key in ("bytes", "gzip6_bytes")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for role in ("cli", "core", "adapter"):
        parser.add_argument(f"--{role}", type=pathlib.Path, required=True)
    parser.add_argument("--model", type=pathlib.Path)
    parser.add_argument("--detector", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    repository = pathlib.Path(__file__).resolve().parents[3]
    if args.output.resolve().is_relative_to(repository):
        raise ValueError("Diagnostic reports must remain outside the repository")
    files = {role: measure(getattr(args, role)) for role in ("cli", "core", "adapter")}
    if args.model:
        files["optional_language_model"] = measure(args.model)
    if args.detector:
        files["optional_language_detector"] = measure(args.detector)
    report = {"schema": 1, "platform": platform.system(), "architecture": platform.machine(),
              "artifacts": files, "native_bundle": totals(files, ("cli", "core", "adapter")),
              "fts_extension_bundle": totals(files, ("core", "adapter")),
              "fts_extension_with_optional_detection": totals(files, (role for role in files if role != "cli")),
              "native_bundle_with_optional_model": totals(files, files),
              "method": "Actual provided files; deterministic per-file gzip level6, mtime0. No stripping or modification.",
              "limitations": ["Disk/download sizes only; excludes resident memory, initialization and index/database storage.",
                              "CLI and core may duplicate embedded dictionaries; shipping both is counted explicitly.",
                              "Optional model/detector are counted only when supplied; this does not measure runtime memory.",
                              "Per-file gzip totals differ from compressing a combined distribution archive."]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
