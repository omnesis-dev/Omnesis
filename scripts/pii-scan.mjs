// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// PII / secret guard for text bound for git or GitHub.
//
// Two roles, one file:
//   1. PreToolUse hook (`--hook`): reads the Claude Code tool-call JSON from
//      stdin, and if the Bash command is a `gh` WRITE (issue/pr create|edit|
//      comment|review, or `gh api` with a body), scans the command — and any
//      `--body-file` / `-F field=@file` it references — for personal data or
//      secrets. A hit exits 2, which blocks the tool call and shows the reason
//      to the agent. This is the authoritative gate for any automated GitHub
//      write from this repo (e.g. an agent acting on the user's behalf).
//   2. CLI (`node scripts/pii-scan.mjs <file>…` or piped stdin): scans raw
//      text. Used by the lefthook commit-msg / pre-commit pass over the commit
//      message and staged diff. A hit exits 2.
//
// What it flags: real-looking emails (anything not on a reserved example
// domain), real-looking phone numbers (anything not in a reserved fiction
// range), tailnet (100.64.0.0/10) and private-LAN IPv4s, Tailscale ULA IPv6s
// (fd7a:115c:a1e0::/48), common credential shapes, and any literal listed in
// an operator denylist (machine names / personal identifiers that must never
// be hardcoded into this committed file). The denylist is the union of every
// existing file among: untracked `scripts/pii-denylist.txt`, the path in
// `$OMNESIS_PII_DENYLIST`, and `~/.config/omnesis/pii-denylist.txt` — the
// home-dir location exists so CI runner clones on the operator's machines
// (which never contain the untracked repo-local file) still enforce it.
//
// Escape hatch for interactive human use: `OMNESIS_PII_SKIP=1` disables the
// guard for that invocation. The loop never sets it, so unattended writes stay
// gated. Identity allow-lists are path-scoped so a reviewed fixture value in
// one file cannot silently bless the same value elsewhere.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const ALLOWLIST_PATH = join(REPO_ROOT, "privacy", "pii-allowlist.json");

// --- Allow-lists ------------------------------------------------------------

// Email domains that are reserved for documentation/examples (RFC 2606 plus the
// `.io` the repo's privacy guide blesses). Mail to these can never be a leak.
const RESERVED_EMAIL =
  /(^|\.)(example\.(com|org|net|io)|[a-z0-9-]+\.(test|example|invalid|localhost))$/i;
const RESERVED_TLD = /\.(test|example|invalid|localhost)$/i;

// Phone fragments reserved for fiction: NANP 555-01xx (and the repo's
// "+1 (555) 010-0xxx" convention) and the UK Ofcom drama range +44 7700 900xxx.
const FICTIONAL_PHONE = [
  /555[)\s.-]*01\d{2}/,
  /555[)\s.-]*010[)\s.-]*\d{3,4}/,
  /7700[\s.-]?900\d{3}/,
];

const DEFAULT_ALLOWLIST = {
  emails: [],
  phones: [],
  privateIps: [],
  tailnetIps: [],
  names: [],
  secretFixtures: [],
};

// --- Detectors --------------------------------------------------------------

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// E.164 (+ and 8–15 digits with optional separators) or NANP 3-3-4 / (3) 3-4.
const PHONE_RE =
  /(?:\+\d[\d\s().-]{7,}\d)|(?:\(\d{3}\)\s?\d{3}[\s.-]?\d{4})|(?:\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b)/g;
