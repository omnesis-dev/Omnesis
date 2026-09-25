// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A source's configuration, declared once.
 *
 * Setting up a source means collecting a few values from the operator: a vault
 * path, a list of folders to skip, a country, an API key. Today that fact is
 * written down four times — as a form field list for clients to render, as a
 * validator function, as a runtime cast where the factory reads it back, and
 * as whatever the CLI does to prompt for it. Nothing keeps the four in step,
 * and the failure is silent in a specific way: a source can read a setting no
 * form can produce, so the value exists in a hand-edited config file and
 * nowhere in the interface.
 *
 * ## One declaration, three derivations
 *
 * A schema is the single statement. From it come:
 *
 * - the **parsed type**, so `create()` receives `{ vaultPath: string; exclude:
 *   string[] }` instead of an untyped bag and a cast;
 * - the **form**, serialisable and sent to every client, so the CLI prompt and
 *   the portal field are the same declaration rendered twice;
 * - the **validator**, which runs at the same boundary in both, so a value the
 *   portal accepts is a value the source accepts.
 *
 * ## Serialisable means no functions
 *
 * The form crosses a wire to clients that must not run provider code. So a
 * field's constraints are data — a pattern, a range, a set of options — and
 * never a callback. Validation that genuinely needs the host's filesystem or
 * network stays where it already is: a source's own discovery and auth
 * lifecycle, which runs on the collector.
 *
 * ## Scope survives
 *
 * `source` and `member` scope are kept exactly as they were. A source-scoped
 * value is shared by every device hosting the source; a member-scoped one
 * describes one host's local environment. That distinction is the thing this
 * repository knows that generic form libraries do not, and it is why this is a
 * small purpose-built schema rather than a general one.
 */

/** Where a configured value belongs. */
export type ConfigScope = "source" | "member";

interface FieldCommon {
  /** Human-readable label shown in a form. */
  label: string;
  /** One-line help shown near the input. */
  help?: string;
  /** Placeholder text. */
  placeholder?: string;
  /** Whether the operator must supply it. Defaults to false. */
  required?: boolean;
  /**
   * Source-scoped values are shared by every member hosting the source;
   * member-scoped values describe one host's local environment. Defaults to
   * `"source"`.
   */
  scope?: ConfigScope;

  /**
   * Declared, but not asked for when a source is added.
   *
   * Some settings are escape hatches rather than setup questions: a filter
   * list, an override for a path the host normally detects, a value the
   * discovery step is about to compute anyway. Putting those on the add form
   * asks the operator a question they cannot answer yet, and asks it at the
   * only moment the form is ever shown.
   *
   * An advanced field is still parsed, validated and typed. It is simply not
   * part of the form, which is what makes declaring it strictly better than
   * leaving it undeclared and read through a cast.
   */
  advanced?: boolean;

  /**
   * A check the host runs that no data constraint can express.
   *
   * Declarative constraints cover the cases that recur — this path must exist,
   * this folder must contain that entry — and they are worth expressing as
   * data because they survive serialisation and can be explained to an
   * operator before anything runs. Some checks are genuinely source-specific:
   * one source's blank path means "find the database this Mac already has",
   * and whether that succeeds is a question only that source can answer.
   *
   * This is the escape hatch for those, and it is deliberately narrow. It runs
   * only on the host, is never serialised, and never reaches a client. Reach
   * for a declarative constraint first; use this when the answer depends on
   * knowledge the schema cannot hold.
   *
   * Returns an error message, or null when the value is acceptable.
   */
  check?: (value: string, probe: PathProbe) => string | null;

  /**
   * Run {@link check} even when the operator left the field blank.
   *
   * The case this exists for: an optional field whose blank value means "the
   * host works it out". Blank is then not the absence of an answer but a
   * particular answer, and it can be wrong — the thing to be detected may not
   * be there. Without this the operator adds the source, and finds out at the
   * first sync instead of at the field.
   */
  checkWhenEmpty?: boolean;
}

export interface StringField extends FieldCommon {
  kind: "string";
  default?: string;
  /** A serialisable constraint, applied by the host and by every client. */
  pattern?: string;
  /** Human-readable explanation of `pattern`, shown when it fails. */
  patternHint?: string;
  minLength?: number;
  maxLength?: number;
}

