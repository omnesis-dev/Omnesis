// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Config, Models, Access, Policies and Devices are tabs of one Settings page.
// These assert what routing must get right for that: each tab is addressable,
// the Models tab addresses the section below it, Access and Policies address
// their detail pages, the alternate one-page-each spellings resolve, and any
// path that isn't the canonical spelling of the tab on screen redirects to one
// that is — carrying the query string with it.

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { EXTENSION_PAIR_PATH } from "./extension-links.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { parseRoute } from "./router.js";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { settingsTabs, SETTINGS_TAB_KEYS, DEFAULT_SETTINGS_TAB } from "./settings-tabs.js";

function route(pathname: string, search = "") {
  vi.stubGlobal("location", { pathname, search });
  return parseRoute();
}

afterEach(() => vi.unstubAllGlobals());

describe("Settings page tabs", () => {
  test("the bare path opens the default tab, with or without a trailing slash", () => {
    const expected = { view: "settings", tab: "config", modelsSection: null };
    expect(route("/portal/settings")).toEqual(expected);
    expect(route("/portal/settings/")).toEqual(expected);
  });

  test("every tab is addressable by its own path segment", () => {
    for (const key of SETTINGS_TAB_KEYS) {
      expect(route(`/portal/settings/${key}`)).toEqual({
        view: "settings",
        tab: key,
        modelsSection: null,
      });
    }
  });

  test("the Models tab addresses the section below it", () => {
    expect(route("/portal/settings/models/backends")).toEqual({
      view: "settings",
      tab: "models",
      modelsSection: "backends",
    });
    expect(route("/portal/settings/models/agent")).toEqual({
      view: "settings",
      tab: "models",
      modelsSection: "agent",
    });
  });

  test("Access authorization and access level details have stable refreshable routes", () => {
    expect(route(
      "/portal/settings/access/authorizations/11111111-1111-4111-8111-111111111111",
      "?completion=portal",
    )).toEqual({
      view: "settings",
      tab: "access",
      modelsSection: null,
      accessAuthorizationId: "11111111-1111-4111-8111-111111111111",
      completeAccessInPortal: true,
    });
    expect(route(
      "/portal/settings/access/levels/22222222-2222-4222-8222-222222222222",
    )).toEqual({
      view: "settings",
      tab: "access",
      modelsSection: null,
      accessLevelId: "22222222-2222-4222-8222-222222222222",
    });
    // "new" is the page that creates a level, never a level's id.
    expect(route("/portal/settings/access/levels/new")).toEqual({
      view: "settings",
      tab: "access",
      modelsSection: null,
      accessNewLevel: true,
    });
    expect(route("/portal/settings/access/levels/new/")).toMatchObject({ accessNewLevel: true });
  });

  test("the Access tab's connect dialog has its own route", () => {
    expect(route("/portal/settings/access/connect")).toEqual({
      view: "settings",
      tab: "access",
      modelsSection: null,
      accessConnect: true,
    });
    expect(route("/portal/settings/access/connect/")).toMatchObject({ accessConnect: true });
  });

  test("one privacy policy is addressed by id on the Policies tab", () => {
    expect(route(
      "/portal/settings/policies/33333333-3333-4333-8333-333333333333",
    )).toEqual({
      view: "settings",
      tab: "policies",
      modelsSection: null,
      policyId: "33333333-3333-4333-8333-333333333333",
    });
    expect(route("/portal/settings/policies/policy%2Fone")).toMatchObject({
      policyId: "policy/one",
    });
    expect(route("/portal/settings/policies/%").view).toBe("search");
  });

  test("a policy spelled under the Access tab resolves to the Policies tab and redirects", () => {
    expect(route(
      "/portal/settings/access/policies/33333333-3333-4333-8333-333333333333",
    )).toEqual({
      view: "settings",
      tab: "policies",
      modelsSection: null,
      policyId: "33333333-3333-4333-8333-333333333333",
      redirectTo: "/portal/settings/policies/33333333-3333-4333-8333-333333333333",
    });
    // An opaque id is re-encoded on the way to the canonical spelling.
    expect(route("/portal/settings/access/policies/policy%2Fone")).toMatchObject({
      policyId: "policy/one",
      redirectTo: "/portal/settings/policies/policy%2Fone",
    });
    // The bare list under Access is the Policies tab itself.
    expect(route("/portal/settings/access/policies")).toEqual({
      view: "settings",
      tab: "policies",
      modelsSection: null,
      redirectTo: "/portal/settings/policies",
    });
    expect(route("/portal/settings/access/policies/%").view).toBe("search");
  });

  test("no other tab carries a section — a stray segment is dropped and redirected away", () => {
    expect(route("/portal/settings/devices/whatever")).toEqual({
      view: "settings",
      tab: "devices",
      modelsSection: null,
      redirectTo: "/portal/settings/devices",
    });
  });

  test("an unrecognised tab segment resolves to the default tab and redirects", () => {
    expect(route("/portal/settings/nonsense")).toEqual({
      view: "settings",
      tab: DEFAULT_SETTINGS_TAB,
      modelsSection: null,
      redirectTo: `/portal/settings/${DEFAULT_SETTINGS_TAB}`,
    });
  });

  test("the alternate one-page-each spellings resolve to their tab and redirect", () => {
    expect(route("/portal/config")).toEqual({
      view: "settings",
      tab: "config",
      modelsSection: null,
      redirectTo: "/portal/settings/config",
    });
    expect(route("/portal/devices/")).toEqual({
      view: "settings",
      tab: "devices",
      modelsSection: null,
      redirectTo: "/portal/settings/devices",
    });
    expect(route("/portal/models")).toEqual({
      view: "settings",
      tab: "models",
      modelsSection: null,
      redirectTo: "/portal/settings/models",
    });
    expect(route("/portal/models/backends")).toEqual({
      view: "settings",
      tab: "models",
      modelsSection: "backends",
      redirectTo: "/portal/settings/models/backends",
    });
    expect(route("/portal/policies")).toEqual({
      view: "settings",
      tab: "policies",
      modelsSection: null,
      redirectTo: "/portal/settings/policies",
    });
  });

  test("a canonical path never redirects", () => {
    for (const path of [
      "/portal/settings",
      "/portal/settings/config",
      "/portal/settings/models",
      "/portal/settings/models/embedder",
      "/portal/settings/access",
      "/portal/settings/access/connect",
      "/portal/settings/policies",
      "/portal/settings/policies/33333333-3333-4333-8333-333333333333",
      "/portal/settings/devices",
    ]) {
      expect(route(path)).not.toHaveProperty("redirectTo");
    }
  });

  test("every tab the tab bar offers is a path the router accepts", () => {
    // The tab bar renders SETTINGS_TABS; the router validates its path segment
    // against SETTINGS_TAB_KEYS. A tab present in one and not the other would
    // render a tab that bounces the user back to the default on click.
    // Checked in experimental mode, which is the widest the tab bar ever gets.
    for (const tab of settingsTabs({ experimental: true }) as Array<{ key: string }>) {
      expect(route(`/portal/settings/${tab.key}`)).toMatchObject({
        view: "settings",
        tab: tab.key,
      });
    }
  });

  test("experimental tabs are offered only in experimental mode", () => {
    // The router keeps parsing their paths either way — the view decides what
    // to render — so the only thing that must differ is what the bar offers.
    const shown = (experimental: boolean) =>
      (settingsTabs({ experimental }) as Array<{ key: string }>).map((t) => t.key);
    expect(shown(true)).toContain("sweeps");
    expect(shown(false)).not.toContain("sweeps");
    expect(SETTINGS_TAB_KEYS).toContain("sweeps");
  });

  test("the rewrite carries the query string across", () => {
    expect(route("/portal/models/backends", "?probe=1")).toMatchObject({
      redirectTo: "/portal/settings/models/backends?probe=1",
    });
    expect(route("/portal/config", "?flash=saved")).toMatchObject({
      redirectTo: "/portal/settings/config?flash=saved",
    });
  });

  test("?pair=<kind> on the Devices tab requests the pairing modal preselected", () => {
    expect(route("/portal/settings/devices", "?pair=browser")).toEqual({
      view: "settings",
      tab: "devices",
      modelsSection: null,
      pair: "browser",
    });
    // Other tabs ignore it — it is Devices-tab state, not page state.
    expect(route("/portal/settings/config", "?pair=browser")).toEqual({
      view: "settings",
      tab: "config",
      modelsSection: null,
    });
    // And it survives the alternate-spelling redirect.
    expect(route("/portal/devices", "?pair=browser")).toMatchObject({
      tab: "devices",
      pair: "browser",
      redirectTo: "/portal/settings/devices?pair=browser",
    });
  });

  test("?device=<id> on the Devices tab names the device to open", () => {
    expect(route("/portal/settings/devices", "?device=device-voice")).toEqual({
      view: "settings",
      tab: "devices",
      modelsSection: null,
      device: "device-voice",
    });
    expect(route("/portal/settings/access", "?device=device-voice")).toEqual({
      view: "settings",
      tab: "access",
      modelsSection: null,
    });
  });

  test("an empty ?pair= carries no request", () => {
    expect(route("/portal/settings/devices", "?pair=")).toEqual({
      view: "settings",
      tab: "devices",
      modelsSection: null,
    });
  });

  test("the promo card's pair link resolves back to a browser pair request", () => {
    // Round-trips the shipped constant through the router instead of
    // asserting the literal: the contract is parseability, not the string.
    const [path, search] = EXTENSION_PAIR_PATH.split("?");
    expect(route(path, `?${search}`)).toMatchObject({
      view: "settings",
      tab: "devices",
      pair: "browser",
    });
  });
});
