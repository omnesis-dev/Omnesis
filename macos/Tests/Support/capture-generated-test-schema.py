#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
"""Finite generated-plist observation only; never executable test configuration."""
import argparse
import hashlib
import json
import os
from pathlib import PurePosixPath
import plistlib
import stat
import uuid

MAX_BYTES = 1024 * 1024
PATH_FIELDS = ("TestHostPath", "TestBundlePath", "UITargetAppPath")
FIELDS = PATH_FIELDS + ("BlueprintName", "EnvironmentVariables", "TestingEnvironmentVariables",
                        "CommandLineArguments", "UITargetAppEnvironmentVariables",
                        "UITargetAppCommandLineArguments", "OnlyTestIdentifiers", "SkipTestIdentifiers")
TARGETS = ("OmnesisDesktopTests", "OmnesisDesktopUITests")
PARTS = frozenset(("Debug", "Release", "Contents", "MacOS", "PlugIns", "Omnesis.app", "Omnesis",
                   "OmnesisDesktopTests.xctest", "OmnesisDesktopUITests.xctest",
                   "OmnesisDesktopUITests-Runner.app", "OmnesisDesktopUITests-Runner"))


class Refusal(Exception):
    pass


def directory(path, create=False):
    """Open every path component without following links, including output parents."""
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in PurePosixPath(os.path.abspath(path)).parts[1:]:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        info = os.fstat(fd)
        if info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise Refusal()
        return fd
    except BaseException:
        os.close(fd)
        raise


def kind(value):
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, str):
        return "string"
    if isinstance(value, dict):
        return "dictionary"
    if isinstance(value, list):
        return "array"
    if isinstance(value, (int, float)):
        return "number"
    return "other"


def shape(value, keys):
    return {"fields": {key: kind(value[key]) for key in keys if key in value},
            "otherKeyCount": min(4096, sum(key not in keys for key in value))}


def path_fact(value, products):
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > 1024 or any(ord(c) < 32 for c in value):
        return {"kind": "refused"}
    prefix = "relative"
    tail = value
    if value.startswith("__TESTROOT__/"):
        prefix, tail = "testroot", value[len("__TESTROOT__/"):]
    elif value.startswith("__TESTHOST__/"):
        prefix, tail = "testhost", value[len("__TESTHOST__/"):]
    elif value.startswith("/"):
        root = os.path.abspath(products).rstrip("/") + "/"
        if not value.startswith(root):
            return {"kind": "outside-testroot"}
        prefix, tail = "testroot", value[len(root):]
    parts = tail.split("/")
    if not parts or any(part not in PARTS for part in parts):
        return {"kind": "unrecognized-path"}
    # Only closed product components are emitted; no arbitrary path or basename survives.
    return {"kind": prefix, "path": "/".join(parts)}


def target(value, ordinal, products, name=None):
    if not isinstance(value, dict):
        return {"ordinal": ordinal, "kind": kind(value)}
    blueprint = value.get("BlueprintName", name)
    selected = blueprint in TARGETS
    result = {"ordinal": ordinal, "blueprint": blueprint if selected else "other",
              "nativeTarget": selected, "topology": shape(value, FIELDS)}
    if selected:
        result["paths"] = {key: path_fact(value[key], products) for key in PATH_FIELDS if key in value}
    return result


def project(value, products):
    if not isinstance(value, dict):
        raise Refusal()
    metadata = value.get("__xctestrun_metadata__", {})
    version = metadata.get("FormatVersion", 1) if isinstance(metadata, dict) else None
    result = {"formatVersion": version if type(version) is int and version in (1, 2) else "unknown",
              "topology": shape(value, ("__xctestrun_metadata__", "TestConfigurations", "TestPlan", "CodeCoverageBuildableInfos") + TARGETS),
              "configurations": []}
    if type(version) is int and version == 1:
        entries = [(name, value[name]) for name in TARGETS if name in value]
        result["configurations"] = [{"ordinal": 0, "enabled": "implicit",
                                     "targets": [target(item, index, products, name) for index, (name, item) in enumerate(entries)]}]
    elif type(version) is int and version == 2:
        configs = value.get("TestConfigurations")
        if not isinstance(configs, list) or len(configs) > 8:
            raise Refusal()
        for index, config in enumerate(configs):
            if not isinstance(config, dict):
                raise Refusal()
            targets = config.get("TestTargets")
            if not isinstance(targets, list) or len(targets) > 16:
                raise Refusal()
            enabled = config.get("IsEnabled", True)
            result["configurations"].append({"ordinal": index, "enabled": enabled if type(enabled) is bool else "unknown",
                                              "topology": shape(config, ("Name", "IsEnabled", "TestTargets")),
                                              "targets": [target(item, i, products) for i, item in enumerate(targets)]})
    return result


def capture(products):
    root = directory(products)
    try:
        names = []
        with os.scandir(root) as entries:
            for index, entry in enumerate(entries):
                if index >= 256:
                    raise Refusal()
                if entry.name.endswith(".xctestrun"):
                    names.append(entry.name)
        if len(names) > 4:
            raise Refusal()
        records = []
        for index, name in enumerate(sorted(names)):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
            try:
                before = os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_mode & 0o022 or before.st_nlink != 1 or not 0 < before.st_size <= MAX_BYTES:
                    raise Refusal()
                raw = bytearray()
                while len(raw) <= MAX_BYTES:
                    part = os.read(fd, min(65536, MAX_BYTES + 1 - len(raw)))
                    if not part:
                        break
                    raw.extend(part)
                after = os.fstat(fd)
                path = os.stat(name, dir_fd=root, follow_symlinks=False)
                identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
                if len(raw) != before.st_size or identity(before) != identity(after) or identity(before) != identity(path):
                    raise Refusal()
                records.append({"ordinal": index, "sha256": hashlib.sha256(raw).hexdigest(),
                                "schema": project(plistlib.loads(raw), products)})
            finally:
                os.close(fd)
        return {"format": 1, "result": "observed" if records else "absent", "manifests": records}
    finally:
        os.close(root)


def publish(evidence, receipt):
    root = directory(evidence, create=True)
    try:
        leaf = "generated-test-schema-" + uuid.uuid4().hex
        os.mkdir(leaf, 0o700, dir_fd=root)
        child = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        try:
            raw = (json.dumps(receipt, sort_keys=True) + "\n").encode()
            if len(raw) > 65536:
                raw = b'{"format":1,"result":"refused","manifests":[]}\n'
            fd = os.open("latest.txt", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=child)
            with os.fdopen(fd, "wb") as output:
                output.write(raw)
        finally:
            os.close(child)
    finally:
        os.close(root)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--products", required=True)
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()
    try:
        receipt = capture(args.products)
    except Exception:
        receipt = {"format": 1, "result": "refused", "manifests": []}
    try:
        publish(args.evidence, receipt)
    except Exception:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
