#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

"""Download checksum-pinned probe dependencies outside Git and compile for Java 17."""

import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request


ARTIFACTS = [
    ("org.apache.lucene", "lucene-core", "9.12.3", "b64a3f8098a7572034fb30085cdee01b34ec81fb0e5a31b471536af58dc6c01b"),
    ("org.apache.lucene", "lucene-analysis-common", "9.12.3", "fa571bd7caf0f0b4faf46a72ca004a7836f348c31d92bd522dddcc3d128d287e"),
    ("org.apache.lucene", "lucene-analysis-nori", "9.12.3", "2152bf318181aec5ae16d540d0eba16371a0e641790ded19258d50760be30df4"),
    ("org.apache.lucene", "lucene-analysis-kuromoji", "9.12.3", "fb4999a9b9eb136e31774013ab24c8a32848bd943d0352aa180425f686963142"),
    ("org.apache.lucene", "lucene-analysis-smartcn", "9.12.3", "06db5436be801787738b9735ebe81622e263826a39dedc66402a99a1c33fab36"),
    ("org.apache.lucene", "lucene-analysis-stempel", "9.12.3", "1a2be4bcf8fd0be505b8fb7ed51613ea2398d46b072e71f00f6ec66c10e5e406"),
    ("org.apache.lucene", "lucene-analysis-morfologik", "9.12.3", "fa6243f702c862a25aadf1ec71349e9543bf3df58e97b0ca96ad099ffcc6b1ea"),
    ("com.google.code.gson", "gson", "2.13.2", "dd0ce1b55a3ed2080cb70f9c655850cda86c206862310009dcb5e5c95265a5e0"),
    ("org.carrot2", "morfologik-stemming", "2.1.9", "6170895b2315b697f4da5630caf57c6c441f1cb419d89d1cb5326b0673293e8a"),
    ("org.carrot2", "morfologik-fsa", "2.1.9", "1bfefce937df14cc94d32a98ce59c33f4d5b6c0eddbb436b6bfe27ff2120a23d"),
    ("org.carrot2", "morfologik-polish", "2.1.9", "e503682b3f4e8bb7a5d05820b0e2a4a19d4bad43dae20f64741786658a9cf478"),
    ("ua.net.nlp", "morfologik-ukrainian-search", "4.9.1", "463d9054b8d4cfacb9cd69566395826a6fe32fb6e7da91dbf79d37ddf7d56ba0"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=Path(tempfile.gettempdir()) / "omnesis-multilingual-research" / "lucene-jars")
    args = parser.parse_args()
    cache = args.cache_dir.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    jars = []
    for group, artifact, version, expected in ARTIFACTS:
        name = f"{artifact}-{version}.jar"
        target = cache / name
        if not target.exists():
            url = f"https://repo.maven.apache.org/maven2/{group.replace('.', '/')}/{artifact}/{version}/{name}"
            with urllib.request.urlopen(url, timeout=60) as response:
                data = response.read()
            if hashlib.sha256(data).hexdigest() != expected:
                raise RuntimeError(f"Downloaded checksum mismatch: {name}")
            with tempfile.NamedTemporaryFile(dir=cache, delete=False) as pending:
                pending.write(data)
                pending_path = Path(pending.name)
            pending_path.replace(target)
        if hashlib.sha256(target.read_bytes()).hexdigest() != expected:
            raise RuntimeError(f"Cached checksum mismatch: {name}")
        jars.append(target)
    source = Path(__file__).with_name("LuceneProbe.java")
    classes = cache / "classes"
    classes.mkdir(exist_ok=True)
    compiled = classes / "LuceneProbe.class"
    fingerprint = hashlib.sha256(source.read_bytes()).hexdigest()
    stamp = classes / "source.sha256"
    if not compiled.exists() or not stamp.exists() or stamp.read_text() != fingerprint:
        subprocess.run(["javac", "--release", "17", "-encoding", "UTF-8", "-cp", os.pathsep.join(map(str, jars)), "-d", str(classes), str(source)], check=True)
        stamp.write_text(fingerprint)
    print(os.pathsep.join(map(str, [classes, *jars])))


if __name__ == "__main__":
    main()
