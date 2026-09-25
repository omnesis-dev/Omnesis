// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import {
  buildReleasePlan,
  decideTag,
  formatPlan,
  maxBump,
  nextVersion,
  parseChangeset,
  releasePrRefusal,
  resolveTargetVersion,
} from "./plan.mjs";

function state(overrides = {}) {
  return {
    productVersion: "0.4.0",
    requestedVersion: undefined,
    pendingChangesets: [],
    nativeVersions: [],
    branch: "release/v0.5.0",
    treeClean: true,
    localTagExists: false,
    remoteTagExists: false,
    changelogSection: "- something shipped",
    ...overrides,
  };
}

const stepById = (plan, id) => plan.steps.find((entry) => entry.id === id);

test("reads the bump and summary out of a changeset", () => {
  const parsed = parseChangeset(
    '---\n"omnesis": minor\n"@omnesis/gateway": patch\n---\n\nA one-line summary.\n',
  );
  expect(parsed.bumps).toEqual(["minor", "patch"]);
  expect(parsed.summary).toBe("A one-line summary.");
});

test("a quoted bump, and one with a trailing comment, read like a bare one", () => {
  expect(parseChangeset('---\n"omnesis": "major"\n---\n\nQuoted.\n').bumps).toEqual(["major"]);
  expect(parseChangeset('---\n"omnesis": patch # why\n---\n\nCommented.\n').bumps).toEqual([
    "patch",
  ]);
});

test("a `none` bump is declared but moves no version", () => {
  expect(parseChangeset('---\n"omnesis": none\n---\n\nNothing.\n').bumps).toEqual(["none"]);
  expect(maxBump(["none"])).toBeNull();
  expect(maxBump(["none", "patch"])).toBe("patch");
});

test("a version that is not strict SemVer cannot be bumped", () => {
  expect(() => nextVersion("0.4", "patch")).toThrow(/strict SemVer/u);
});

test("a lockstep group takes the strongest pending bump", () => {
  expect(maxBump(["patch", "minor", "patch"])).toBe("minor");
  expect(maxBump(["minor", "major"])).toBe("major");
  expect(maxBump([])).toBeNull();
});

test("bumps a strict SemVer version", () => {
  expect(nextVersion("0.4.2", "patch")).toBe("0.4.3");
  expect(nextVersion("0.4.2", "minor")).toBe("0.5.0");
  expect(nextVersion("0.4.2", "major")).toBe("1.0.0");
});

test("the target is the requested version, else the pending bump, else the tree", () => {
  expect(resolveTargetVersion(state({ requestedVersion: "9.9.9" }))).toBe("9.9.9");
  expect(resolveTargetVersion(state({ pendingChangesets: [{ bumps: ["minor"] }] }))).toBe("0.5.0");
  expect(resolveTargetVersion(state())).toBe("0.4.0");
});

test("a settled tree has nothing left to write and nothing blocked", () => {
  const plan = buildReleasePlan(state());
  expect(plan.targetVersion).toBe("0.4.0");
  expect(plan.tag).toBe("v0.4.0");
  expect(stepById(plan, "changeset").state).toBe("done");
  expect(stepById(plan, "version").state).toBe("done");
  expect(stepById(plan, "tag").state).toBe("todo");
  expect(plan.blockers).toEqual([]);
});

test("pending changesets drive the target version and the version step", () => {
  const plan = buildReleasePlan(
    state({
      pendingChangesets: [{ id: "a", bumps: ["minor"], summary: "x" }],
      nativeVersions: [{ path: "ios/project.yml", changed: true }],
    }),
  );
  expect(plan.targetVersion).toBe("0.5.0");
  expect(stepById(plan, "changeset").detail).toMatch(/1 pending changeset → minor bump/u);
  expect(stepById(plan, "version").state).toBe("todo");
  expect(stepById(plan, "version").detail).toMatch(/ios\/project\.yml/u);
});

test("a requested version with no changeset to produce it is blocked", () => {
  const plan = buildReleasePlan(state({ requestedVersion: "0.5.0" }));
  expect(stepById(plan, "changeset").state).toBe("blocked");
  expect(plan.blockers.join(" ")).toMatch(/npx changeset/u);
});

