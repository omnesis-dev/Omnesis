#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Called by ios-logic.sh while its native operation owns the build host.
# Fix mode edits only scratch files and exports a patch; it never changes the source checkout.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-}"
REMOTE_ROOT="${2:-}"
HOST="${OMNESIS_EPIC_MACOS_HOST:-}"
[[ "$MODE" == check || "$MODE" == fix ]] || { echo "ios-style: choose check or fix" >&2; exit 64; }
[[ -n "$HOST" && -n "$REMOTE_ROOT" ]] || { echo "ios-style: configured host and guarded scratch checkout required" >&2; exit 78; }
[[ "$REMOTE_ROOT" =~ ^/[A-Za-z0-9_./+-]+$ ]] || { echo "ios-style: unsupported scratch path" >&2; exit 64; }
# Check independently of the caller before any mkdir or transfer, including symlink targets.
REMOTE_ROOT="$(ssh "$HOST" "python3 - $(printf '%q' "$REMOTE_ROOT")" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve()
marked_primary = any((parent / '.omnesis-primary').exists() for parent in [root, *root.parents])
if root in [pathlib.Path('/'), pathlib.Path.home()] or '_work' in root.parts or marked_primary:
    raise SystemExit('ios-style: refusing primary, home or CI scratch path')
print(root)
PY
)"
INPUT="$(mktemp -d "${TMPDIR:-/tmp}/omnesis-ios-style-input.XXXXXX")"
trap 'rm -rf "$INPUT"' EXIT

python3 - "$ROOT" "$INPUT" <<'PY'
import pathlib, re, subprocess, sys
root, output = map(pathlib.Path, sys.argv[1:])
workflow = (root / '.github/workflows/swiftlint.yml').read_text()
with (output / 'pins.env').open('w') as target:
    for tool in ['SWIFTFORMAT', 'SWIFTLINT']:
        for field, expression in [('VERSION', r'[0-9]+\.[0-9]+\.[0-9]+'), ('SHA256', r'[0-9a-f]{64}')]:
            key = f'{tool}_{field}'
            match = re.search(r'^  ' + key + r': "(' + expression + r')"$', workflow, re.M)
            if not match:
                raise SystemExit(f'ios-style: missing pinned {key}')
            target.write(f'{key}={match[1]}\n')
paths = set()
for arguments in [['diff', '--name-only', '--diff-filter=ACMR', '-z', 'main', '--', 'ios'],
                  ['ls-files', '--others', '--exclude-standard', '-z', '--', 'ios']]:
    for raw in subprocess.check_output(['git', *arguments], cwd=root).split(b'\0'):
        if not raw:
            continue
        name = raw.decode()
        if not name.endswith('.swift'):
            continue
        if not re.fullmatch(r'ios/[A-Za-z0-9_./+-]+\.swift', name) or '..' in pathlib.PurePosixPath(name).parts:
            raise SystemExit('ios-style: unsupported source filename')
        if (root / name).is_file():
            paths.add(name)
(output / 'files.txt').write_text(''.join(name + '\n' for name in sorted(paths)))
PY

ssh "$HOST" "mkdir -p $(printf '%q' "$REMOTE_ROOT/ios") $(printf '%q' "$REMOTE_ROOT/.build/native-style-input")"
rsync -az --delete --exclude '.build' --exclude 'Omnesis.xcodeproj' --exclude 'DerivedData' --exclude '*.xcuserstate' \
  "$ROOT/ios/" "$HOST:$REMOTE_ROOT/ios/"
rsync -az "$ROOT/.swiftformat" "$ROOT/.swiftlint.yml" "$ROOT/.swiftlint-baseline.json" "$HOST:$REMOTE_ROOT/"
rsync -az "$INPUT/" "$HOST:$REMOTE_ROOT/.build/native-style-input/"

