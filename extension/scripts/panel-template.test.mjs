// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { withoutPanelSection } from "./panel-template.mjs";

test.each(["\n", "\r\n", "\r"])(
  "independent panels retain their content with %j line endings",
  (ending) => {
    const template = readFileSync(new URL("../public/notes.html", import.meta.url), "utf8").replace(
      /\r\n|\r|\n/g,
      ending,
    );
    for (const removed of ["notes", "find"]) {
      const result = withoutPanelSection(template, removed);
      expect(result).not.toContain(`<!-- ${removed}:start -->`);
      expect(result).not.toContain(`<!-- ${removed}:end -->`);
      expect(result).toContain(`<!-- ${removed === "notes" ? "find" : "notes"}:start -->`);
      expect(result).toContain("</html>");
    }
  },
);

test("a missing section still fails the build", () => {
  expect(() => withoutPanelSection("<html>invented incomplete template</html>", "find")).toThrow(
    "Missing find section",
  );
});
