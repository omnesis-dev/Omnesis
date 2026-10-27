// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { mergeOpenClawSkillEnv, retireLegacyHermesConfig } from "../commands/connect.js";
import {
  harnessEnvHasOmnesisKeys,
  stripHarnessEnv,
  stripHermesConfig,
  stripOpenClawConfig,
} from "./harness-config.js";

describe("stripOpenClawConfig", () => {
  test("undoes what connect merged in, and keeps every other setting", () => {
    const operator = {
      update: { checkOnStart: false },
      skills: { entries: { weather: { env: { UNITS: "metric" } } } },
      plugins: { entries: { "stellar-sound": { enabled: true } }, allow: ["stellar-sound"] },
    };
    const original = `${JSON.stringify(operator, null, 2)}\n`;
    const connected = mergeOpenClawSkillEnv(original, { OMNESIS_AGENT_HARNESS: "openclaw" });
    expect(connected).not.toBe(original);
    expect(JSON.parse(stripOpenClawConfig(connected))).toEqual(operator);
  });

  test("a config that held only the integration is left an empty object", () => {
    const connected = mergeOpenClawSkillEnv("", { OMNESIS_AGENT_HARNESS: "openclaw" });
    expect(JSON.parse(stripOpenClawConfig(connected))).toEqual({});
  });

  test("allow and deny lose both plugin ids and nothing else", () => {
    const config = JSON.stringify({
      plugins: {
        allow: ["omnesis-integration", "studio-northstar", "omnesis-bridge"],
        deny: ["omnesis-integration"],
        entries: { "omnesis-bridge": { enabled: true } },
        load: { paths: ["/opt/plugins/omnesis-bridge", "/opt/plugins/keep-me"] },
      },
    });
    expect(JSON.parse(stripOpenClawConfig(config))).toEqual({
      plugins: { allow: ["studio-northstar"], deny: [], load: { paths: ["/opt/plugins/keep-me"] } },
    });
  });

  test("a config without Omnesis is returned unchanged, byte for byte", () => {
    const config = '{"update":{"checkOnStart":false}}';
    expect(stripOpenClawConfig(config)).toBe(config);
    expect(stripOpenClawConfig("")).toBe("");
  });

  test("a file that is not JSON is refused rather than rewritten", () => {
    expect(() => stripOpenClawConfig("{ not json")).toThrow();
  });
});

describe("stripHermesConfig", () => {
  const config = [
    "# Hermes settings",
    "display:",
    "  background_process_notifications: all  # keep me",
    "plugins:",
    "  enabled:",
    "    - weather-tools",
    "    - omnesis-integration",
    "    - omnesis-bridge",
    "  disabled:",
    "    - omnesis-integration",
    "  entries:",
    "    omnesis-integration:",
    "      allow_tool_override: false",
    "    weather-tools:",
    "      units: metric",
    "",
  ].join("\n");

  test("removes the integration from every plugin list and keeps comments", () => {
    const stripped = stripHermesConfig(config);
    expect(stripped).toContain("# Hermes settings");
    expect(stripped).toContain("background_process_notifications: all # keep me");
    expect(stripped).toContain("- weather-tools");
    expect(stripped).toContain("units: metric");
    expect(stripped).not.toContain("omnesis");
  });

  test("leaves a config that never had it untouched", () => {
    const plain = "display:\n  background_process_notifications: all\n";
    expect(stripHermesConfig(plain)).toBe(plain);
    expect(stripHermesConfig("")).toBe("");
  });

  test("covers everything the legacy retirement covers", () => {
    const legacy = "plugins:\n  enabled:\n    - omnesis-bridge\n";
    expect(stripHermesConfig(legacy)).toBe(retireLegacyHermesConfig(legacy));
  });

  test("refuses a file that is not YAML", () => {
    expect(() => stripHermesConfig("plugins: [unclosed\n")).toThrow();
  });
});

describe("stripHarnessEnv", () => {
  test("removes the keys connect owns, line for line, keeping the rest", () => {
    const env =
      "UNRELATED=keep\nOMNESIS_AGENT_HARNESS=openclaw\nexport OMNESIS_TOKEN=old\nOTHER='x y'\n";
    expect(harnessEnvHasOmnesisKeys(env)).toBe(true);
    expect(stripHarnessEnv(env)).toBe("UNRELATED=keep\nOTHER='x y'\n");
  });

  test("a file of nothing but Omnesis keys goes away", () => {
    expect(stripHarnessEnv("OMNESIS_AGENT_HARNESS=hermes\n")).toBeNull();
  });

  test("a file without them is returned as it is", () => {
    const env = "OMNESIS_GATEWAY_URL_BACKUP=x\nOPENAI_API_KEY=sk-example\n";
    expect(harnessEnvHasOmnesisKeys(env)).toBe(false);
    expect(stripHarnessEnv(env)).toBe(env);
  });
});