// Tailscale CGNAT range 100.64.0.0/10 — these are almost certainly tailnet infra.
const TAILNET_IP_RE = /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g;
// Tailscale ULA IPv6 range fd7a:115c:a1e0::/48 — identifies a specific tailnet node.
const TAILNET_IP6_RE = /\bfd7a:115c:a1e0:[0-9a-f:]*[0-9a-f]\b/gi;
const PRIVATE_IP_RE =
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;
const NAME_RE =
  /\b[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?(?:[ \t]+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?){1,2}\b/g;
const COPYRIGHT_LINE_RE =
  /^\s*(?:(?:\/\/|#|--|\/\*+|\*)\s*)?Copyright \(c\) \d{4}(?:-\d{4})?\s+.+?(?:\s*\*\/)?\s*$/i;
const SPDX_LINE_RE = /SPDX-License-Identifier:/i;

const SECRET_RES = [
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { kind: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g },
  // Anthropic keys contain hyphens (sk-ant-api03-…), so the openai-key pattern
  // below never matches them — they need their own detector.
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { kind: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
];

// Public files must not point contributors at repositories or issue trackers
// they cannot access. Keep exact private project identifiers in this scanner,
// which is excluded from its own repository-wide pass below.
const NON_PUBLIC_REFERENCE_RES = [{ kind: "non-public-reference", re: /\bomnesis-private\b/giu }];

const DIGITS = /\d/g;

function normalizeEmail(addr) {
  return addr.toLowerCase();
}

function normalizePhone(num) {
  const digits = num.replaceAll(/\D/g, "");
  return digits.length === 10 ? `1${digits}` : digits;
}

function emailAllowed(addr) {
  const at = addr.lastIndexOf("@");
  const domain = addr.slice(at + 1).toLowerCase();
  return RESERVED_EMAIL.test(domain) || RESERVED_TLD.test(domain);
}

function phoneAllowed(num) {
  return FICTIONAL_PHONE.some((re) => re.test(num));
}

function countDigits(s) {
  return (s.match(DIGITS) || []).length;
}

function redactSecret(s) {
  return `${s.slice(0, 6)}…[redacted ${s.length} chars]`;
}

/** Candidate denylist locations; every file that exists contributes terms. */
function denylistPaths() {
  const paths = [join(HERE, "pii-denylist.txt")];
  if (process.env.OMNESIS_PII_DENYLIST) paths.push(process.env.OMNESIS_PII_DENYLIST);
  paths.push(join(homedir(), ".config", "omnesis", "pii-denylist.txt"));
  return paths;
}

function loadDenylist() {
  const terms = new Set();
  for (const p of denylistPaths()) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const term = line.trim();
      if (term && !term.startsWith("#")) terms.add(term);
    }
  }
  return [...terms];
}

function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return DEFAULT_ALLOWLIST;
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
  return { ...DEFAULT_ALLOWLIST, ...raw };
}

function normalizeScanPath(path) {
  if (!path) return "";
  let normalized = path.replaceAll("\\", "/");
  const root = REPO_ROOT.replaceAll("\\", "/");
  if (normalized.startsWith(`${root}/`)) normalized = normalized.slice(root.length + 1);
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

function buildPathScopedSet(entries, normalizeValue = (v) => v) {
  const out = new Map();
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== "object") continue;
    if (typeof entry.value !== "string" || !Array.isArray(entry.paths)) continue;
    const value = normalizeValue(entry.value);
    const paths = out.get(value) ?? new Set();
    for (const path of entry.paths) {
      if (typeof path === "string" && path.length > 0) {
        paths.add(normalizeScanPath(path));
      }
    }
    out.set(value, paths);
  }
  return out;
}

function buildAllowSets(allowlist = loadAllowlist()) {
  return {
    emails: buildPathScopedSet(allowlist.emails, normalizeEmail),
    phones: buildPathScopedSet(allowlist.phones, normalizePhone),
    privateIps: buildPathScopedSet(allowlist.privateIps),
    tailnetIps: buildPathScopedSet(allowlist.tailnetIps, (v) => v.toLowerCase()),
    names: buildPathScopedSet(allowlist.names),
    secretFixtures: new Set(
      (allowlist.secretFixtures ?? []).map((v) => `${v.path ?? ""}\0${v.kind ?? ""}`),
    ),
  };
}

function allowSetsFor(opts) {
  return opts.allowSets ?? buildAllowSets(opts.allowlist);
}

function pathScopedValueAllowed(map, value, path) {
  const paths = map.get(value);
  if (!paths) return false;
  const normalizedPath = normalizeScanPath(path);
  return normalizedPath.length > 0 && paths.has(normalizedPath);
}

function pathScansNames(path) {
  if (!path) return false;
  return (
    /(^|\/)(?:evals\/universes|.*fixtures?.*|__fixtures__|PreviewMocks\.swift)(\/|$)/.test(path) ||
    // The brain bench's kit holds the invented cast its suites build documents
    // from. Those modules are not tests, so the test-file rule below misses
    // them — and they are exactly where a real name would be introduced.
    /(^|\/)packages\/collector\/src\/e2e\/brain-bench(\/|$)/.test(path) ||
    /\.(?:test|e2e\.test)\.[cm]?[jt]sx?$/.test(path)
  );
}

