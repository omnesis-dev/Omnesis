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
  orderSentence,
  policyChanges,
  policyChoices,
  policyDifference,
  saveSetup,
  setupSteps,
  startFlow,
  tailscaleKeptOff,
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
  publicBaseUrl: { serving: null, configured: null, restartNeeded: false },
  ...over,
});

describe("the setup's steps and progress", () => {
  test("the account is asked only with the relay", () => {
    expect(setupSteps({ cloudRelay: true })).toEqual(["account", "connection", "devices"]);
    expect(setupSteps({ cloudRelay: false })).toEqual(["connection", "devices"]);
    expect(setupSteps()).toEqual(["connection", "devices"]);
  });

  test("a saved flow comes back only when well formed for these steps", () => {
    const steps = ["account", "connection", "devices"];
    const saved = { mode: "setup", step: "connection", resume: "devices", self: true, own: "host", url: "https://omnesis.example.org" };
    expect(loadSetup(steps, memory({ [SETUP_STORAGE_KEY]: JSON.stringify(saved) }))).toEqual(saved);
    // Anything odd is dropped or replaced, never trusted.
    expect(
      loadSetup(steps, memory({ [SETUP_STORAGE_KEY]: JSON.stringify({ ...saved, resume: "nowhere", self: "yes", own: "ftp", url: 7 }) })),
    ).toEqual({ ...saved, resume: null, self: false, own: "url", url: "" });
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

  test("the first visit opens the setup, later visits the summary, and a saved flow resumes", () => {
    const steps = ["account", "connection", "devices"];
    expect(initialFlow(remote(), null, steps)).toEqual({ mode: "setup", step: "account", resume: null, self: false, own: "host", url: "" });
    expect(initialFlow(remote({ setupCompletedAt: "2026-11-15T10:00:00Z" }), null, steps)).toEqual({ mode: "summary" });
    const setup = { mode: "setup", step: "devices", resume: null, self: false, own: "url", url: "" };
    expect(initialFlow(remote(), setup, steps)).toBe(setup);
    // A setup finished elsewhere is not resumed; a review is.
    expect(initialFlow(remote({ setupCompletedAt: "2026-11-15T10:00:00Z" }), setup, steps)).toEqual({ mode: "summary" });
    const review = { ...setup, mode: "review" };
    expect(initialFlow(remote({ setupCompletedAt: "2026-11-15T10:00:00Z" }), review, steps)).toBe(review);
  });

  test("own setup starts on the address the gateway already has, else on Tailscale where it can look", () => {
    const steps = ["connection", "devices"];
    expect(startFlow("review", steps, remote({ publicBaseUrl: { configured: "https://omnesis.example.org" } }))).toMatchObject({
      mode: "review", step: "connection", self: true, own: "url",
    });
    expect(startFlow("setup", steps, remote({ features: { cloudRelay: true, tailscaleEmbed: false } }))).toMatchObject({ self: false, own: "url" });
    expect(startFlow("setup", steps, { setupCompletedAt: null })).toMatchObject({ self: false, own: "url" });
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

  test("with an account linked, a device at pairing codes is never opened by the shared answer", () => {
    const linked = { relayLinked: true, tailscaleOn: true, tailscalePolicy: "off" };
    expect(tailscaleKeptOff(linked)).toBe(true);
    expect(tailscaleKeptOff({ relayLinked: false, tailscalePolicy: "off" })).toBe(false);
    expect(tailscaleKeptOff({ relayLinked: true, tailscalePolicy: "ask" })).toBe(false);
    expect(tailscaleKeptOff({ relayLinked: true })).toBe(false);
    expect(policyChanges("ask", linked)).toEqual([{ target: "relay", policy: "ask" }]);
    expect(policyChanges("automatic", linked)).toEqual([{ target: "relay", policy: "automatic" }]);
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
  test("lists and the order between Tailscale and the relay", () => {
    expect(listSentence([])).toBe("");
    expect(listSentence(["a"])).toBe("a");
    expect(listSentence(["a", "b"])).toBe("a and b");
    expect(listSentence(["a", "b", "c"])).toBe("a, b and c");
    expect(orderSentence({ tailscaleOn: true, relayOn: false, first: "relay" })).toBe("Your home network comes first.");
    expect(orderSentence({ tailscaleOn: true, relayOn: true, first: "tailscale" })).toBe(
      "Home network first, then Tailscale, then the relay.",
    );
    expect(orderSentence({ tailscaleOn: true, relayOn: true, first: "relay" })).toBe(
      "Home network first, then the relay, then Tailscale.",
    );
  });
});