/**
 * A filesystem path.
 *
 * The value the operator typed is what gets stored, and the value the source
 * receives is that path resolved: a leading tilde expanded, a relative path
 * made absolute. Those are shell conventions rather than filesystem ones, so
 * something has to apply them, and the host is the only party that knows whose
 * home directory is meant.
 *
 * Doing it once, here, is what keeps the check and the source in agreement. A
 * source that resolved the value itself would be one forgotten call away from
 * a path its own host validated and it cannot open.
 */
export interface PathField extends FieldCommon {
  kind: "path";
  default?: string;
  /**
   * Require the path to exist, and to be of this kind.
   *
   * Checked by the host, which has the filesystem; a client cannot evaluate it
   * and is not asked to. This is what replaces the callback a hand-written
   * form field could carry: the constraint travels as data, and the check runs
   * where it can actually be answered.
   */
  mustExist?: "file" | "directory";
  /**
   * Require a child entry to exist inside the path, naming what the directory
   * has to be. `".obsidian"` is the difference between a vault and any folder.
   */
  mustContain?: string;
  /** What {@link mustContain} has to be. Defaults to a directory. */
  mustContainKind?: "file" | "directory";
  /**
   * What to say when {@link mustContain} is not there.
   *
   * Only that branch, because only that branch is a question about the
   * source's own domain: what makes this folder the thing it is. A path that
   * is missing, or is a file where a folder belongs, produces its own precise
   * message — a single hint covering every branch would tell an operator whose
   * external drive is unmounted that their folder is not a vault.
   */
  containsHint?: string;
  /**
   * The account this path speaks for, when a value that passes its checks is
   * itself proof the source is available on this host.
   *
   * Discovery answers "is this store here?" without being told where to look,
   * and for a store in a standard location that is the whole question. It is
   * not the whole question for a store the operator moved: discovery finds
   * nothing, and the operator has the one piece of information that settles
   * it — the path — with no way to offer it, because the form that would ask
   * is only shown for a source the host already believes is available.
   *
   * Naming an account here breaks that circle: a non-blank value that passes
   * validation stands in for discovery for that account. Only a member-scoped
   * path with a check can do this, since only a check that runs on this host
   * can tell a real store from a plausible string.
   */
  provesLocalAvailabilityForAccount?: string;
}

export interface NumberField extends FieldCommon {
  kind: "number";
  default?: number;
  min?: number;
  max?: number;
  /** Reject a non-integer value. */
  integer?: boolean;
}

export interface BooleanField extends FieldCommon {
  kind: "boolean";
  default?: boolean;
}

export interface SelectField<T extends string = string> extends FieldCommon {
  kind: "select";
  options: ReadonlyArray<{ value: T; label: string }>;
  default?: T;
}

export interface SecretField extends FieldCommon {
  kind: "secret";
  /**
   * A shape check, applied like a string field's.
   *
   * Carrying it on a secret is safe and useful: the pattern describes the
   * form of the value, not the value, and it is what lets a client say "that
   * is not a token from this platform" before the operator waits for a probe
   * to say the same thing more slowly.
   */
  pattern?: string;
  /** Human-readable explanation of `pattern`, shown when it fails. */
  patternHint?: string;
  /**
   * A secret is never rendered back to a client and never logged. It is
   * declared here so a form knows to mask it and so the host knows not to
   * echo it, not so it can be stored alongside ordinary settings.
   */
  minLength?: number;
}

export interface ListField<E extends ConfigField = ConfigField> extends FieldCommon {
  kind: "list";
  /** The shape of each element. */
  of: E;
  default?: unknown[];
  maxItems?: number;
  /** Text input delimiters. Paths default to newlines; other lists also accept commas. */
  separator?: "newline" | "comma-or-newline";
}

export type ConfigField =
  | StringField
  | PathField
  | NumberField
  | BooleanField
  | SelectField
  | SecretField
  | ListField;

