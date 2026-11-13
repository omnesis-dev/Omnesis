// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "@playwright/test";
import { buildPortalCsp, inlineScriptHashes } from "../packages/gateway/src/http/routes/portal.js";

// Browsers normalize CRLF and lone CR in HTML before checking inline-script
// hashes. Windows checkouts must authorize that same text, while arbitrary
// inline scripts remain blocked by the production policy.
for (const [name, newline] of [
  ["LF", "\n"],
  ["CRLF", "\r\n"],
  ["CR", "\r"],
] as const) {
  test(`portal CSP allows browser-normalized ${name} scripts and refuses injected scripts`, async ({
    page,
  }) => {
    const approved = `<!doctype html>
<script type="importmap">
{"imports":{"example-module":"/portal/__csp-fixture__/module.js"}}
</script>
<script>
window.exampleTheme = "dark";
</script>
<script type="module" src="/portal/__csp-fixture__/entry.js"></script>`;
    const source = approved.replaceAll("\n", newline);
    const csp = buildPortalCsp(inlineScriptHashes(source));
    await page.route("**/portal/__csp-fixture__/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith(".html")) {
        return route.fulfill({
          contentType: "text/html",
          headers: { "Content-Security-Policy": csp },
          body: `${source}<script>window.exampleInjected = true;</script>`,
        });
      }
      return route.fulfill({
        contentType: "text/javascript",
        body: path.endsWith("entry.js")
          ? 'import { value } from "example-module"; window.exampleModule = value;'
          : 'export const value = "loaded";',
      });
    });
    await page.goto("/portal/__csp-fixture__/index.html");
    await expect
      .poll(() =>
        page.evaluate(() => ({
          theme: Reflect.get(window, "exampleTheme"),
          module: Reflect.get(window, "exampleModule"),
          injected: Reflect.get(window, "exampleInjected") === true,
        })),
      )
      .toEqual({ theme: "dark", module: "loaded", injected: false });
  });
}
