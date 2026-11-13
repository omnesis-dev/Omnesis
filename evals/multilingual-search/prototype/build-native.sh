#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

set -eu
: "${CARGO_TARGET_DIR:?Set CARGO_TARGET_DIR outside the repository}"
: "${CARGO_BUILD_JOBS:=2}"
export CARGO_BUILD_JOBS
sqlite_include=${1:?Pass the directory containing sqlite3.h and sqlite3ext.h}
shift
probe_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cargo build --release --locked --manifest-path "$probe_dir/Cargo.toml" "$@"
case $(uname -s) in
  Linux)
    extension=so
    loader_path='$ORIGIN'
    ;;
  Darwin)
    extension=dylib
    loader_path='@loader_path'
    install_name_tool -id '@rpath/libomnesis_multilingual_core.dylib' \
      "$CARGO_TARGET_DIR/release/libomnesis_multilingual_core.dylib"
    ;;
  *) printf '%s\n' 'This prototype build recipe targets Linux and macOS.' >&2; exit 1 ;;
esac
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror -O2 -fPIC -shared \
  -I "$sqlite_include" "$probe_dir/fts5-adapter.c" \
  -L "$CARGO_TARGET_DIR/release" -lomnesis_multilingual_core \
  "-Wl,-rpath,$loader_path" \
  -o "$CARGO_TARGET_DIR/release/libomnesis_multilingual.$extension"
