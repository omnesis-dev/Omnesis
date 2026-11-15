// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  WAITING_ACCESS_PATH,
  WAITING_DEVICES_PATH,
  attentionText,
  navAttention,
  settingsTabAttention,
  waitingDevicesHref,
  // @ts-expect-error — portal modules are plain JS.
} from "./attention.js";

const devices = (cloud: string[] = [], tailscale = 0) => ({
  cloud: cloud.map((requestId) => ({ requestId })),
  tailscale: Array.from({ length: tailscale }, (_, i) => ({ id: `t${i}` })),
  count: cloud.length + tailscale,
});
const attention = ({
  cloud = [] as string[],
  tailscale = 0,
  access = 0,
  answers = 0,
  watches = 0,
} = {}) => ({
  devices: devices(cloud, tailscale),
  access: { count: access },
  answers: { count: answers },
  watches: { count: watches },
});

describe("the sentence each mark carries", () => {
  test.each([
    ["devices", 1, "A device is waiting for your approval to pair to this gateway."],
    ["devices", 3, "3 devices are waiting for your approval to pair to this gateway."],
    ["access", 1, "An agent is waiting for your approval to connect."],
    ["access", 2, "2 agents are waiting for your approval to connect."],
    ["answers", 1, "An answer is waiting for your review."],
    ["answers", 140, "140 answers are waiting for your review."],
    ["watches", 1, "A watch request is waiting for your approval."],
    ["watches", 5, "5 watch requests are waiting for your approval."],
  ])("%s × %i", (topic, count, sentence) => {
    expect(attentionText(topic, count)).toBe(sentence);
  });

  test("nothing waiting says nothing", () => {
    expect(attentionText("answers", 0)).toBe("");
  });
});

describe("Settings in the sidebar", () => {
  test("unmarked while nothing waits", () => {
    expect(navAttention("settings", attention())).toBeNull();
  });

  test("one sign-in request opens that request on Devices", () => {
    expect(navAttention("settings", attention({ cloud: ["req/1"] }))).toEqual({
      label: "A device is waiting for your approval to pair to this gateway.",
      href: `${WAITING_DEVICES_PATH}?request=req%2F1`,
    });
  });

  test("several devices, or a Tailscale join, open the Devices list", () => {
    expect(navAttention("settings", attention({ cloud: ["a", "b"] }))?.href).toBe(WAITING_DEVICES_PATH);
    expect(navAttention("settings", attention({ tailscale: 1 }))?.href).toBe(WAITING_DEVICES_PATH);
  });

  test("agents waiting alone lead to Access", () => {
    expect(navAttention("settings", attention({ access: 2 }))).toEqual({
      label: "2 agents are waiting for your approval to connect.",
      href: WAITING_ACCESS_PATH,
    });
  });

  test("devices lead when both wait, and the label says both", () => {
    expect(navAttention("settings", attention({ tailscale: 1, access: 1 }))).toEqual({
      label: "A device is waiting for your approval to pair to this gateway. An agent is waiting for your approval to connect.",
      href: WAITING_DEVICES_PATH,
    });
  });
});

describe("Audit and Watches in the sidebar", () => {
  test("Audit is marked for answers, keeping its own link", () => {
    expect(navAttention("privacy", attention({ answers: 3 }))).toEqual({
      label: "3 answers are waiting for your review.",
      href: null,
    });
    expect(navAttention("privacy", attention({ watches: 3 }))).toBeNull();
  });

  test("Watches is marked for watch requests, not for answers", () => {
    expect(navAttention("watches", attention({ watches: 1 }))).toEqual({
      label: "A watch request is waiting for your approval.",
      href: null,
    });
    expect(navAttention("watches", attention({ answers: 1 }))).toBeNull();
  });

  test("no other item is ever marked", () => {
    const everything = attention({ cloud: ["a"], access: 1, answers: 1, watches: 1 });
    for (const view of ["agent", "search", "sources", "people", "capture", "tasks", "debug"]) {
      expect(navAttention(view, everything)).toBeNull();
    }
  });
});

test("Settings tabs: Devices for devices, Access for agents, nothing else", () => {
  const both = attention({ tailscale: 2, access: 1 });
  expect(settingsTabAttention("devices", both)).toBe("2 devices are waiting for your approval to pair to this gateway.");
  expect(settingsTabAttention("access", both)).toBe("An agent is waiting for your approval to connect.");
  expect(settingsTabAttention("models", both)).toBe("");
  expect(settingsTabAttention("devices", attention())).toBe("");
  expect(settingsTabAttention("devices", null)).toBe("");
});

test("waitingDevicesHref opens one sign-in request, anything else the list", () => {
  expect(waitingDevicesHref(devices(["a"]))).toBe(`${WAITING_DEVICES_PATH}?request=a`);
  expect(waitingDevicesHref(devices([], 1))).toBe(WAITING_DEVICES_PATH);
  expect(waitingDevicesHref(devices(["a"], 1))).toBe(WAITING_DEVICES_PATH);
});
