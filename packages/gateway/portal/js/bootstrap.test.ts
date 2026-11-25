// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import { describe, expect, test, vi } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function bootstrap() {
  const { document, window } = parseHTML(html);
  const reload = vi.fn();
  const script = document.getElementById("portal-bootstrap-script")!.textContent!;
  runInNewContext(script, { document, window, location: { reload } });
  return { document, window, reload };
}

describe("portal bootstrap recovery without application modules", () => {
  test("the initial document has visible loading content and working reload", () => {
    const { document, reload } = bootstrap();
    expect(document.querySelector('#app [role="status"]')?.textContent).toContain("Opening");
    document.getElementById("portal-bootstrap-reload")!.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test.each(["error", "unhandledrejection"])("a %s before the app mounts shows recovery", (kind) => {
    const { document, window, reload } = bootstrap();
    window.dispatchEvent(new window.Event(kind));
    expect(document.querySelector('#app [role="alert"]')?.textContent).toContain("Couldn't open Omnesis");
    expect(document.getElementById("portal-bootstrap-message")!.textContent).toContain("Check your connection");
    document.getElementById("portal-bootstrap-reload")!.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("errors after the app replaces the placeholder do not overwrite the portal", () => {
    const { document, window } = bootstrap();
    document.getElementById("app")!.innerHTML = '<main>Portal is open</main>';
    window.dispatchEvent(new window.Event("error"));
    window.dispatchEvent(new window.Event("unhandledrejection"));
    expect(document.getElementById("app")!.textContent).toBe("Portal is open");
  });
});
