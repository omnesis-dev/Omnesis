// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { CursorEnvelopeError, makeCursorValidator } from "./cursor-validator.js";
import { encodeSourceState } from "./source-state.js";

interface PagedCursor {
  page: number;
}
const isPaged = (v: unknown): v is PagedCursor =>
  typeof v === "object" && v !== null && typeof (v as PagedCursor).page === "number";

/** A cursor whose every field is optional — the shape that hides the loss. */
interface LenientCursor {
  page?: number;
}
const isLenient = (v: unknown): v is LenientCursor => typeof v === "object" && v !== null;

describe("makeCursorValidator", () => {
  const validate = makeCursorValidator(isPaged);

  test("a cursor of the expected shape is returned", () => {
    expect(validate({ page: 3 })).toEqual({ page: 3 });
  });

  test("an unrecognised value bootstraps, which is what null means", () => {
    expect(validate({ offset: 3 })).toBeNull();
    expect(validate(null)).toBeNull();
    expect(validate("nonsense")).toBeNull();
  });

  test("a state envelope is refused rather than read as a fresh start", () => {
    // The stored value of a source that declared versioned state and then
    // stopped. Reading it as absent would re-walk the whole upstream with
    // nothing recording why.
    const envelope = encodeSourceState({ version: 2, decode: () => null }, { page: 9 });
    expect(() => validate(envelope)).toThrow(CursorEnvelopeError);
  });

  test("a lenient predicate does not swallow the envelope", () => {
    // The dangerous half: a predicate that accepts any object would have taken
    // the envelope as a cursor whose every field is missing, resuming from
    // nothing while reporting success. The check runs first for this reason.
    const lenient = makeCursorValidator(isLenient);
    const envelope = encodeSourceState({ version: 1, decode: () => null }, { page: 9 });
    expect(() => lenient(envelope)).toThrow(CursorEnvelopeError);
    expect(lenient({ page: 1 })).toEqual({ page: 1 });
  });

  test("the refusal says what to do about it", () => {
    const envelope = encodeSourceState({ version: 1, decode: () => null }, {});
    const error = (() => {
      try {
        validate(envelope);
      } catch (e) {
        return e as Error;
      }
      return null;
    })();
    expect(error?.message).toContain("contract.state");
  });

  test("a cursor that merely has extra keys is not mistaken for an envelope", () => {
    // The envelope is identified by all of `e === 1`, a numeric `v` and an
    // object `state` — a cursor carrying any one of them on its own resumes.
    expect(validate({ page: 1, e: 1 })).toEqual({ page: 1, e: 1 });
    expect(validate({ page: 1, state: { of: "mind" } })).toMatchObject({ page: 1 });
    expect(validate({ page: 1, v: 2, state: {} })).toMatchObject({ page: 1 });
  });
});
