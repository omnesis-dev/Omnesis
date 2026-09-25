// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Schema introspection for the portal's `/config` page.
 *
 * The structured config form is no longer hand-authored field-by-field —
 * it is *generated* from `omnesisConfigSchema`. `describeConfigSchema()`
 * walks the zod tree and emits a `ConfigNode` tree (objects, records, and
 * typed leaves with their constraints + `.describe()` hints). The gateway
 * serves this over `GET /admin/config/schema`; the browser renders it
 * generically.
 *
 * Consequence: any new knob added to the schema appears in the portal
 * automatically, with zero UI code change — unless it is explicitly
 * declared as owned by another portal page (see
 * `CONFIG_PATHS_OWNED_ELSEWHERE`). The drift test in
 * `config-describe.test.ts` is the safety net that forces every new leaf
 * to be consciously categorised (rendered vs. owned-elsewhere).
 */

import { z } from "zod";
import { omnesisConfigSchema, durationRegex } from "./config-schema.js";
import { configDefaultAt, configUnsetDescriptionAt } from "./config-defaults.js";

// ─────────────────────────────────────────────────────────────────────────
// Descriptor tree
// ─────────────────────────────────────────────────────────────────────────

/** Renderable leaf kinds. Records (dynamic keys) are `ConfigRecordNode`. */
export type ConfigLeafKind = "string" | "duration" | "number" | "boolean" | "enum" | "stringArray";

export interface ConfigConstraints {
  /** Integer-only (renders step=1). */
  int?: boolean;
  /** Inclusive lower bound. */
  min?: number;
  /** Exclusive lower bound (e.g. `.positive()` => 0). */
  exclusiveMin?: number;
  /** Inclusive upper bound. */
  max?: number;
}

/** Set when a node (and its subtree) is edited on another portal page. */
export interface ConfigOwnership {
  /** Human label for where this is configured instead (e.g. "Models"). */
  page: string;
  /** Why it lives there — surfaced to the user as a note. */
  reason: string;
}

interface ConfigNodeBase {
  /** Object key for this node; `"*"` for a record's value template. Absent at the root. */
  key?: string;
  /** Path segments from the root; `"*"` marks a record key slot. */
  path: string[];
  /** Short UI hint, sourced from the field's zod `.describe()`. */
  description?: string;
  /** Present iff this subtree is owned by another portal page/flow. */
  ownedBy?: ConfigOwnership;
}

export interface ConfigObjectNode extends ConfigNodeBase {
  kind: "object";
  children: ConfigNode[];
}

export interface ConfigRecordNode extends ConfigNodeBase {
  kind: "record";
  /** Shape of each dynamic-keyed value. */
  value: ConfigNode;
}

export interface ConfigLeafNode extends ConfigNodeBase {
  kind: ConfigLeafKind;
  constraints?: ConfigConstraints;
  /** Allowed values when `kind === "enum"`. */
  options?: string[];
  /**
   * Effective default applied at runtime when this knob is unset, from
   * `CONFIG_DEFAULTS`. Lets the form show what "unset" actually does (and a
   * boolean's true on/off default). Absent for knobs with no static default.
   */
  default?: unknown;
  /** Meaning of absence when there is no single literal default. */
  unsetDescription?: string;
}

export type ConfigNode = ConfigObjectNode | ConfigRecordNode | ConfigLeafNode;

// ─────────────────────────────────────────────────────────────────────────
// Ownership registry — config paths edited on another portal page/flow.
//
// A node whose path matches one of these is NOT rendered by the structured
// form (it carries `ownedBy` so the page can show a "configured on X" note
// and the drift test knows it's intentionally excluded). `"*"` matches any
// single record-key segment. Keep this list tight: every entry must match a
// real schema path (the drift test fails on stale entries).
// ─────────────────────────────────────────────────────────────────────────

interface OwnershipEntry extends ConfigOwnership {
  /** Path to the owned node, `"*"` matching any record key. */
  path: string[];
}

export const CONFIG_PATHS_OWNED_ELSEWHERE: readonly OwnershipEntry[] = [
  {
    path: ["inference"],
    page: "Models",
    reason: "Model selection and inference backends are managed on the Models tab.",
  },
  {
    path: ["sources", "*", "params"],
    page: "Sources",
    reason: "Per-source connection parameters are edited on the Sources page.",
  },
  {
    path: ["agent", "replay"],
    page: "Debug",
    reason: "Agent replay fixtures are a debug/eval concern, not a normal setting.",
  },
  {
    path: ["brain", "sweeps"],
    page: "Sweeps",
    reason:
      "Sweeps are edited on the Sweeps tab, which writes them as files under the config directory. Entries here are converted to files once and then ignored.",
  },
  {
    path: ["gateway", "apns"],
    page: "Raw JSON",
    reason:
      "APNs push credentials are set via the Raw JSON editor / config file, not the structured form.",
  },
  {
    path: ["gateway", "fcm"],
    page: "Raw JSON",
    reason:
      "FCM push credentials are set via the Raw JSON editor / config file, not the structured form.",
  },
];

