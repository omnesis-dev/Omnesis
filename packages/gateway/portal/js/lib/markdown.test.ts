// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
// Token tests leave DOM sanitization to the real-browser portal suite.
vi.mock("dompurify", () => ({ default: { sanitize: (html: string) => html } }));
// @ts-expect-error — portal modules are plain JS.
import { renderCopyableMarkdown } from "./markdown.js";

describe("Markdown copy payloads", () => {
  it("normalizes inline whitespace without interpreting literal HTML or entities", () => {
    const result = renderCopyableMarkdown("`  00123\n<&amp;>  ` and ``a`b``");
    expect(result.targets.map((target: { text: string }) => target.text))
      .toEqual([" 00123 <&amp;> ", "a`b"]);
  });

  it("preserves multiline fenced whitespace including its terminal newline", () => {
    for (const fence of ["```", "~~~"]) {
      const result = renderCopyableMarkdown(`${fence}\n\n42 example street  \nExampleville\n${fence}`);
      expect(result.targets[0].text).toBe("\n42 example street  \nExampleville\n");
    }
    expect(renderCopyableMarkdown("```\n```").targets[0].text).toBe("");
    expect(renderCopyableMarkdown("```\na\n").targets).toEqual([]);
    expect(renderCopyableMarkdown("```\na\n~~`").targets).toEqual([]);
    expect(renderCopyableMarkdown("```\na\n    ```").targets).toEqual([]);
    expect(renderCopyableMarkdown("```\na\n````").targets[0].text).toBe("a\n");
  });

  it("finds values in lists and tables but never trusts raw HTML code", () => {
    const result = renderCopyableMarkdown("- `00123`\n\n| Value |\n| --- |\n| `+1 (555) 010-0123` |\n\n<code>forged value</code>");
    expect(result.targets.map((target: { text: string }) => target.text))
      .toEqual(["00123", "+1 (555) 010-0123"]);
    expect(result.targets[0].id).not.toBe(result.targets[1].id);
  });
});