/** The parsed type a field yields. */
type FieldValue<F> = F extends { kind: "string" }
  ? string
  : F extends { kind: "path" }
    ? string
    : F extends { kind: "number" }
      ? number
      : F extends { kind: "boolean" }
        ? boolean
        : F extends SelectField<infer T>
          ? T
          : F extends { kind: "secret" }
            ? string
            : F extends ListField<infer E>
              ? FieldValue<E>[]
              : never;

/**
 * Whether a field is optional in the parsed type.
 *
 * A field with a default is always present after parsing, whether or not the
 * operator supplied it — that is what a default is for. A required field is
 * present because parsing fails otherwise. Everything else may be absent.
 */
type IsPresent<F> = F extends { required: true }
  ? true
  : F extends { default: unknown }
    ? true
    : false;

/** The object type a schema parses into. */
export type InferConfig<S extends Record<string, ConfigField>> = {
  [K in keyof S as IsPresent<S[K]> extends true ? K : never]: FieldValue<S[K]>;
} & {
  [K in keyof S as IsPresent<S[K]> extends true ? never : K]?: FieldValue<S[K]>;
};

/** One thing wrong with a supplied configuration. */
export interface ConfigIssue {
  /** The field's key, or "" for a whole-object problem. */
  field: string;
  message: string;
}

export type ConfigParseResult<T> = { ok: true; value: T } | { ok: false; issues: ConfigIssue[] };

/** A source's configuration declaration. */
export interface ConfigSchema<S extends Record<string, ConfigField> = Record<string, ConfigField>> {
  readonly fields: S;
  /** Validate and coerce a stored or submitted configuration. */
  parse(raw: unknown): ConfigParseResult<InferConfig<S>>;
}

// ── Field constructors ──────────────────────────────────────────────────────
// Thin by design: each returns the declaration itself, so a schema is data all
// the way down and can be serialised without a build step.

// Each constructor is generic in what it was handed, with a `const` type
// parameter, so `required: true` and a supplied `default` survive as literal
// facts rather than widening to `boolean` and `unknown | undefined`. That is
// what lets `InferConfig` tell a key that is always present from one that may
// be absent; without it every key would be optional and the parsed type would
// be no better than the bag it replaces.

export const string = <const F extends Omit<StringField, "kind">>(f: F) =>
  ({ ...f, kind: "string" }) as F & { kind: "string" };
export const path = <const F extends Omit<PathField, "kind">>(f: F) =>
  ({ ...f, kind: "path" }) as F & { kind: "path" };
export const number = <const F extends Omit<NumberField, "kind">>(f: F) =>
  ({ ...f, kind: "number" }) as F & { kind: "number" };
export const boolean = <const F extends Omit<BooleanField, "kind">>(f: F) =>
  ({ ...f, kind: "boolean" }) as F & { kind: "boolean" };
export const secret = <const F extends Omit<SecretField, "kind">>(f: F) =>
  ({ ...f, kind: "secret" }) as F & { kind: "secret" };
export const select = <const F extends Omit<SelectField, "kind">>(f: F) =>
  ({ ...f, kind: "select" }) as F & { kind: "select" };
export const list = <
  const E extends ConfigField,
  const F extends Omit<ListField<E>, "kind" | "of">,
>(
  of: E,
  f: F,
) => ({ ...f, of, kind: "list" }) as F & { of: E; kind: "list" };