function matchOwnership(path: string[]): ConfigOwnership | undefined {
  for (const entry of CONFIG_PATHS_OWNED_ELSEWHERE) {
    if (entry.path.length !== path.length) continue;
    if (entry.path.every((seg, i) => seg === "*" || seg === path[i])) {
      return { page: entry.page, reason: entry.reason };
    }
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────
// Walker
// ─────────────────────────────────────────────────────────────────────────

type ZodAny = z.ZodTypeAny;
type ZodObjectShape = Record<string, ZodAny>;

interface ZodDef {
  type?: string;
  typeName?: string;
  description?: string;
  checks?: unknown[];
  innerType?: ZodAny;
  schema?: ZodAny;
  in?: ZodAny;
  out?: ZodAny;
  entries?: Record<string, unknown>;
  values?: readonly unknown[];
  valueType?: ZodAny;
}

function defOf(schema: ZodAny): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function kindOf(schema: ZodAny): string | undefined {
  const def = defOf(schema);
  return def.typeName ?? def.type;
}

function descriptionOf(schema: ZodAny, def = defOf(schema)): string | undefined {
  return def.description ?? (schema as unknown as { description?: string }).description;
}

function checkDef(check: unknown): Record<string, unknown> {
  return (
    (check as { _zod?: { def?: Record<string, unknown> } })._zod?.def ??
    (check as Record<string, unknown>)
  );
}

/** Peel optional/nullable/default/effects wrappers, keeping the outermost description. */
function unwrap(schema: ZodAny): { inner: ZodAny; description?: string } {
  let cur = schema;
  let description: string | undefined;
  for (;;) {
    const def = defOf(cur);
    const desc = descriptionOf(cur, def);
    if (description === undefined && desc) description = desc;
    const kind = kindOf(cur);
    if (
      kind === "ZodOptional" ||
      kind === "optional" ||
      kind === "ZodNullable" ||
      kind === "nullable"
    ) {
      cur = def.innerType ?? (cur as z.ZodOptional<ZodAny>).unwrap();
      continue;
    }
    if (kind === "ZodDefault" || kind === "default") {
      cur = def.innerType ?? (cur as z.ZodDefault<ZodAny>).removeDefault();
      continue;
    }
    if (kind === "ZodEffects") {
      cur = def.schema ?? cur;
      continue;
    }
    if (kind === "pipe" || kind === "ZodPipeline") {
      const inputKind = def.in ? kindOf(def.in) : undefined;
      if ((inputKind === "transform" || inputKind === "ZodTransform") && def.out) cur = def.out;
      else if (def.in) cur = def.in;
      else break;
      continue;
    }
    break;
  }
  return { inner: cur, description };
}

function numberConstraints(schema: z.ZodNumber): ConfigConstraints | undefined {
  const checks = defOf(schema).checks ?? [];
  const out: ConfigConstraints = {};
  for (const c of checks) {
    const check = checkDef(c);
    if (check.kind === "int" || check.format === "safeint") out.int = true;
    else if (check.kind === "min" && typeof check.value === "number") {
      if (check.inclusive) out.min = check.value;
      else out.exclusiveMin = check.value;
    } else if (check.check === "greater_than" && typeof check.value === "number") {
      if (check.inclusive) out.min = check.value;
      else out.exclusiveMin = check.value;
    } else if (check.kind === "max" && typeof check.value === "number") {
      // Only inclusive upper bounds are modeled (every `.max()` in the schema
      // is inclusive). An exclusive `.lt(n)` would land here too and be
      // surfaced as inclusive — add an `exclusiveMax` split here if one is
      // ever introduced.
      out.max = check.value;
    } else if (check.check === "less_than" && typeof check.value === "number") {
      out.max = check.value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function isDurationString(schema: z.ZodString): boolean {
  const checks = defOf(schema).checks ?? [];
  return checks.some((c) => {
    const check = checkDef(c);
    return (
      (check.kind === "regex" &&
        check.regex instanceof RegExp &&
        check.regex.source === durationRegex.source) ||
      (check.check === "string_format" &&
        check.format === "regex" &&
        check.pattern instanceof RegExp &&
        check.pattern.source === durationRegex.source)
    );
  });
}

/** Classify a leaf zod type into a renderable kind (+ extras). */
function leaf(inner: ZodAny): Pick<ConfigLeafNode, "kind" | "constraints" | "options"> {
  if (inner instanceof z.ZodString) {
    return { kind: isDurationString(inner) ? "duration" : "string" };
  }
  if (inner instanceof z.ZodNumber) {
    return { kind: "number", constraints: numberConstraints(inner) };
  }
  if (inner instanceof z.ZodBoolean) return { kind: "boolean" };
  if (inner instanceof z.ZodEnum) {
    const def = defOf(inner);
    const values = def.values ?? Object.values(def.entries ?? {});
    return { kind: "enum", options: values.map(String) };
  }
  // Every array in the schema is `z.array(z.string())`, rendered as a
  // one-per-line textarea. A non-string element array would need its own kind.
  if (inner instanceof z.ZodArray) return { kind: "stringArray" };
  // Literals and unions only occur under `inference.*` (the assignment-slot
  // `string | null` shape), which is an owned subtree and never walked to a
  // leaf in practice. They map to free text so that un-owning that subtree
  // degrades gracefully rather than throwing.
  if (inner instanceof z.ZodLiteral) return { kind: "string" };
  if (inner instanceof z.ZodUnion) return { kind: "string" };
  // Any other zod kind is unmodeled: throw rather than silently rendering a
  // wrong widget. This turns "someone added a knob of a new kind in a
  // non-owned subtree" into a hard failure (gateway boot + the drift test),
  // preserving the guarantee that no knob renders as the wrong control.
  const typeName =
    (inner as unknown as { _def?: { typeName?: string; type?: string } })._def?.typeName ??
    (inner as unknown as { _def?: { type?: string } })._def?.type ??
    "unknown";
  throw new Error(
    `config-describe: unhandled zod kind "${typeName}" — add a ConfigLeafKind for it`,
  );
}

function walk(schema: ZodAny, path: string[], key?: string): ConfigNode {
  const { inner, description } = unwrap(schema);
  const ownedBy = path.length > 0 ? matchOwnership(path) : undefined;
  const base = { key, path, description, ownedBy };

  // Owned subtrees are truncated — the renderer skips them, the drift test
  // records the boundary path. No need to descend into their internals.
  if (ownedBy) {
    if (inner instanceof z.ZodObject || inner instanceof z.ZodRecord) {
      return { ...base, kind: "object", children: [] };
    }
    return { ...base, ...leaf(inner) };
  }

  if (inner instanceof z.ZodObject) {
    const shape = (inner as unknown as { shape: ZodObjectShape }).shape;
    const children = Object.entries(shape).map(([k, v]) => walk(v as ZodAny, [...path, k], k));
    return { ...base, kind: "object", children };
  }

  if (inner instanceof z.ZodRecord) {
    const valueType = (inner as unknown as { _def: { valueType: ZodAny } })._def.valueType;
    return { ...base, kind: "record", value: walk(valueType, [...path, "*"], "*") };
  }

  // Rendered leaf: attach its effective literal default, or a description of
  // its contextual unset behavior. Record-template leaves carry a `*`
  // segment, which `configDefaultAt` never matches, so they use the latter.
  const def = configDefaultAt(path);
  const unsetDescription = configUnsetDescriptionAt(path);
  const leafNode: ConfigLeafNode = { ...base, ...leaf(inner) };
  if (def !== undefined) leafNode.default = def;
  if (unsetDescription !== undefined) leafNode.unsetDescription = unsetDescription;
  return leafNode;
}

/** Build the descriptor tree for the whole config schema (root is an object node). */
export function describeConfigSchema(): ConfigObjectNode {
  return walk(omnesisConfigSchema, []) as ConfigObjectNode;
}

// ─────────────────────────────────────────────────────────────────────────
// Flatten — used by the drift test and any consumer that wants leaf paths.
// ─────────────────────────────────────────────────────────────────────────

export interface FlatConfigEntry {
  /** RFC-6901-ish pointer where a star marks a record-key slot, e.g. "/sources/STAR/syncInterval". */
  path: string;
  kind: ConfigNode["kind"];
  /** Page name when owned elsewhere; absent when rendered by /config. */
  ownedBy?: string;
}

function pointer(path: string[]): string {
  return path.length === 0 ? "" : "/" + path.join("/");
}

/** Depth-first list of every terminal node: rendered leaves + owned boundaries. */
export function flattenConfigNodes(node: ConfigNode = describeConfigSchema()): FlatConfigEntry[] {
  const out: FlatConfigEntry[] = [];
  const visit = (n: ConfigNode): void => {
    if (n.ownedBy) {
      out.push({ path: pointer(n.path), kind: n.kind, ownedBy: n.ownedBy.page });
      return;
    }
    if (n.kind === "object") {
      for (const child of n.children) visit(child);
      return;
    }
    if (n.kind === "record") {
      visit(n.value);
      return;
    }
    out.push({ path: pointer(n.path), kind: n.kind });
  };
  visit(node);
  return out;
}
