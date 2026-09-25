// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Draft staging for the Settings → Config editor.
 *
 * Field edits accumulate in a local working copy instead of reaching the
 * gateway immediately. Saving opens a review step that diffs the working
 * copy against the last committed config; confirming persists it. Leaving
 * the page drops the working copy without writing anything.
 *
 * Pure helpers (no DOM): applying RFC 7396 merge patches locally, diffing
 * two configs leaf-by-leaf, and rebuilding one combined merge patch from a
 * diff. The review list component lives here too so both the Structured
 * and the Raw JSON view render the same confirmation.
 */

// Display cap for a single diff value; keeps one huge list from dominating
// the review modal.
const MAX_DIFF_VALUE_LEN = 160;

function isPlainObject(x) {
  return (
    typeof x === "object" &&
    x !== null &&
    !Array.isArray(x) &&
    (Object.getPrototypeOf(x) === Object.prototype ||
      Object.getPrototypeOf(x) === null)
  );
}

// Own-property read. Plain `obj[key]` is fine when the key exists (own
// properties shadow the prototype chain), but `__proto__` needs the guard:
// without an own property the read would return the prototype instead of
// signalling absence. Record keys are user-controlled (source ids), so a
// literal `__proto__` key is possible — see buildPatch's test.
function ownGet(obj, key) {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

// Own-property write. Assigning `obj.__proto__ = value` on an object
// without that own property invokes the prototype setter and changes the
// prototype instead of storing the key, so define it explicitly.
function ownSet(obj, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    obj[key] = value;
  }
}

/**
 * Apply an RFC 7396 JSON Merge Patch to a target object, mirroring the
 * gateway's `applyMergePatch`: null deletes the key, plain objects merge
 * recursively, arrays and primitives replace wholesale. Returns a new
 * object; inputs are not mutated.
 */
export function applyMergePatchToDraft(target, patch) {
  if (!isPlainObject(patch)) return patch;
  const base = isPlainObject(target) ? { ...target } : {};
  for (const key of Object.keys(patch)) {
    const value = ownGet(patch, key);
    if (value === null) {
      delete base[key];
    } else {
      ownSet(base, key, applyMergePatchToDraft(ownGet(base, key), value));
    }
  }
  return base;
}

/** Order-insensitive deep equality for JSON values. Key order in a draft
 * can shift (delete then re-add moves a key to the end) without changing
 * meaning, so a stringify comparison would report phantom diffs. */
export function jsonEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.hasOwn(b, key) && jsonEqual(ownGet(a, key), ownGet(b, key)));
  }
  return false;
}

/**
 * Leaf-level diff of two configs. Each entry names a path plus the old
 * value (undefined = absent) and the new value (undefined = removed).
 * Objects recurse; arrays compare wholesale so a reorder or single-item
 * edit shows as one entry rather than index noise.
 */
export function diffConfigs(base, next, prefix = []) {
  const diffs = [];
  if (jsonEqual(base, next)) return diffs;
  if (isPlainObject(base) && isPlainObject(next)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
    for (const key of keys) {
      diffs.push(...diffConfigs(ownGet(base, key), ownGet(next, key), [...prefix, key]));
    }
    return diffs;
  }
  // An added or removed subtree expands to leaf entries against an empty
  // object, so highlighting, change counts, and patches all name exact
  // leaves — untouched siblings under a new section stay unmarked. (An
  // added empty object expands to nothing: it is a no-op everywhere.)
  if (base === undefined && isPlainObject(next)) {
    for (const key of Object.keys(next)) {
      diffs.push(...diffConfigs(undefined, ownGet(next, key), [...prefix, key]));
    }
    return diffs;
  }
  if (next === undefined && isPlainObject(base)) {
    for (const key of Object.keys(base)) {
      diffs.push(...diffConfigs(ownGet(base, key), undefined, [...prefix, key]));
    }
    return diffs;
  }
  return [{ path: prefix, oldValue: base, newValue: next }];
}

/** added | removed | changed for a diff entry. */
export function diffKind(entry) {
  if (entry.oldValue === undefined) return "added";
  if (entry.newValue === undefined) return "removed";
  return "changed";
}

/**
 * Rebuild one combined RFC 7396 merge patch from leaf diffs, so a batch
 * of staged edits persists as a single PATCH. Applying the result to the
 * diff's base reproduces the reviewed working copy exactly — with one
 * deliberate exception: under merge-patch semantics `null` deletes, so an
 * explicitly-added `null` leaf round-trips to an absent key rather than a
 * stored null. The config schema has no nullable leaves, so nothing is
 * lost; the raw PUT path preserves explicit nulls for anyone who needs
 * them. Root-level diffs (empty path — the whole document was replaced,
 * e.g. raw text that parses to an array) are not expressible as a merge
 * patch; callers must persist those with a full PUT instead.
 */
export function mergePatchFromDiffs(diffs) {
  const root = Object.create(null);
  for (const entry of diffs) {
    if (entry.path.length === 0) {
      throw new Error("mergePatchFromDiffs: root-level diffs need a full PUT, not a merge patch");
    }
    let cur = root;
    for (let i = 0; i < entry.path.length - 1; i++) {
      const seg = entry.path[i];
      if (!isPlainObject(ownGet(cur, seg))) ownSet(cur, seg, Object.create(null));
      cur = ownGet(cur, seg);
    }
    ownSet(cur, entry.path[entry.path.length - 1], entry.newValue === undefined ? null : entry.newValue);
  }
  return root;
}

/**
 * Parse raw editor text for the save flow: valid JSON adopts into the
 * draft, anything else keeps the last valid draft with Save disabled.
 */
export function parseRawText(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** JSON-pointer-style display path (`/sources/<id>/syncInterval`). */
export function formatDiffPath(path) {
  return "/" + path.map((seg) => String(seg).replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
}

const PATH_SEP = "\u0000";

function joinPath(path) {
  return path.map((seg) => String(seg)).join(PATH_SEP);
}

/**
 * Whether the leaf at `path` carries a pending change: a diff entry sits
 * exactly on it. Entries always name leaves (added/removed objects expand;
 * only wholesale array entries name a parent, matching that array's own
 * path). The upward prefix check is retained for safety. Drives the form's
 * modified-field highlighting; clearing the edit empties the diff, so the
 * highlight disappears with it.
 */
export function isDirtyPath(dirtyPaths, path) {
  const joined = joinPath(path);
  for (const dirty of dirtyPaths) {
    if (joined === dirty || joined.startsWith(dirty + PATH_SEP)) return true;
  }
  return false;
}

/** Build the dirty-path set for a working copy in one pass. */
export function dirtyPathsFor(base, draft) {
  if (!draft) return new Set();
  return new Set(diffConfigs(base, draft).map((entry) => joinPath(entry.path)));
}

/**
 * Canonical pretty JSON for the unified review diff: stable enough that
 * the only line changes are the staged edits, with the trailing newline
 * the raw file itself carries.
 */
export function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Compact display value; absent (added/removed side) renders as `—`. */
export function formatDiffValue(value) {
  if (value === undefined) return "—";
  const text = JSON.stringify(value) ?? String(value);
  return text.length > MAX_DIFF_VALUE_LEN ? `${text.slice(0, MAX_DIFF_VALUE_LEN - 3)}…` : text;
}

// Review rendering lives in the shared PrivacyPolicyDiff component (the
// same unified line diff the policy editor confirms with); this module
// keeps the draft math (diffs, dirty paths, canonical text, patches).
