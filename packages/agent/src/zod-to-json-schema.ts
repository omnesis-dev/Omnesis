// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Minimal zod → JSON schema converter, scoped to the shapes the tool
 * registry actually uses (objects with string/number/boolean/enum/array/
 * optional/describe).
 *
 * We don't pull in `zod-to-json-schema` because the surface we need is
 * ~80 lines and the dep would pull in a few hundred KB of features (refs,
 * unions, recursive schemas, etc.) we don't use. Tool schemas should be
 * flat object shapes; if a future tool needs anything fancier, expand
 * this converter rather than hide a dep behind a single use.
 */

import { z } from "zod";

interface JsonSchema {
  type?: string;
  description?: string;
  enum?: readonly unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

type ZodObjectShape = Record<string, z.ZodTypeAny>;

interface ZodDef {
  type?: string;
  typeName?: string;
  description?: string;
  checks?: unknown[];
  innerType?: z.ZodTypeAny;
  schema?: z.ZodTypeAny;
  in?: z.ZodTypeAny;
  out?: z.ZodTypeAny;
  values?: readonly unknown[];
  entries?: Record<string, unknown>;
  element?: z.ZodTypeAny;
}

export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  const def = unwrap(schema);
  return def;
}

function defOf(schema: z.ZodType): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

function kindOf(schema: z.ZodType): string | undefined {
  const def = defOf(schema);
  return def.typeName ?? def.type;
}

function descriptionOf(schema: z.ZodType, def = defOf(schema)): string | undefined {
  return def.description ?? (schema as unknown as { description?: string }).description;
}

function checkDef(check: unknown): Record<string, unknown> {
  return (
    (check as { _zod?: { def?: Record<string, unknown> } })._zod?.def ??
    (check as Record<string, unknown>)
  );
}

function unwrap(schema: z.ZodType): JsonSchema {
  const def = defOf(schema);
  const result = convert(schema);
  const description = descriptionOf(schema, def);
  if (description && !result.description) result.description = description;
  return result;
}

function convert(schema: z.ZodType): JsonSchema {
  const def = defOf(schema);
  const kind = kindOf(schema);
  if (kind === "ZodOptional" || kind === "optional")
    return unwrap(def.innerType ?? (schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
  if (kind === "ZodNullable" || kind === "nullable")
    return unwrap(def.innerType ?? (schema as z.ZodNullable<z.ZodTypeAny>).unwrap());
  if (kind === "ZodDefault" || kind === "default")
    return unwrap(def.innerType ?? (schema as z.ZodDefault<z.ZodTypeAny>).removeDefault());
  // `.refine()` / `.transform()` / `.superRefine()` wrap the schema in a
  // wrapper in zod v3, while zod v4 keeps refinements on the schema and uses
  // `pipe` for transforms/preprocess. Cross-field validation is enforced at
  // parse time on the server; for the JSON schema we hand to the model, peel
  // wrappers and surface the structural input/output schema.
  if (kind === "ZodEffects") return unwrap(def.schema ?? schema);
  if (kind === "pipe" || kind === "ZodPipeline") {
    const inputKind = def.in ? kindOf(def.in) : undefined;
    if ((inputKind === "transform" || inputKind === "ZodTransform") && def.out)
      return unwrap(def.out);
    if (def.in) return unwrap(def.in);
  }
  if (schema instanceof z.ZodString) {
    const out: JsonSchema = { type: "string" };
    const checks = def.checks;
    if (checks) {
      for (const c of checks) {
        const check = checkDef(c);
        if (check.kind === "min" && typeof check.value === "number") out.minLength = check.value;
        if (check.kind === "max" && typeof check.value === "number") out.maxLength = check.value;
        if (check.check === "min_length" && typeof check.minimum === "number")
          out.minLength = check.minimum;
        if (check.check === "max_length" && typeof check.maximum === "number")
          out.maxLength = check.maximum;
      }
    }
    return out;
  }
  if (schema instanceof z.ZodNumber) {
    const checks = def.checks ?? [];
    const isInt =
      (schema as unknown as { isInt?: boolean }).isInt === true ||
      checks.some((c) => {
        const check = checkDef(c);
        return check.kind === "int" || check.format === "safeint";
      });
    const out: JsonSchema = { type: isInt ? "integer" : "number" };
    for (const c of checks) {
      const check = checkDef(c);
      if (check.kind === "min" && typeof check.value === "number") out.minimum = check.value;
      if (check.kind === "max" && typeof check.value === "number") out.maximum = check.value;
      if (check.check === "greater_than" && typeof check.value === "number")
        out.minimum = check.value;
      if (check.check === "less_than" && typeof check.value === "number") out.maximum = check.value;
    }
    return out;
  }
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodEnum) {
    const values = def.values ?? Object.values(def.entries ?? {});
    return { type: "string", enum: [...values] };
  }
  if (schema instanceof z.ZodArray) {
    return {
      type: "array",
      items: unwrap(def.element ?? (schema as z.ZodArray<z.ZodTypeAny>).element),
    };
  }
  if (schema instanceof z.ZodObject) {
    const shape = (schema as unknown as { shape: ZodObjectShape }).shape;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      const value = v as z.ZodTypeAny;
      properties[k] = unwrap(value);
      if (!isOptional(value)) required.push(k);
    }
    const out: JsonSchema = { type: "object", properties };
    if (required.length > 0) out.required = required;
    return out;
  }
  // Fallback: don't constrain.
  return {};
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const kind = kindOf(schema);
  return (
    kind === "ZodOptional" ||
    kind === "optional" ||
    kind === "ZodDefault" ||
    kind === "default" ||
    kind === "ZodNullable" ||
    kind === "nullable"
  );
}
