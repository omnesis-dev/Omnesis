// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One prompt-injection rule, two packages.
 *
 * Every surface in Omnesis that reads the corpus states the same sentence, and
 * it is defined once in `@omnesis/agent`'s read-only playbook. The watch
 * compiler cannot import it: `@omnesis/watch` compiles a DSL and holds no
 * dependency on the agent runtime, so it carries a copy — and a copy drifts.
 *
 * The gateway is the one package that depends on both, so this is where the two
 * are held together. That the compiler's prompt actually states its copy is
 * asserted next to the prompt, in `prompt.test.ts`.
 *
 * It matters more for this reader than for any other: its output is installed
 * and evaluated against everything that happens next, rather than read by a
 * person who can disagree with it.
 */

import { describe, expect, it } from "vitest";
import { CORPUS_CONTENT_IS_DATA } from "@omnesis/agent";
import { CORPUS_CONTENT_IS_DATA as COMPILER_COPY } from "@omnesis/watch";

describe("the compiler's prompt-injection rule", () => {
  it("is the shared playbook's, word for word", () => {
    expect(COMPILER_COPY).toBe(CORPUS_CONTENT_IS_DATA);
  });
});
