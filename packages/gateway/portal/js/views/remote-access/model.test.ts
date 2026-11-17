// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  SETUP_STORAGE_KEY,
  accountState,
  currentPolicy,
  initialFlow,
  joinWays,
  listSentence,
  loadSetup,
  policyChanges,
  policyChoices,
  policyDifference,
  saveSetup,
  setupSteps,
  startFlow,
  // @ts-expect-error — portal modules are plain JS.
} from "./model.js";

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  };
}
const remote = (over: Record<string, unknown> = {}) => ({
  setupCompletedAt: null,
  first: "tailscale",
  features: { cloudRelay: true, tailscaleEmbed: true },
  publicBaseUrl: { configured: null, setByEnvironment: false, way: null },
  ...over,
});

describe("the setup's steps and progress", () => {
  test("the account is asked only with the relay, new devices only while one can ask, MCP only with an address away", () => {
    expect(setupSteps({ cloudRelay: true })).toEqual(["account", "connection"]);
    expect(setupSteps({ cloudRelay: false })).toEqual(["connection"]);
    expect(setupSteps()).toEqual(["connection"]);
    expect(setupSteps({ cloudRelay: true, devices: true, mcp: true })).toEqual(["account", "connection", "devices", "mcp"]);
    expect(setupSteps({ devices: true })).toEqual(["connection", "devices"]);
    expect(setupSteps({ mcp: true })).toEqual(["connection", "mcp"]);
  });

  test("a saved flow comes back only when well formed for these steps", () => {
    const steps = ["account", "connection", "devices"];
    const saved = { mode: "setup", step: "connection", resume: "devices", host: true, domain: true, url: "https://omnesis.example.org" };
    expect(loadSetup(steps, memory({ [SETUP_STORAGE_KEY]: JSON.stringify(saved) }))).toEqual(saved);
    // An unanswered host choice stays unanswered, so the option shows whether it is set up.
    expect(loadSetup(steps, memory({ [SETUP_STORAGE_KEY]: JSON.stringify({ ...saved, host: undefined }) }))?.host).toBeNull();
    // Anything odd is dropped or replaced, never trusted.
    expect(
      loadSetup(steps, memory({ [SETUP_STORAGE_KEY]: JSON.stringify({ ...saved, resume: "nowhere", host: "yes", domain: "yes", url: 7 }) })),
    ).toEqual({ ...saved, resume: null, host: null, domain: false, url: "" });
    expect(loadSetup(steps, memory({ [SETUP_STORAGE_KEY]: JSON.stringify({ ...saved, url: "x".repeat(5000) }) }))?.url).toHaveLength(2048);
    for (const value of ["{", "null", "7", JSON.stringify({ ...saved, mode: "summary" }), JSON.stringify({ ...saved, step: "account" })])
      expect(loadSetup(["connection", "devices"], memory({ [SETUP_STORAGE_KEY]: value }))).toBeNull();
    expect(loadSetup(steps, memory())).toBeNull();
    expect(loadSetup(steps, undefined)).toBeNull();
  });

  test("saving keeps a setup or review and forgets it at the summary; a storage that throws is ignored", () => {
    const storage = memory();
    saveSetup({ mode: "review", step: "devices" }, storage);
    expect(JSON.parse(storage.values.get(SETUP_STORAGE_KEY)!)).toEqual({ mode: "review", step: "devices" });
    saveSetup({ mode: "summary" }, storage);
    expect(storage.values.has(SETUP_STORAGE_KEY)).toBe(false);
    const broken = { setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("denied"); } };
    expect(() => saveSetup({ mode: "setup", step: "devices" }, broken)).not.toThrow();
    expect(() => saveSetup({ mode: "summary" }, broken)).not.toThrow();
    expect(() => saveSetup({ mode: "setup" }, undefined)).not.toThrow();
  });

  test("the page opens on the summary, and a saved setup or review resumes", () => {
    expect(initialFlow(null)).toEqual({ mode: "summary" });
    const setup = { mode: "setup", step: "devices", resume: null, host: null, domain: false, url: "" };
    expect(initialFlow(setup)).toBe(setup);
    const review = { ...setup, mode: "review" };
    expect(initialFlow(review)).toBe(review);
  });

  test("a setup starts with the own domain open only when the public address is the owner's own", () => {
    const steps = ["connection", "devices"];
    expect(startFlow("review", steps, remote({ publicBaseUrl: { configured: "https://omnesis.example.org", way: null } }))).toEqual({
      mode: "review", step: "connection", resume: null, host: null, domain: true, url: "",
    });
    // An address that is Tailscale on this computer's, the relay's or the device's is that way's.
    for (const way of ["host", "relay", "tailnet"])
      expect(startFlow("setup", steps, remote({ publicBaseUrl: { configured: "https://studio.example-net.ts.net", way } }))).toMatchObject({ domain: false });
    expect(startFlow("setup", steps, remote())).toMatchObject({ step: "connection", host: null, domain: false });
    expect(startFlow("setup", ["account", "connection"], { setupCompletedAt: null })).toMatchObject({ step: "account", domain: false });
  });
});

