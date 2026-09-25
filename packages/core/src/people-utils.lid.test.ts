// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Platform identifiers, and which of them can be re-pointed.
 *
 * Sharing one of these merges two people with no review, and a guard written
 * for one platform must not fire on any other. Both consequences turn on the
 * platform half being present and being read correctly.
 */

import { describe, expect, test } from "vitest";

import {
  formatLid,
  isUnstableLid,
  normalizeLid,
  parseLid,
  WHATSAPP_LID_PLATFORM,
} from "./people-utils.js";

describe("a platform identifier", () => {
  test("carries the platform that issued it", () => {
    expect(formatLid("github", "jlopez")).toBe("github:jlopez");
    expect(formatLid(WHATSAPP_LID_PLATFORM, "229969796026444")).toBe("whatsapp:229969796026444");
  });

  test("reads back as its two halves", () => {
    expect(parseLid("strava-athlete:412")).toEqual({
      platform: "strava-athlete",
      localId: "412",
    });
  });

  test("keeps a local id that contains a colon whole", () => {
    // The platform is the first segment; everything after it belongs to the
    // platform, and splitting again would truncate an identifier that names a
    // person.
    expect(parseLid("example:a:b")).toEqual({ platform: "example", localId: "a:b" });
  });

  test("has no platform when it was written without one", () => {
    // The shape every WhatsApp identifier had before it was namespaced.
    expect(parseLid("229969796026444")).toBeNull();
    expect(parseLid(":orphan")).toBeNull();
    expect(parseLid("trailing:")).toBeNull();
    expect(parseLid("")).toBeNull();
  });
});

describe("whether an identifier can be re-pointed at someone else", () => {
  test("is true only for the platform that re-points them", () => {
    // WhatsApp's linked-identity ids are a mapping the platform maintains, so
    // one can come to refer to a different phone. That is the fact the
    // resolver's guard is about.
    expect(isUnstableLid("whatsapp:229969796026444")).toBe(true);
  });

  test("is false for the ones a person holds", () => {
    // A login and an athlete number are names their owner keeps. Treating them
    // as re-pointable held back a committer's GitHub identity and made them a
    // second person.
    expect(isUnstableLid("github:jlopez")).toBe(false);
    expect(isUnstableLid("strava-athlete:412")).toBe(false);
  });

  test("is false for a value that names no platform at all", () => {
    // The safe default. An identifier this build does not recognise is not
    // assumed to be the one whose guard withholds data.
    expect(isUnstableLid("229969796026444")).toBe(false);
    expect(isUnstableLid("")).toBe(false);
  });
});

/**
 * The value an identifier is stored under, whichever build sent it.
 *
 * An operator upgrades the gateway before the machine that syncs, so for a
 * while a collector still sends WhatsApp's ids the way it always did while
 * every stored row carries the platform. This is where the two meet.
 */
describe("an identifier that arrived without its platform", () => {
  test("is stored under the platform the migration gave every row like it", () => {
    expect(normalizeLid("229969796026444")).toBe("whatsapp:229969796026444");
  });

  test("and is then recognised by the guard written for that platform", () => {
    // The consequence that matters. Left bare, the value names no platform, so
    // the guard cannot tell it is the one kind of identifier that can be
    // re-pointed at somebody else — and does not fire.
    expect(isUnstableLid("229969796026444")).toBe(false);
    expect(isUnstableLid(normalizeLid("229969796026444"))).toBe(true);
  });

  test("a value that already names its platform is untouched", () => {
    expect(normalizeLid("whatsapp:229969796026444")).toBe("whatsapp:229969796026444");
    expect(normalizeLid("github:jlopez")).toBe("github:jlopez");
    expect(normalizeLid("strava-athlete:412")).toBe("strava-athlete:412");
  });

  test("the rule is the migration's own: only all-digits carries no platform", () => {
    // A login that happens to be numeric-looking but is not digits, and the
    // empty value, are both left alone rather than guessed at.
    expect(normalizeLid("v2-4419")).toBe("v2-4419");
    expect(normalizeLid("")).toBe("");
  });
});
