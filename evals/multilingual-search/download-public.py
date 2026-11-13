#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Download a frozen public NanoMIRACL subset outside the repository."""

import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import tempfile
import time
import urllib.request

DATASET = "hotchpotch/NanoMIRACL"
REVISION = "6e98c995a5be54ef41d3a016a2f30314dd625619"
LANGUAGES = "ar bn de en es fa fi fr hi id ja ko ru sw te th yo zh".split()


def download(root):
    if root.resolve().is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError("Public corpus downloads must remain outside the repository")
    root.mkdir(parents=True, exist_ok=True)
    base = f"https://huggingface.co/datasets/{DATASET}"
    tree_url = f"https://huggingface.co/api/datasets/{DATASET}/tree/{REVISION}?recursive=true&expand=false&limit=1000"
    with urllib.request.urlopen(tree_url, timeout=60) as response:
        tree = json.load(response)
    paths = {f"{kind}/{language}-00000-of-00001.parquet"
             for kind in ("corpus", "queries", "qrels") for language in LANGUAGES}
    entries = [entry for entry in tree if entry.get("path") in paths]
    if len(entries) != len(paths):
        raise RuntimeError("Frozen dataset tree does not contain every expected split")

    def fetch(entry):
        relative = entry["path"]
        target = root / relative
        target.parent.mkdir(exist_ok=True)
        expected = entry["lfs"]["oid"]
        if not target.exists():
            url = f"{base}/resolve/{REVISION}/{relative}?download=true"
            with urllib.request.urlopen(url, timeout=90) as response:
                data = response.read()
            if hashlib.sha256(data).hexdigest() != expected:
                raise RuntimeError(f"Download checksum mismatch: {relative}")
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as pending:
                pending.write(data)
                pending_path = Path(pending.name)
            pending_path.replace(target)
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        if digest != expected:
            raise RuntimeError(f"Cached checksum mismatch: {relative}")
        return {"path": relative, "sha256": digest, "bytes": target.stat().st_size}

    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        files = list(pool.map(fetch, entries))
    manifest = {"dataset": DATASET, "revision": REVISION, "languages": LANGUAGES,
                "files": sorted(files, key=lambda file: file["path"]),
                "downloadSeconds": time.perf_counter() - started}
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    with urllib.request.urlopen(f"{base}/raw/{REVISION}/README.md", timeout=60) as response:
        (root / "README-upstream.md").write_bytes(response.read())
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    args = parser.parse_args()
    result = download(args.data_dir.resolve())
    print(json.dumps({"dataset": DATASET, "revision": REVISION,
                      "files": len(result["files"]), "bytes": sum(file["bytes"] for file in result["files"]),
                      "downloadSeconds": result["downloadSeconds"]}, indent=2))