describe("the account step's state", () => {
  const base = { enabled: false, serviceConfigured: true, enrollment: { state: "unconfigured" } };
  test("names each relay state the step shows", () => {
    expect(accountState(null)).toBe("loading");
    expect(accountState({ ...base, serviceConfigured: false })).toBe("unavailable");
    expect(accountState(base)).toBe("none");
    expect(accountState({ ...base, connect: { state: "waiting" } })).toBe("waiting");
    expect(accountState({ ...base, connect: { state: "failed" } })).toBe("failed");
    const enrolled = { ...base, enabled: true, enrollment: { state: "enrolled" }, tunnel: { state: "online" } };
    expect(accountState({ ...enrolled, account: { linked: true } })).toBe("linked");
    expect(accountState({ ...enrolled, google: { linked: true } })).toBe("linked");
    expect(accountState({ ...enrolled, account: { linked: false }, google: { configured: false } })).toBe("enrolled");
  });
});

describe("one answer for new devices", () => {
  test("a pairing code only is offered only while no account is linked", () => {
    expect(policyChoices({ relayLinked: true })).toEqual(["ask", "automatic"]);
    expect(policyChoices({ relayLinked: false })).toEqual(["ask", "automatic", "code"]);
  });

  test("the current answer is shared by both, or none when they differ", () => {
    expect(currentPolicy({})).toEqual({ value: null, differ: false });
    expect(currentPolicy({ relayPolicy: "ask" })).toEqual({ value: "ask", differ: false });
    expect(currentPolicy({ tailscalePolicy: "off" })).toEqual({ value: "code", differ: false });
    expect(currentPolicy({ relayPolicy: "automatic", tailscalePolicy: "automatic" })).toEqual({ value: "automatic", differ: false });
    expect(currentPolicy({ relayPolicy: "ask", tailscalePolicy: "automatic" })).toEqual({ value: null, differ: true });
    expect(currentPolicy({ relayPolicy: "ask", tailscalePolicy: "off" })).toEqual({ value: null, differ: true });
  });

  test("each answer maps onto the policies that apply", () => {
    const both = { relayLinked: true, tailscaleOn: true };
    expect(policyChanges("ask", both)).toEqual([{ target: "relay", policy: "ask" }, { target: "tailscale", policy: "ask" }]);
    expect(policyChanges("automatic", both)).toEqual([
      { target: "relay", policy: "automatic" },
      { target: "tailscale", policy: "automatic" },
    ]);
    // The relay has no "off": only unlinking stops sign-in joins.
    expect(policyChanges("code", both)).toEqual([{ target: "tailscale", policy: "off" }]);
    expect(policyChanges("ask", { relayLinked: true, tailscaleOn: false })).toEqual([{ target: "relay", policy: "ask" }]);
    expect(policyChanges("automatic", { relayLinked: false, tailscaleOn: false })).toEqual([]);
    // Without an account, a device at pairing codes takes the answer like any other.
    expect(policyChanges("ask", { relayLinked: false, tailscaleOn: true, tailscalePolicy: "off" })).toEqual([
      { target: "tailscale", policy: "ask" },
    ]);
  });

  test("the one answer reaches every way in, a Tailscale device at pairing codes included", () => {
    const linked = { relayLinked: true, tailscaleOn: true, tailscalePolicy: "off" };
    expect(policyChanges("ask", linked)).toEqual([{ target: "relay", policy: "ask" }, { target: "tailscale", policy: "ask" }]);
    expect(policyChanges("automatic", linked)).toEqual([
      { target: "relay", policy: "automatic" },
      { target: "tailscale", policy: "automatic" },
    ]);
  });

  test("the question and a difference are said in words", () => {
    expect(joinWays({ relayLinked: true, tailscaleOn: true })).toBe(
      "One answer for every way a device can ask: by signing in with your Omnesis account, or from your Tailscale network.",
    );
    expect(joinWays({ relayLinked: false, tailscaleOn: true })).toBe("A new device can ask to join from your Tailscale network.");
    expect(joinWays({ relayLinked: true, tailscaleOn: false })).toBe("A new device can ask to join by signing in with your Omnesis account.");
    expect(joinWays({ relayLinked: false, tailscaleOn: false })).toContain("Devices pair with a code");
    expect(policyDifference({ relayPolicy: "automatic", tailscalePolicy: "ask" })).toBe(
      "Right now devices that sign in join automatically and Tailscale devices wait for you. Choose one answer for both.",
    );
    expect(policyDifference({ relayPolicy: "ask", tailscalePolicy: "off" })).toContain(
      "devices that sign in wait for you and Tailscale devices need a pairing code",
    );
    expect(policyDifference({ relayPolicy: "ask", tailscalePolicy: "automatic" })).toContain("Tailscale devices join automatically");
  });
});

describe("summary sentences", () => {
  test("lists read as a sentence", () => {
    expect(listSentence([])).toBe("");
    expect(listSentence(["a"])).toBe("a");
    expect(listSentence(["a", "b"])).toBe("a and b");
    expect(listSentence(["a", "b", "c"])).toBe("a, b and c");
  });
});
