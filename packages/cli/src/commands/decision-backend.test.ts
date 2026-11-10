// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { buildDecisionBackendPatch, describeCalibration, parseParams } from "./decision-backend.js";

describe("buildDecisionBackendPatch", () => {
  it("adds a local preset by its id, with no key", () => {
    expect(buildDecisionBackendPatch({ name: "ollaya", model: "kev" }).patch).toEqual({
      inference: {
        decisionBackends: {
          ollaya: {
            url: "http://127.0.0.1:11435/v1/systemone",
            preset: "ollaya",
            protocol: "systemone",
            auth: "bearer",
          },
        },
        assignments: { decision: "ollaya/kev" },
      },
    });
  });

  it("fills a cloud preset's URL, carries its wire details, key and consent", () => {
    const { patch, url } = buildDecisionBackendPatch({
      name: "clef",
      presetId: "cloudflare",
      params: { account: "abc123" },
      apiKey: "cf-token",
      allowRemote: true,
    });
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/abc123/ai/run");
    expect(patch.inference).toEqual({
      allowRemoteInference: true,
      decisionBackends: {
        clef: {
          url,
          preset: "cloudflare",
          protocol: "workers-ai",
          auth: "bearer",
          apiKey: "cf-token",
        },
      },
    });
    const fastino = buildDecisionBackendPatch({ name: "fastino", apiKey: "k" }).patch.inference;
    expect(
      (fastino.decisionBackends as Record<string, Record<string, unknown>>).fastino,
    ).toMatchObject({
      auth: "x-api-key",
      scoreField: "expected_level",
    });
  });

  it("adds a server no preset describes from its URL", () => {
    expect(
      buildDecisionBackendPatch({ name: "h2o", url: "http://192.0.2.7:8000/v1/systemone" }).patch
        .inference,
    ).toEqual({ decisionBackends: { h2o: { url: "http://192.0.2.7:8000/v1/systemone" } } });
  });

  it.each([
    [{ name: "typesafe" }, "cannot name a decision backend"],
    [{ name: "a/b", url: "http://x" }, "cannot name a decision backend"],
    [{ name: "mine" }, "give the server's URL with --url"],
    [{ name: "mine", presetId: "nope" }, 'Unknown decision preset "nope"'],
    [{ name: "tsafe", presetId: "typesafe" }, "TypeSafe is built in"],
    [{ name: "clef", presetId: "cloudflare" }, "needs your account id"],
    [{ name: "mine", url: "not a url" }, "is not a URL"],
  ])("explains what is wrong (%#)", (input, message) => {
    expect(() => buildDecisionBackendPatch(input)).toThrow(message);
  });
});

describe("parseParams", () => {
  it("reads one or many key=value flags", () => {
    expect(parseParams("account=abc")).toEqual({ account: "abc" });
    expect(parseParams(["a=1", "b = x=y"])).toEqual({ a: "1", b: "x=y" });
    expect(parseParams(undefined)).toEqual({});
    expect(() => parseParams("account")).toThrow("key=value");
  });
});

describe("describeCalibration", () => {
  it("says whether thresholds fit, and by how much calibration helped", () => {
    expect(describeCalibration(undefined)).toContain("not calibrated");
    expect(
      describeCalibration({
        points: [
          [0, 0],
          [1, 1],
        ],
        reference: "jev-worth/email-worth-v1/jev-1.13.0",
        fittedAt: "2026-11-10T18:00:00.000Z",
        agreement: 0.914,
        agreementBefore: 0.62,
      }),
    ).toBe("calibrated 2026-11-10: agrees with Jev on 91% of the reference emails (was 62%)");
  });
});
