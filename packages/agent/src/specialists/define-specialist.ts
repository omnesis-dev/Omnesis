// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `defineSpecialist` + the specialist registry (#748).
 *
 * A **specialist** is a private profile selected by an owned workflow such as
 * Deep Research: it owns the child session's system prompt, model *role*, and
 * default read-tool allowlist. The descriptor object is the contract — structural
 * typing, mirroring `defineSource()` (a specialist exposes what consumers need
 * through the descriptor; consumers never branch on a specialist name).
 *
 * Frozen #748 constraints encoded here:
 *   - A specialist names a model *role* only (the built-in research specialists
 *     use `agent`). There is **no** backend/model in the descriptor —
 *     the concrete model behind a role is assigned in `/portal/settings/models` and the
 *     `omnesis model` CLI, like every other capability.
 *   - `defaultTools` is a read-tool allowlist. Write tools are stripped
 *     downstream regardless (`selectSubagentTools`), so a specialist can never
 *     widen a sub-agent's reach to a mutating tool.
 */

import type { CapabilityRole } from "@omnesis/core";

/**
 * A specialist descriptor. `defineSpecialist` is an identity helper that pins
 * the shape (so a built-in is a literal `defineSpecialist({...})` call), the
 * same role `defineSource` plays for sources.
 */
export interface SpecialistDescriptor {
  /** Registry name an owned workflow passes through the internal sub-agent port. */
  readonly name: string;
  /** System prompt the child session runs under. */
  readonly systemPrompt: string;
  /**
   * Model role the child runs on. Built-in research specialists use the `agent`
   * role — Deep Research runs every step on the agent model. A custom specialist
   * may name any capability role, falling back to the parent agent's model when
   * that role is unassigned (graceful degrade — never hard-refuse).
   */
  readonly modelRole: CapabilityRole;
  /**
   * Default read-tool allowlist the child receives. Must name only read tools
   * (write tools are dropped downstream regardless). Omit to give the child
   * every read-only tool; an empty list grants no tools.
   */
  readonly defaultTools?: ReadonlyArray<string>;
}

/** Identity helper that pins the descriptor shape. See {@link SpecialistDescriptor}. */
export function defineSpecialist(descriptor: SpecialistDescriptor): SpecialistDescriptor {
  return descriptor;
}

/**
 * Thrown when an owned workflow names a profile that isn't registered. Unknown
 * names fail cleanly and never fall back to a silent generic worker.
 */
export class UnknownSpecialistError extends Error {
  /** The unresolved specialist name. */
  readonly specialist: string;
  /** The names that ARE registered, for an actionable message. */
  readonly known: ReadonlyArray<string>;

  constructor(specialist: string, known: ReadonlyArray<string>) {
    super(
      `unknown specialist "${specialist}" — available specialists: ${known.join(", ") || "(none)"}`,
    );
    this.name = "UnknownSpecialistError";
    this.specialist = specialist;
    this.known = known;
  }
}

/**
 * Immutable name → descriptor map. `resolve` throws {@link UnknownSpecialistError}
 * on an unknown name (the clean-failure contract); `has`/`names` let callers
 * enumerate without throwing.
 */
export class SpecialistRegistry {
  private readonly byName: ReadonlyMap<string, SpecialistDescriptor>;

  constructor(specialists: ReadonlyArray<SpecialistDescriptor>) {
    const map = new Map<string, SpecialistDescriptor>();
    for (const s of specialists) {
      if (map.has(s.name)) {
        throw new Error(`duplicate specialist name "${s.name}" in registry`);
      }
      map.set(s.name, s);
    }
    this.byName = map;
  }

  /** Resolve a name to its descriptor, or throw {@link UnknownSpecialistError}. */
  resolve(name: string): SpecialistDescriptor {
    const found = this.byName.get(name);
    if (!found) throw new UnknownSpecialistError(name, this.names());
    return found;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  list(): SpecialistDescriptor[] {
    return [...this.byName.values()];
  }
}