function parseField(
  field: ConfigField,
  key: string,
  raw: unknown,
  issues: ConfigIssue[],
  useDefault = true,
): unknown {
  const bad = (message: string): undefined => {
    issues.push({ field: key, message });
    return undefined;
  };
  const supplied =
    raw !== undefined &&
    raw !== null &&
    (!useDefault || typeof raw !== "string" || raw.trim() !== "");

  if (!supplied) {
    if (useDefault && "default" in field && field.default !== undefined)
      return parseField(field, key, field.default, issues, false);
    if (field.required) return bad(`${field.label} is required`);
    return undefined;
  }

  switch (field.kind) {
    case "string":
    case "path":
    case "secret": {
      if (typeof raw !== "string") return bad(`${field.label} must be text`);
      if ("minLength" in field && field.minLength !== undefined && raw.length < field.minLength) {
        return bad(`${field.label} must be at least ${field.minLength} characters`);
      }
      if ("maxLength" in field && field.maxLength !== undefined && raw.length > field.maxLength) {
        return bad(`${field.label} must be at most ${field.maxLength} characters`);
      }
      if ((field.kind === "string" || field.kind === "secret") && field.pattern) {
        let re: RegExp;
        try {
          re = new RegExp(field.pattern);
        } catch {
          // A malformed pattern is the source author's bug, not the operator's.
          // Reporting it against the field is how it reaches someone who can
          // act on it rather than silently accepting every value.
          return bad(`${field.label} has an invalid pattern in its declaration`);
        }
        if (!re.test(raw)) {
          return bad(field.patternHint ?? `${field.label} does not match the expected format`);
        }
      }
      return raw;
    }
    case "number": {
      if (typeof raw !== "number" && typeof raw !== "string")
        return bad(`${field.label} must be a number`);
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) return bad(`${field.label} must be a number`);
      if (field.integer && !Number.isInteger(n))
        return bad(`${field.label} must be a whole number`);
      if (field.min !== undefined && n < field.min)
        return bad(`${field.label} must be at least ${field.min}`);
      if (field.max !== undefined && n > field.max)
        return bad(`${field.label} must be at most ${field.max}`);
      return n;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      // A config file is hand-edited and a form posts strings, so the common
      // textual spellings are accepted rather than rejected on a technicality.
      if (raw === "true" || raw === "1") return true;
      if (raw === "false" || raw === "0") return false;
      return bad(`${field.label} must be true or false`);
    }
    case "select": {
      if (typeof raw !== "string" || !field.options.some((o) => o.value === raw)) {
        return bad(
          `${field.label} must be one of: ${field.options.map((o) => o.value).join(", ")}`,
        );
      }
      return raw;
    }
    case "list": {
      // A stored param is a string and every client posts one, so a list has
      // to accept its delimited form or it is declarable and unsettable —
      // and, since a failed parse skips the source, unsettable in a way that
      // is worse than not declaring it. Same principle as the numeric and
      // boolean coercions: the operator's channel is text.
      if (typeof raw === "string") {
        // A list of paths splits on newlines only: a comma is a legal
        // character in a filename on every platform this runs on, so treating
        // it as a separator would turn one real directory into two that do
        // not exist.
        const separator =
          (field.separator ?? (field.of.kind === "path" ? "newline" : "comma-or-newline")) ===
          "newline"
            ? /\n/
            : /[\n,]/;
        raw = raw
          .split(separator)
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
      }
      if (!Array.isArray(raw)) return bad(`${field.label} must be a list`);
      if (field.maxItems !== undefined && raw.length > field.maxItems) {
        return bad(`${field.label} may have at most ${field.maxItems} entries`);
      }
      const out: unknown[] = [];
      for (const [i, element] of raw.entries()) {
        const before = issues.length;
        const parsed = parseField({ ...field.of, required: true }, `${key}[${i}]`, element, issues);
        if (issues.length === before) out.push(parsed);
      }
      return out;
    }
  }
}

/**
 * Declare a source's configuration.
 *
 * @example
 * ```typescript
 * config: object({
 *   vaultPath: path({ label: "Vault path", required: true, scope: "member" }),
 *   exclude: list(string({ label: "Pattern" }), { label: "Exclude", default: [] }),
 * })
 * ```
 */
export function object<S extends Record<string, ConfigField>>(fields: S): ConfigSchema<S> {
  for (const [key, field] of Object.entries(fields)) validateFieldDeclaration(field, key);
  return {
    fields,
    parse(raw: unknown): ConfigParseResult<InferConfig<S>> {
      if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
        return { ok: false, issues: [{ field: "", message: "configuration must be an object" }] };
      }
      const input = (raw ?? {}) as Record<string, unknown>;
      const issues: ConfigIssue[] = [];
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(fields)) {
        const value = parseField(field, key, input[key], issues);
        if (value !== undefined) out[key] = value;
      }
      if (issues.length > 0) return { ok: false, issues };
      return { ok: true, value: out as InferConfig<S> };
    },
  };
}

