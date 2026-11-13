// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { listen } from "../test/support.js";
import { AccountEnrollmentAuthority } from "./account-enrollment-proof.js";
import { listenForCompletion } from "./account-desktop-client.js";
import { RelayAccounts } from "./accounts.js";
import { RelaySessions } from "./identity.js";
import { brand, omnesisMark } from "./relay-page.js";
import { createCloudRelay } from "./server.js";

test("relay pages open with the portal's own mark, inline and decorative", async () => {
  const portal = await readFile(
    join(import.meta.dirname, "../../gateway/portal/img/omnesis-mark.svg"),
    "utf8",
  );
  const attribute = (source: string, name: string) =>
    new RegExp(` ${name}="([^"]+)"`).exec(source)![1];
  // The same drawing as the portal's sidebar, so the two cannot drift apart unnoticed.
  expect(attribute(omnesisMark, "d")).toBe(attribute(portal, "d"));
  expect(attribute(omnesisMark, "viewBox")).toBe(attribute(portal, "viewBox"));
  expect(omnesisMark).toContain('aria-hidden="true"');
  // Nothing a strict Content-Security-Policy would refuse or fetch: no style, script or link.
  expect(omnesisMark).not.toMatch(/style=|<style|<script|href=|url\(/);
  expect(brand).toBe(`<p class="brand">${omnesisMark}Omnesis</p>`);
});

test("every page a person sees carries the mark before the name, under an unchanged strict policy", async () => {
  const origin = "https://relay.example.test";
  const accounts = new RelayAccounts(":memory:");
  const relay = createCloudRelay({
    accounts,
    sessions: new RelaySessions(randomBytes(32)),
    controlOrigin: origin,
    accountSignIn: {
      enrollmentAuthority: new AccountEnrollmentAuthority(
        origin,
        generateKeyPairSync("ed25519").privateKey,
      ),
      signup: { policy: "open" },
    },
  });
  const url = await listen(relay.server);
  const loopback = await listenForCompletion();
  try {
    for (const path of [
      "/_relay/account",
      "/_relay/connect",
      "/_relay/v3/signup/complete",
      "/_relay/v3/desktop/complete",
    ]) {
      const response = await fetch(url + path),
        page = await response.text();
      expect(response.status, path).toBe(200);
      expect(page, path).toContain(`<main>${brand}`);
      const policy = response.headers.get("content-security-policy")!;
      expect(policy, path).toContain("default-src 'none'");
      expect(policy, path).toContain("style-src 'self'");
      expect(policy, path).not.toMatch(/unsafe-inline|data:|https?:/);
    }
    const style = await (await fetch(url + "/_relay/account/style.css")).text();
    // Centred over the column and sized to the name beside it, in the portal's blue for either
    // colour scheme.
    expect(style).toMatch(/\.brand\{[^}]*justify-content:center[^}]*font-size:1\.5rem[^}]*\}/);
    expect(style).toContain(".brand-mark{flex:none;width:2rem;height:2rem}");
    // A narrow column for a sign-in or a notice, the full one for the account, 16px from the edge.
    expect(style).toMatch(/main\{[^}]*max-width:28rem[^}]*padding:var\(--top\) 1rem 4rem\}/);
    expect(style).toContain("main.wide{max-width:calc(768px + 2rem)}");
    // A line between two items of a list, and none before the first or after the last.
    expect(style).toContain(
      ".gateway+.gateway,.credential+.credential{border-top:1px solid var(--line)}",
    );
    expect(style).not.toMatch(/\.list\{|border-bottom/);
    expect(style).toContain(".brand-mark path{fill:var(--mark)}");
    expect(style.match(/--mark:#[0-9a-f]{6}/g)).toEqual(["--mark:#1f6feb", "--mark:#58a6ff"]);
    // The page a desktop sign-in ends on is served by the device itself, with no stylesheet.
    const local = await fetch(`http://127.0.0.1:${loopback.port}/`);
    expect(await local.text()).toContain(`<main><p>${omnesisMark} Omnesis</p>`);
    expect(local.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  } finally {
    loopback.close();
    await relay.close();
    accounts.close();
  }
});
