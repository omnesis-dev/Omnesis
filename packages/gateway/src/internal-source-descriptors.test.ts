// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { memberScopedParamNames } from "@omnesis/source-sdk";
import {
  gatewayHostedDefinitions,
  gatewayHostedDescriptors,
} from "./internal-source-descriptors.js";

describe("gatewayHostedDescriptors", () => {
  test("advertises the unified Web Pages dataset with its full metadata", () => {
    const web = gatewayHostedDescriptors().find((d) => d.id === "web");
    expect(web).toBeTruthy();
    expect(web?.gatewayHosted).toBe(true);
    // The whole point: clients get web's metadata from the gateway, not a collector.
    expect(web?.name).toBe("Web Pages");
    expect(web?.unitName).toBe("web pages");
    expect(web?.primaryCount).toBe("documents");
    expect(web?.icon).toBeTruthy();
    expect(web?.analyticsSchemas?.map((s) => s.tableName)).toContain("page_visits");
  });

  test("the advertised per-machine contract is the one the source declares", () => {
    // "Declares none" and "did not say" are different facts, and every
    // consumer reads a missing field as the second — so the list has to be
    // there. It also has to be the source's own: this builder bypasses the
    // collector's, and a hardcoded answer here would keep agreeing with a
    // source that had since grown a host-local setting.
    const advertised = gatewayHostedDescriptors();
    expect(advertised.length).toBeGreaterThan(0);
    for (const d of advertised) {
      const definition = gatewayHostedDefinitions().find((def) => def.id === d.id)!;
      expect(d.memberScopedParamNames).toEqual(memberScopedParamNames(definition));
    }
    // And the fact about the one that exists: no device holds the Web Pages
    // store, so it has nothing per-machine to say.
    expect(advertised.find((d) => d.id === "web")?.memberScopedParamNames).toEqual([]);
  });

  test("every advertised descriptor is genuinely gatewayHosted", () => {
    // The fail-loud guard drops any definition that forgot the flag, so a
    // non-gatewayHosted entry can never leak into the gateway-advertised set.
    for (const d of gatewayHostedDescriptors()) {
      expect(d.gatewayHosted).toBe(true);
    }
  });
});