function validateFieldDeclaration(field: ConfigField, key: string): void {
  if ((field.kind === "string" || field.kind === "secret") && field.pattern !== undefined) {
    try {
      new RegExp(field.pattern);
    } catch {
      throw new Error(`${key}: invalid pattern in its declaration`);
    }
  }
  if (field.kind === "list") validateFieldDeclaration(field.of, `${key}[]`);
  if (!("default" in field) || field.default === undefined) return;
  validateDefaultType(field, key, field.default);
  const issues: ConfigIssue[] = [];
  parseField(field, key, field.default, issues, false);
  if (issues.length)
    throw new Error(`Invalid configuration default: ${formatConfigIssues(issues)}`);
}

function validateDefaultType(field: ConfigField, key: string, value: unknown): void {
  const expectedType = field.kind === "number" || field.kind === "boolean" ? field.kind : "string";
  const wrongType = field.kind === "list" ? !Array.isArray(value) : typeof value !== expectedType;
  if (wrongType) throw new Error(`${key}: default does not match the declared field type`);
  if (field.kind === "list" && Array.isArray(value)) {
    value.forEach((entry, index) => validateDefaultType(field.of, `${key}[${index}]`, entry));
  }
}

/** Render a parse failure as one line, for a log or a CLI. */
export function formatConfigIssues(issues: readonly ConfigIssue[]): string {
  return issues.map((i) => (i.field ? `${i.field}: ${i.message}` : i.message)).join("; ");
}

/**
 * Compile a schema into the form descriptor clients already render.
 *
 * The bridge that makes this additive: every existing client keeps receiving
 * the shape it knows, derived from the schema rather than written a second
 * time by hand. Fields the old shape cannot express are carried as faithfully
 * as it allows — a list becomes a text field whose help says what it holds, a
 * number becomes a text field with a numeric hint — because a client that
 * cannot render a field must still let an operator see that it exists.
 */
/**
 * Form fields this module derived, rather than a source author writing them.
 *
 * A definition carries both its schema and the form derived from it, so
 * spreading one definition into another — which is how the synthetic doubles
 * are built — hands the second one a `params` it never wrote. Without a way to
 * tell the two apart, the rule that a source may not state the same fact twice
 * would fire on a source that stated it once.
 *
 * A set of references rather than a property on the array, so nothing about
 * the derived form changes shape or crosses a wire differently.
 */
const derivedParams = new WeakSet<object>();

/** Whether a form field list came from a schema rather than from an author. */
export function isDerivedFromSchema(params: unknown): boolean {
  return typeof params === "object" && params !== null && derivedParams.has(params);
}

export function toSourceParams(
  schema: ConfigSchema,
  probe?: PathProbe,
  opts?: {
    /**
     * Include fields marked advanced.
     *
     * "Advanced" is a property of a settings *form*, which has a disclosure
     * section to put them behind. A challenge has none: it is one question, and
     * every field in it is one the operator has to answer before the flow moves
     * on. Filtering them there produced a form missing a field the answer is
     * then rejected for lacking — three times, and then a failure whose message
     * names a field the operator was never shown.
     */
    includeAdvanced?: boolean;
  },
): Array<{
  name: string;
  label: string;
  type: "string" | "path" | "select" | "secret";
  scope?: ConfigScope;
  required?: boolean;
  placeholder?: string;
  help?: string;
  pattern?: string;
  patternHint?: string;
  options?: Array<{ value: string; label: string }>;
  validate?: (value: string) => string | null;
  validateWhenEmpty?: boolean;
  provesLocalAvailabilityForAccount?: string;
}> {
  const params = Object.entries(schema.fields)
    .filter(([, field]) => opts?.includeAdvanced || !field.advanced)
    .map(([name, field]) => {
      const validate = probe ? fieldValidator(schema, name, probe) : undefined;
      const base = {
        name,
        label: field.label,
        scope: field.scope,
        required: field.required,
        placeholder: field.placeholder ?? hintFor(field),
        help: field.help,
        // Carried so a form can tell the operator the path is wrong while they
        // are still looking at it. Without it the same constraint still holds,
        // but only at the moment the source is created, which is after the
        // form has closed.
        ...(validate ? { validate } : {}),
        ...(field.checkWhenEmpty ? { validateWhenEmpty: true } : {}),
      };
      if (field.kind === "path") {
        return {
          ...base,
          type: "path" as const,
          ...(field.provesLocalAvailabilityForAccount
            ? { provesLocalAvailabilityForAccount: field.provesLocalAvailabilityForAccount }
            : {}),
        };
      }
      // Carried, not collapsed: a client has to know to mask the input, and
      // the shape check has to travel so it can say "that is not a token from
      // this platform" without waiting for a probe to say it more slowly.
      if (field.kind === "secret") {
        return {
          ...base,
          type: "secret" as const,
          ...(field.pattern ? { pattern: field.pattern } : {}),
          ...(field.patternHint ? { patternHint: field.patternHint } : {}),
        };
      }
      if (field.kind === "select") {
        return { ...base, type: "select" as const, options: [...field.options] };
      }
      if (field.kind === "string" && (field.pattern || field.patternHint)) {
        return {
          ...base,
          type: "string" as const,
          ...(field.pattern ? { pattern: field.pattern } : {}),
          ...(field.patternHint ? { patternHint: field.patternHint } : {}),
        };
      }
      if (field.kind === "boolean") {
        return {
          ...base,
          type: "select" as const,
          options: [
            { value: "true", label: "Yes" },
            { value: "false", label: "No" },
          ],
        };
      }
      return { ...base, type: "string" as const };
    });
  derivedParams.add(params);
  return params;
}