REMOTE_STATUS=0
ssh "$HOST" "bash -s -- $(printf '%q' "$REMOTE_ROOT") $(printf '%q' "$MODE")" <<'REMOTE' || REMOTE_STATUS=$?
set -euo pipefail
ROOT="$1"
MODE="$2"
INPUT="$ROOT/.build/native-style-input"
source "$INPUT/pins.env"
CACHE="$ROOT/ios/.build/native-style-tools"
mkdir -p "$CACHE"

install_tool() {
  local name="$1" version="$2" expected="$3" url="$4" archive="$CACHE/$1-$2.zip" dest="$CACHE/$1-$2"
  if [[ ! -f "$archive" ]] || ! echo "$expected  $archive" | shasum -a 256 -c - >/dev/null 2>&1; then
    curl -fsSL --retry 3 --max-time 180 -o "$archive.tmp" "$url"
    echo "$expected  $archive.tmp" | shasum -a 256 -c -
    mv "$archive.tmp" "$archive"
  fi
  echo "$expected  $archive" | shasum -a 256 -c -
  mkdir -p "$dest"
  unzip -qo "$archive" -d "$dest"
  chmod +x "$dest/$name"
}
install_tool swiftformat "$SWIFTFORMAT_VERSION" "$SWIFTFORMAT_SHA256" \
  "https://github.com/nicklockwood/SwiftFormat/releases/download/$SWIFTFORMAT_VERSION/swiftformat.zip"
install_tool swiftlint "$SWIFTLINT_VERSION" "$SWIFTLINT_SHA256" \
  "https://github.com/realm/SwiftLint/releases/download/$SWIFTLINT_VERSION/portable_swiftlint.zip"
FORMAT="$CACHE/swiftformat-$SWIFTFORMAT_VERSION/swiftformat"
LINT="$CACHE/swiftlint-$SWIFTLINT_VERSION/swiftlint"
[[ "$("$FORMAT" --version)" == "$SWIFTFORMAT_VERSION" ]]
[[ "$("$LINT" version)" == "$SWIFTLINT_VERSION" ]]
cd "$ROOT"

if [[ "$MODE" == fix ]]; then
  WORK="$(mktemp -d "$ROOT/ios/.build/style-patch.XXXXXX")"
  trap 'rm -rf "$WORK"' EXIT
  git -C "$WORK" init -q
  while IFS= read -r file; do
    mkdir -p "$WORK/$(dirname "$file")"
    cp "$ROOT/$file" "$WORK/$file"
  done < "$INPUT/files.txt"
  git -C "$WORK" add --all
  while IFS= read -r file; do
    "$FORMAT" --config "$ROOT/.swiftformat" --cache ignore "$ROOT/$file"
    cp "$ROOT/$file" "$WORK/$file"
  done < "$INPUT/files.txt"
  git -C "$WORK" diff --no-ext-diff --binary > "$INPUT/style.patch"
else
  FORMAT_STATUS=0
  LINT_STATUS=0
  "$FORMAT" --config "$ROOT/.swiftformat" --lint --cache ignore ios > "$INPUT/swiftformat.txt" 2>&1 || FORMAT_STATUS=$?
  "$LINT" lint --strict --config "$ROOT/.swiftlint.yml" --baseline "$ROOT/.swiftlint-baseline.json" --reporter json \
    > "$INPUT/swiftlint.json" 2> "$INPUT/swiftlint.txt" || LINT_STATUS=$?
  cat "$INPUT/swiftformat.txt" "$INPUT/swiftlint.txt" "$INPUT/swiftlint.json"
  [[ "$FORMAT_STATUS" == 0 && "$LINT_STATUS" == 0 ]]
fi
REMOTE

OUT="${OMNESIS_IOS_STYLE_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/omnesis-ios-style.XXXXXX")}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
case "$OUT" in "$ROOT"|"$ROOT"/*) echo "ios-style: output must be outside the checkout" >&2; exit 64 ;; esac
rsync -az "$HOST:$REMOTE_ROOT/.build/native-style-input/" "$OUT/"
echo "→ iOS style artifacts: $OUT"
exit "$REMOTE_STATUS"
