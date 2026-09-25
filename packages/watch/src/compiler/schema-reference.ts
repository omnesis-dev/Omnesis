// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The DSL's shape, generated from the schema that enforces it.
 *
 * A prompt that spells out field names by hand is a second copy of the
 * grammar, and the moment the two disagree the compiler is being taught a
 * dialect the validator rejects — a failure that reads as the model's fault
 * and is not. So the shape half of the prompt is derived: zod is the source of
 * truth for the DSL, and this is that same schema rendered as JSON Schema.
 *
 * The prose half of the prompt stays hand-written, because shape is not
 * meaning. Nothing in a JSON Schema can say that `reset` restarts a lifecycle
 * while `ignore` drops the arm, that a broadcast edge occupies no slot in an
 * AND, or that a null key component must never become a routing value. Those
 * are the rules a compiler gets wrong, and they are explained rather than
 * generated.
 */

import { z } from "zod";

import { watchDslSchema } from "../dsl/schema.js";

/**
 * The schema as it appears in the prompt: stable, indented, fenced.
 *
 * Generated in `input` mode: the compiler writes what goes *in*, and the two
 * modes differ wherever the schema defaults a field — a model shown the parsed
 * shape would believe a defaulted field is required of it.
 */
export function dslSchemaReference(): string {
  const schema = z.toJSONSchema(watchDslSchema, { io: "input" }) as {
    properties?: { watch?: { properties?: Record<string, unknown> } };
  };
  // `delivery` is not a compiler's to decide. It says whether a firing
  // interrupts a person, which is a judgement about how much someone wants to
  // be disturbed rather than about what the watch should look for — and a model
  // shown a field with that name will fill it in for any request that sounds
  // urgent. It is turned on afterwards, by whoever will be interrupted.
  delete schema.properties?.watch?.properties?.["delivery"];
  return "```json\n" + JSON.stringify(schema, null, 1) + "\n```";
}
