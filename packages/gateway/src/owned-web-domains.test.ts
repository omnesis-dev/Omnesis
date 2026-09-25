// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test } from "vitest";
import {
  getOwnedWebDomains,
  resetOwnedWebDomains,
  setOwnedWebDomains,
} from "./owned-web-domains.js";

describe("owned-web-domains registry", () => {
  afterEach(() => {
    // Process-level module state; reset so tests don't leak into each other.
    resetOwnedWebDomains();
  });

  test("starts empty before any collector push", () => {
    expect(getOwnedWebDomains()).toEqual([]);
  });

  test("stores the pushed domains, sorted", () => {
    setOwnedWebDomains(["web.whatsapp.com", "mail.google.com", "notion.so"]);
    expect(getOwnedWebDomains()).toEqual(["mail.google.com", "notion.so", "web.whatsapp.com"]);
  });

  test("trims, lowercases, and de-duplicates entries", () => {
    setOwnedWebDomains(["  Mail.Google.com  ", "mail.google.com", "NOTION.SO"]);
    expect(getOwnedWebDomains()).toEqual(["mail.google.com", "notion.so"]);
  });

  test("drops empty entries", () => {
    setOwnedWebDomains(["", "  ", "notion.so"]);
    expect(getOwnedWebDomains()).toEqual(["notion.so"]);
  });

  test("re-pushing fully replaces the previous set", () => {
    setOwnedWebDomains(["a.example.com"]);
    setOwnedWebDomains(["b.example.com"]);
    expect(getOwnedWebDomains()).toEqual(["b.example.com"]);
  });
});
