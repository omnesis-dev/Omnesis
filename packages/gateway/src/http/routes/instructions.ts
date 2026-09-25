// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `/admin/instructions` — read, replace and delete `OMNESIS.md`, the operator's
 * standing instructions to the agent.
 *
 * The file is the only state, so these routes are a thin shell over
 * {@link OperatorInstructionsStore}: there is no database mirror and no version
 * history, because a terminal editor is a first-class way to change this file
 * and a history that only recorded portal saves would be misleading about what
 * the agent has actually been told.
 *
 * `updatedAt` is the concurrency token. A caller that read the file and then
 * writes it back passes the `updatedAt` it saw; if the file has changed since
 * — someone saved from another portal tab, or wrote it in vim — the write is
 * refused with a 409 rather than silently discarding the other edit.
 *
 * Guarded with `scope.admin()` rather than `scope.portalAdmin()`, matching
 * `/admin/config`: this is configuration, not a release boundary, and an
 * operator scripting their own gateway should be able to reach it with a
 * bearer token.
 */

import { z } from "zod";

import {
  MAX_OPERATOR_INSTRUCTIONS_BYTES,
  OperatorInstructionsConflictError,
  OperatorInstructionsNotAFileError,
  OperatorInstructionsTooLargeError,
  type ExpectedVersion,
  type OperatorInstructionsStore,
} from "../../instructions/store.js";
import { BadRequestError, ConflictError, ServiceUnavailableError } from "../errors.js";
import { scope } from "../scope.js";
import { validateJson } from "../validate.js";
import type { RouteApp } from "./types.js";

/**
 * The concurrency token is a file mtime in epoch milliseconds, and mtimes are
 * NOT integers — most filesystems carry sub-millisecond precision, which
 * survives the JSON round trip as a fraction. Requiring an integer here would
 * reject every token this endpoint itself handed out.
 *
 * `null` is the token for "there was no file", so a caller creating one can
 * still be told it lost a race. Omitting the field skips the check entirely.
 */
const updatedAtToken = z.number().nonnegative().nullable();

/**
 * The store owns the real, byte-accurate cap; this bound is a coarse guard
 * against an absurd string reaching it, since a JS string's character count is
 * not its UTF-8 size. It is not a memory protection — the body is already read
 * and parsed by the time validation runs, exactly as on `/admin/config`.
 */
const writeBody = z
  .object({
    content: z.string().max(MAX_OPERATOR_INSTRUCTIONS_BYTES * 4),
    expectedUpdatedAt: updatedAtToken.optional(),
  })
  .strict();

const deleteBody = z.object({ expectedUpdatedAt: updatedAtToken.optional() }).strict();

/**
 * Read the delete's optional version claim without demanding a JSON body.
 * `DELETE` with no body is the natural shape from a shell — and this route is
 * guarded for a bearer token precisely so an operator can script it — so an
 * absent or empty body means "no claim" rather than a validation error.
 */
async function deleteClaim(raw: Request): Promise<{ expectedUpdatedAt?: number | null }> {
  let text: string;
  try {
    text = await raw.text();
  } catch {
    return {};
  }
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
  const result = deleteBody.safeParse(parsed);
  if (!result.success) throw new BadRequestError("Invalid delete body");
  return result.data;
}

/**
 * Forward the caller's version claim, keeping the difference between "no claim"
 * (field absent) and "I expect no file" (field null) — `null` is a real token,
 * so a falsiness test here would silently downgrade a create into a blind
 * overwrite.
 */
function expectedVersion(body: { expectedUpdatedAt?: number | null }): ExpectedVersion {
  return "expectedUpdatedAt" in body ? { expectedUpdatedAt: body.expectedUpdatedAt ?? null } : {};
}

export interface InstructionsRoutesDeps {
  /** Absent on a gateway assembled without a config directory. */
  store?: OperatorInstructionsStore;
}

export function mountInstructionsRoutes(app: RouteApp, deps: InstructionsRoutesDeps): void {
  const requireStore = (): OperatorInstructionsStore => {
    if (!deps.store) {
      throw new ServiceUnavailableError(
        "This gateway has no config directory to store OMNESIS.md.",
      );
    }
    return deps.store;
  };

  const noStore = async (
    c: { header: (name: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    c.header("Cache-Control", "no-store");
    await next();
  };

  const view = (store: OperatorInstructionsStore) => {
    const current = store.read();
    return {
      path: store.path,
      exists: current.exists,
      content: current.content,
      bytes: current.bytes,
      updatedAt: current.updatedAt,
      truncated: current.truncated,
      problem: current.problem,
      maxBytes: MAX_OPERATOR_INSTRUCTIONS_BYTES,
    };
  };

  // Translate the store's two refusals into the HTTP vocabulary the portal
  // already understands, so an editor open on a stale copy gets a 409 it can
  // explain rather than a 500 it cannot.
  const written = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof OperatorInstructionsConflictError) {
        throw new ConflictError(
          "OMNESIS.md changed on disk since it was loaded. Reload to see the current file.",
        );
      }
      if (err instanceof OperatorInstructionsTooLargeError) {
        throw new BadRequestError(
          `OMNESIS.md may be at most ${MAX_OPERATOR_INSTRUCTIONS_BYTES} bytes; this is ${err.bytes}.`,
        );
      }
      if (err instanceof OperatorInstructionsNotAFileError) {
        throw new ConflictError(err.message);
      }
      throw err;
    }
  };

  app.get("/admin/instructions", noStore, scope.admin(), (c) => {
    return c.json(view(requireStore()));
  });

  app.put("/admin/instructions", noStore, scope.admin(), validateJson(writeBody), (c) => {
    const store = requireStore();
    const body = c.req.valid("json");
    written(() => store.write(body.content, expectedVersion(body)));
    return c.json(view(store));
  });

  app.delete("/admin/instructions", noStore, scope.admin(), async (c) => {
    const store = requireStore();
    const body = await deleteClaim(c.req.raw);
    const removed = written(() => store.remove(expectedVersion(body)));
    return c.json({ ...view(store), removed });
  });
}