function hintFor(field: ConfigField): string | undefined {
  switch (field.kind) {
    case "list":
      return `One ${field.of.label.toLowerCase()} per line`;
    case "number":
      return field.min !== undefined && field.max !== undefined
        ? `${field.min} to ${field.max}`
        : "A number";
    case "secret":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * The filesystem a path constraint is checked against.
 *
 * Injected rather than imported so this module stays free of node built-ins —
 * it is also loaded by clients, which must not touch a filesystem — and so a
 * test can drive every branch without making files.
 */
export interface PathProbe {
  /**
   * Turn what the operator typed into a path the filesystem understands.
   *
   * An operator types `~/.config/thing`, and the tilde is a shell convention
   * the filesystem knows nothing about. Expanding it is the host's job because
   * only the host knows whose home directory is meant — which is also why the
   * stored value keeps the form the operator typed, and expansion happens here
   * rather than during parsing.
   */
  resolve(path: string): string;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  /**
   * Whether the running process can read the path — for a folder, list and
   * enter it. A path can exist and be the right kind yet be closed to the
   * process, and a source handed one only discovers that on its first scan.
   * A probe that cannot tell leaves this out, and the check is skipped.
   */
  readable?(path: string): boolean;
  join(...parts: string[]): string;
}

/**
 * Everything about a configuration only the host can decide.
 *
 * Separate from `parse` because `parse` is pure and runs everywhere, including
 * in a client that has no business touching a disk. This runs only on the
 * host, which is exactly where the callbacks it replaces used to run.
 *
 * The point of moving a constraint into data is that it survives the trip: a
 * hand-written validator was a function, so it could never be serialised, and
 * a schema that could only describe shape would have silently dropped the
 * check that distinguishes a vault from any folder. What genuinely cannot be
 * expressed as data stays a function, and stays here.
 */
export function hostConfigIssues(
  schema: ConfigSchema,
  value: Record<string, unknown>,
  probe: PathProbe,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const [key, field] of Object.entries(schema.fields)) {
    collectHostIssues(field, key, value[key], probe, issues);
  }
  return issues;
}

function collectHostIssues(
  field: ConfigField,
  key: string,
  value: unknown,
  probe: PathProbe,
  issues: ConfigIssue[],
): void {
  if (field.kind === "list" && Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectHostIssues(field.of, `${key}[${index}]`, entry, probe, issues),
    );
  }
  const text =
    value === undefined || value === null
      ? ""
      : Array.isArray(value)
        ? value.join("\n")
        : String(value);
  const message = fieldIssue(field, text, probe);
  if (message) issues.push({ field: key, message });
}