test("the tag step names every unmet precondition", () => {
  const plan = buildReleasePlan(
    state({
      requestedVersion: "0.5.0",
      pendingChangesets: [{ id: "a", bumps: ["minor"], summary: "x" }],
      treeClean: false,
      remoteTagExists: true,
    }),
  );
  const tag = stepById(plan, "tag");
  expect(tag.state).toBe("blocked");
  expect(tag.detail).toMatch(/the tree is at 0\.4\.0/u);
  expect(tag.detail).toMatch(/changesets are still pending/u);
  expect(tag.detail).toMatch(/working tree is dirty/u);
  expect(tag.detail).toMatch(/v0\.5\.0 already exists on origin/u);
});

test("an existing local tag on a settled tree reads as done", () => {
  const plan = buildReleasePlan(state({ localTagExists: true }));
  expect(stepById(plan, "tag").state).toBe("done");
});

test("a release cannot be opened from main", () => {
  const plan = buildReleasePlan(state({ branch: "main" }));
  expect(stepById(plan, "pr").state).toBe("blocked");
  expect(stepById(plan, "pr").detail).toMatch(/branch first/u);
});

test("the pr step says when the changelog has no section yet", () => {
  const plan = buildReleasePlan(state({ changelogSection: null }));
  expect(stepById(plan, "pr").detail).toMatch(/no section for this version yet/u);
});

test("publication and store submission are always external to this script", () => {
  const plan = buildReleasePlan(state());
  expect(stepById(plan, "publish").state).toBe("external");
  expect(stepById(plan, "stores").state).toBe("external");
  expect(stepById(plan, "stores").detail).toMatch(/never performs it/u);
});

test("the rendered plan names every step and counts the blocked ones", () => {
  const rendered = formatPlan(buildReleasePlan(state({ requestedVersion: "0.5.0" })));
  expect(rendered).toMatch(/^Release plan: 0\.4\.0 → 0\.5\.0 \(v0\.5\.0\)/u);
  expect(rendered).toMatch(/✖ Describe the change/u);
  expect(rendered).toMatch(/2 step\(s\) blocked/u);
});

test("a requested version the pending changesets cannot produce is blocked", () => {
  const plan = buildReleasePlan(
    state({
      requestedVersion: "1.0.0",
      pendingChangesets: [{ id: "a", bumps: ["minor"], summary: "x" }],
    }),
  );
  const changeset = stepById(plan, "changeset");
  expect(changeset.state).toBe("blocked");
  expect(changeset.detail).toMatch(/not 1\.0\.0/u);
  expect(changeset.detail).toMatch(/or release 0\.5\.0 instead/u);
});

test("the changeset step lists what the pending changesets say", () => {
  const plan = buildReleasePlan(
    state({
      pendingChangesets: [
        { id: "a", bumps: ["minor"], summary: "Add the release conductor." },
        { id: "b", bumps: ["patch"], summary: "Fix a typo." },
      ],
    }),
  );
  expect(stepById(plan, "changeset").detail).toMatch(/Add the release conductor\./u);
  expect(stepById(plan, "changeset").detail).toMatch(/Fix a typo\./u);
});

// ── Tag and branch decisions ────────────────────────────────────────────

test("a tag that does not exist yet is created", () => {
  expect(decideTag({ existingSha: null, headSha: "abc" })).toEqual({ kind: "create" });
});

test("a tag already on HEAD is the idempotent no-op", () => {
  expect(decideTag({ existingSha: "abc", headSha: "abc" })).toEqual({ kind: "exists", sha: "abc" });
});

test("a tag pointing somewhere else is a refusal, never a silent move", () => {
  expect(decideTag({ existingSha: "old", headSha: "abc" })).toEqual({
    kind: "mismatch",
    existingSha: "old",
    headSha: "abc",
  });
});

test("a release PR cannot be opened from main or a detached HEAD", () => {
  expect(releasePrRefusal("main")).toMatch(/work on a branch/u);
  expect(releasePrRefusal("(detached)")).toMatch(/detached HEAD/u);
  expect(releasePrRefusal("release/v0.5.0")).toBeNull();
});