function isGeneratedOrBinaryPath(path) {
  if (
    /(^|\/)(?:node_modules|\.git|docs\/graph-debug-screenshots)\//.test(path) ||
    /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml)$/.test(path) ||
    path === "scripts/pii-scan.mjs" ||
    path === "scripts/pii-scan.test.mjs" ||
    path === "privacy/pii-allowlist.json"
  ) {
    return true;
  }
  return new Set([".db", ".gif", ".jpeg", ".jpg", ".mp4", ".pdf", ".png", ".sqlite", ".zip"]).has(
    extname(path).toLowerCase(),
  );
}

function linesFor(text) {
  const lines = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    lines.push({ line, offset });
    offset += line.length + 1;
  }
  return lines;
}

function lineNumberForOffset(lines, offset) {
  let current = 1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].offset > offset) break;
    current = i + 1;
  }
  return current;
}

function isCopyrightHeaderLineAtOffset(lines, offset) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].offset > offset) continue;
    if (!COPYRIGHT_LINE_RE.test(lines[i].line)) return false;
    const prefix = lines.slice(0, i).map(({ line }) => line.trim());
    return (
      prefix.length <= 3 &&
      prefix.some((line) => SPDX_LINE_RE.test(line)) &&
      prefix.every((line) => line === "" || line.startsWith("#!") || SPDX_LINE_RE.test(line))
    );
  }
  return false;
}

/**
 * Scan text and return an array of `{ kind, match }` findings. Pure: callers
 * pass `denylist` in tests so it never touches the filesystem.
 */