/**
 * Resolve every declared path in a parsed configuration.
 *
 * Applied by the host after parsing and before the value reaches a source, so
 * that what a source is handed is exactly what its own host checked. The
 * stored value is untouched: it keeps the form the operator typed, which is
 * the form they will recognise when they come back to change it.
 *
 * The alternative is every source resolving its own paths, which is one
 * forgotten call away from a source that cannot open a path its host has just
 * confirmed exists.
 */
export function resolveDeclaredPaths(
  schema: ConfigSchema,
  value: Record<string, unknown>,
  probe: PathProbe,
): Record<string, unknown> {
  const out = { ...value };
  for (const [key, field] of Object.entries(schema.fields)) {
    const raw = out[key];
    if (field.kind === "path") {
      if (typeof raw !== "string" || raw.trim() === "") continue;
      out[key] = probe.resolve(raw);
      continue;
    }
    // A list of paths gets the same treatment element by element. Without it
    // a multi-root source is handed the tildes and relative paths the
    // operator typed, and resolving them itself is the duplication this
    // function exists to remove.
    if (field.kind === "list" && field.of.kind === "path" && Array.isArray(raw)) {
      out[key] = raw.map((entry) =>
        typeof entry === "string" && entry.trim() !== "" ? probe.resolve(entry) : entry,
      );
    }
  }
  return out;
}

/**
 * The host-side check for one field, or undefined when it has none.
 *
 * A form asks the operator for a value and can tell them it is wrong while
 * they are still looking at the field. That only works if the check can be
 * run against one field on its own, which is what this returns; the whole-
 * object pass exists for the moment a source is actually created, when there
 * is no operator watching.
 */
export function fieldValidator(
  schema: ConfigSchema,
  key: string,
  probe: PathProbe,
): ((value: string) => string | null) | undefined {
  const field = schema.fields[key];
  if (!field || !hasHostCheck(field)) return undefined;
  return (value: string) => {
    // Requiredness is checked on submission, not while a form is still blank.
    if (value.trim() === "") return fieldIssue(field, value, probe);
    const issues: ConfigIssue[] = [];
    const parsed = parseField(field, key, value, issues);
    if (!issues.length) collectHostIssues(field, key, parsed, probe, issues);
    return issues[0]?.message ?? null;
  };
}

function hasHostCheck(field: ConfigField): boolean {
  if (field.check) return true;
  if (field.kind === "list") return hasHostCheck(field.of);
  return (
    field.kind === "path" && (field.mustExist !== undefined || field.mustContain !== undefined)
  );
}

function fieldIssue(field: ConfigField, value: string, probe: PathProbe): string | null {
  if (value.trim() === "") {
    // A blank optional field is a non-answer, and there is nothing to check
    // against — unless the source has said blank is itself an answer.
    //
    // Whitespace is blank. A form posts what the operator typed and a config
    // file is hand-edited, so a field holding a space is the same gesture as
    // one holding nothing; treating it as a value makes the host refuse a
    // configuration that every consumer of it would have read as unset.
    return field.check && field.checkWhenEmpty ? field.check(value, probe) : null;
  }

  if (field.kind === "path") {
    const resolved = probe.resolve(value);
    if (field.mustExist) {
      if (!probe.exists(resolved)) return `${field.label} does not exist: ${value}`;
      const isDir = probe.isDirectory(resolved);
      if (field.mustExist === "directory" && !isDir) {
        return `${field.label} must be a folder: ${value}`;
      }
      if (field.mustExist === "file" && isDir) return `${field.label} must be a file: ${value}`;
      if (probe.readable && !probe.readable(resolved)) {
        return `${field.label} cannot be read: ${value}`;
      }
    }
    if (field.mustContain) {
      const child = probe.join(resolved, field.mustContain);
      const wantedDirectory = (field.mustContainKind ?? "directory") === "directory";
      // Existence alone is not enough: a plain file sharing the marker's name
      // would otherwise pass for the directory the source is looking for.
      const present = probe.exists(child) && probe.isDirectory(child) === wantedDirectory;
      if (!present) {
        return (
          field.containsHint ?? `${field.label} does not contain ${field.mustContain}: ${value}`
        );
      }
    }
  }

  return field.check ? field.check(value, probe) : null;
}
