#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

set -eu

: "${CARGO_TARGET_DIR:?Set CARGO_TARGET_DIR to a directory outside the repository}"
sqlite_include=${1:?Pass the directory containing sqlite3.h and sqlite3ext.h}
shift
probe_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

cargo build --release --manifest-path "$probe_dir/Cargo.toml" "$@"

case $(uname -s) in
  Darwin)
    extension=dylib
    loader_path='@loader_path'
    ;;
  Linux)
    extension=so
    loader_path='$ORIGIN'
    ;;
  *)
    printf '%s\n' 'This evaluation build script supports Linux and macOS.' >&2
    exit 1
    ;;
esac

"${CC:-cc}" -std=c11 -Wall -Wextra -Werror -O2 -fPIC -shared \
  -I "$sqlite_include" "$probe_dir/fts5-adapter.c" \
  -L "$CARGO_TARGET_DIR/release" -lomnesis_charabia \
  "-Wl,-rpath,$loader_path" \
  -o "$CARGO_TARGET_DIR/release/libcharabia_fts5.$extension"