export function scanText(text, opts = {}) {
  const { denylist, path, scanNames = false } = opts;
  const terms = denylist ?? loadDenylist();
  const allow = allowSetsFor(opts);
  const out = [];
  const numberedLines = path || scanNames ? linesFor(text) : [];
  const push = (kind, match, offset) =>
    out.push({
      kind,
      match,
      ...(path ? { path, line: lineNumberForOffset(numberedLines, offset ?? 0) } : {}),
    });

  for (const m of text.matchAll(EMAIL_RE)) {
    if (!emailAllowed(m[0]) && !pathScopedValueAllowed(allow.emails, normalizeEmail(m[0]), path)) {
      push("email", m[0], m.index);
    }
  }
  for (const m of text.matchAll(PHONE_RE)) {
    const num = m[0].trim();
    if (
      !phoneAllowed(num) &&
      countDigits(num) >= 10 &&
      !pathScopedValueAllowed(allow.phones, normalizePhone(num), path)
    ) {
      push("phone", num, m.index);
    }
  }
  for (const m of text.matchAll(TAILNET_IP_RE)) {
    if (!pathScopedValueAllowed(allow.tailnetIps, m[0], path)) {
      push("tailnet-ip", m[0], m.index);
    }
  }
  for (const m of text.matchAll(TAILNET_IP6_RE)) {
    if (!pathScopedValueAllowed(allow.tailnetIps, m[0].toLowerCase(), path)) {
      push("tailnet-ip", m[0], m.index);
    }
  }
  for (const m of text.matchAll(PRIVATE_IP_RE)) {
    if (!pathScopedValueAllowed(allow.privateIps, m[0], path)) {
      push("private-ip", m[0], m.index);
    }
  }
  for (const { kind, re } of SECRET_RES) {
    for (const m of text.matchAll(re)) {
      if (!allow.secretFixtures.has(`${path ?? ""}\0${kind}`)) {
        push(kind, redactSecret(m[0]), m.index);
      }
    }
  }
  for (const { kind, re } of NON_PUBLIC_REFERENCE_RES) {
    for (const m of text.matchAll(re)) push(kind, m[0], m.index);
  }
  if (scanNames) {
    for (const m of text.matchAll(NAME_RE)) {
      if (
        !isCopyrightHeaderLineAtOffset(numberedLines, m.index ?? 0) &&
        !pathScopedValueAllowed(allow.names, m[0], path)
      ) {
        push("name", m[0], m.index);
      }
    }
  }
  const lower = text.toLowerCase();
  for (const term of terms) {
    if (lower.includes(term.toLowerCase())) push("denylist", "<redacted operator term>");
  }

  // Dedupe on kind+match so a string repeated in title and body reports once.
  const seen = new Set();
  return out.filter((f) => {
    const k = `${f.kind}\u0000${f.match}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// --- Allowlist hygiene --------------------------------------------------------

function phonePresentIn(text, value) {
  const want = normalizePhone(value);
  for (const m of text.matchAll(PHONE_RE)) {
    if (normalizePhone(m[0]) === want) return true;
  }
  return false;
}

/**
 * Return a finding for every allowlist (value, path) pair whose value no longer
 * appears in the file at that path. Stale entries are dead grants: they keep a
 * once-reviewed value pre-approved for a file where nothing uses it, so the
 * trust root only ever grows. `readFn(path)` returns file text or null when the
 * file is missing/untracked.
 */
export function staleAllowlistEntries(allowlist, readFn) {
  const out = [];
  const stale = (category, value, path, why) =>
    out.push({ kind: "stale-allowlist", match: `${category}: ${value} @ ${path} (${why})` });

  for (const category of ["emails", "phones", "privateIps", "tailnetIps", "names"]) {
    for (const entry of allowlist[category] ?? []) {
      for (const path of entry.paths ?? []) {
        const text = readFn(path);
        if (text === null) {
          stale(category, entry.value, path, "file missing");
          continue;
        }
        const present =
          category === "phones"
            ? phonePresentIn(text, entry.value)
            : category === "emails" || category === "tailnetIps"
              ? text.toLowerCase().includes(entry.value.toLowerCase())
              : text.includes(entry.value);
        if (!present) stale(category, entry.value, path, "value absent");
      }
    }
  }
  for (const entry of allowlist.secretFixtures ?? []) {
    const text = readFn(entry.path);
    if (text === null) {
      stale("secretFixtures", entry.kind, entry.path, "file missing");
      continue;
    }
    const re = SECRET_RES.find((s) => s.kind === entry.kind)?.re;
    if (!re || !re.test(text)) stale("secretFixtures", entry.kind, entry.path, "value absent");
    if (re) re.lastIndex = 0; // shared global regex — reset between uses
  }
  return out;
}

// --- gh-write detection (hook mode) -----------------------------------------

/** True when a Bash command is a `gh` operation that writes human-readable text. */
export function isGhWrite(cmd) {
  if (!/\bgh\b/.test(cmd)) return false;
  if (/\bgh\s+(issue|pr)\s+(create|edit|comment|review)\b/.test(cmd)) return true;
  if (/\bgh\s+api\b/.test(cmd) && /(?:-f|--field|-F|--raw-field)\s+\S*body=/.test(cmd)) return true;
  if (/(?:--body|--body-file|--title)\b/.test(cmd) || /(?:^|\s)-b\s/.test(cmd)) return true;
  return false;
}

/** Paths referenced by `--body-file PATH` or `-F field=@PATH` / `-f field=@PATH`. */
export function extractBodyFiles(cmd) {
  const files = [];
  for (const m of cmd.matchAll(/--body-file[=\s]+("([^"]+)"|'([^']+)'|(\S+))/g)) {
    files.push(m[2] ?? m[3] ?? m[4]);
  }
  for (const m of cmd.matchAll(/(?:-F|--field|-f|--raw-field)\s+\S*=@(\S+)/g)) {
    files.push(m[1]);
  }
  return files;
}

// --- Runners ----------------------------------------------------------------

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function report(findings, context, { hook = false } = {}) {
  const lines = findings.map((f) => {
    const loc = f.path ? `${f.path}:${f.line}: ` : "";
    return `  - ${loc}${f.kind}: ${f.match}`;
  });
  // The hook reads OMNESIS_PII_SKIP from its own process env (set when the
  // Claude Code session was launched), so an env prefix on the blocked command
  // cannot bypass it — only a human can, from outside the agent.
  const override = hook
    ? `This block cannot be bypassed from inside the agent; if the text is ` +
      `genuinely safe, ask the operator to post it themselves.\n`
    : `If a value is genuinely safe, override for this one invocation with: ` +
      `OMNESIS_PII_SKIP=1 <command>\n`;
  process.stderr.write(
    `\nPII guard blocked this ${context}:\n${lines.join("\n")}\n\n` +
      `If this is fictional example data, use a reserved range ` +
      `(example.com / example.org, +1 555-01xx, +44 7700 900xxx).\n` +
      `If this is a reviewed existing fixture, add a path-scoped entry to privacy/pii-allowlist.json.\n` +
      override,
  );
}

function runHook() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    process.exit(0); // not parseable → not our concern, let other hooks decide
  }
  if (payload?.tool_name !== "Bash") process.exit(0);
  const cmd = payload?.tool_input?.command ?? "";
  if (!isGhWrite(cmd)) process.exit(0);

  let text = cmd;
  for (const f of extractBodyFiles(cmd)) {
    try {
      text += `\n${readFileSync(f, "utf8")}`;
    } catch {
      /* a body-file we can't read can't be scanned here; lefthook + the
         prompt-level scan are the defense-in-depth layers for that case. */
    }
  }
  const findings = scanText(text);
  if (findings.length === 0) process.exit(0);
  report(findings, "gh write", { hook: true });
  process.exit(2);
}

function runCli(args) {
  if (args[0] === "--all") return runAll();
  if (args[0] === "--staged-diff") return runStagedDiff();

  const files = args.filter((a) => a !== "--files");
  const allowSets = buildAllowSets();
  const findings = files.length
    ? files.flatMap((f) =>
        scanText(safeRead(f), { path: f, scanNames: pathScansNames(f), allowSets }),
      )
    : scanText(readStdin(), { allowSets });
  if (findings.length === 0) process.exit(0);
  report(findings, files.length ? files.join(", ") : "input");
  process.exit(2);
}

function runAll() {
  const allowSets = buildAllowSets();
  const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const files = tracked.filter((f) => !isGeneratedOrBinaryPath(f));
  const findings = [];
  for (const f of files) {
    const text = safeRead(join(REPO_ROOT, f));
    if (text.includes("\0")) continue;
    findings.push(...scanText(text, { path: f, scanNames: pathScansNames(f), allowSets }));
  }
  const trackedSet = new Set(tracked);
  findings.push(
    ...staleAllowlistEntries(loadAllowlist(), (p) =>
      trackedSet.has(p) ? safeRead(join(REPO_ROOT, p)) : null,
    ),
  );
  if (findings.length === 0) process.exit(0);
  report(findings, "repository scan");
  process.exit(2);
}

/**
 * Whether an added line is the copyright line of a file's own licence header.
 *
 * `scanText` already exempts that line, but only by looking at what sits above
 * it — and a diff hands each added line on its own, with no file above it. A
 * newly added file therefore has its whole header in the diff and its header
 * exemption unreachable. Re-evaluating against the staged file restores it,
 * on the same terms: the line must actually be the header of that file, with
 * nothing but the SPDX line, a shebang or blank lines before it.
 */
export function isOwnCopyrightHeaderLine(path, added) {
  if (!path || !COPYRIGHT_LINE_RE.test(added)) return false;
  const head = safeRead(join(REPO_ROOT, path)).split("\n").slice(0, 4);
  const index = head.indexOf(added);
  if (index === -1) return false;
  const prefix = head.slice(0, index).map((line) => line.trim());
  return (
    prefix.some((line) => SPDX_LINE_RE.test(line)) &&
    prefix.every((line) => line === "" || line.startsWith("#!") || SPDX_LINE_RE.test(line))
  );
}

function runStagedDiff() {
  const allowSets = buildAllowSets();
  const diff = execFileSync(
    "git",
    [
      "diff",
      "--cached",
      "--no-color",
      "--unified=0",
      "--",
      ".",
      ":(exclude)scripts/pii-scan.mjs",
      ":(exclude)scripts/pii-scan.test.mjs",
      ":(exclude)privacy/pii-allowlist.json",
    ],
    // A merge commit stages the whole incoming branch, so the diff can
    // far exceed spawnSync's 1 MiB default buffer (ENOBUFS aborts the
    // hook and blocks the commit). 256 MiB clears any realistic merge.
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const findings = [];
  let path = "";
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      path = line.slice("+++ b/".length);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const added = line.slice(1);
      if (isOwnCopyrightHeaderLine(path, added)) {
        newLine += 1;
        continue;
      }
      findings.push(
        ...scanText(added, {
          path,
          scanNames: pathScansNames(path),
          allowSets,
        }).map((f) => ({ ...f, line: newLine })),
      );
      newLine += 1;
    } else if (!line.startsWith("-") && !line.startsWith("\\ No newline")) {
      newLine += 1;
    }
  }
  if (findings.length === 0) process.exit(0);
  report(findings, "staged diff");
  process.exit(2);
}

function safeRead(f) {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (process.env.OMNESIS_PII_SKIP === "1") process.exit(0);
  const args = process.argv.slice(2);
  if (args[0] === "--hook") runHook();
  else runCli(args);
}
