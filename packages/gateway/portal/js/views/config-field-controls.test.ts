// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPatch,
  coerceLeaf,
  commitListValue,
  commitTextValue,
  leafControl,
  // @ts-expect-error — sibling .js modules, no .d.ts in the portal tree.
} from "./config-field-controls.js";

describe("config field patch construction", () => {
  it("preserves record keys that ordinary object assignment treats specially", () => {
    const patch = buildPatch(["sources", "__proto__", "syncInterval"], "5m");

    expect(Object.getPrototypeOf(patch)).toBeNull();
    expect(Object.hasOwn(patch.sources, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(patch))).toEqual(
      JSON.parse('{"sources":{"__proto__":{"syncInterval":"5m"}}}'),
    );
  });

  it("preserves record keys containing JSON-pointer separators", () => {
    const patch = buildPatch(["sources", "type/account", "syncInterval"], "10m");

    expect(JSON.parse(JSON.stringify(patch))).toEqual({
      sources: { "type/account": { syncInterval: "10m" } },
    });
  });

  it("rejects malformed and non-finite record numbers before serialization", () => {
    const numberNode = { kind: "number" };
    expect(coerceLeaf(numberNode, "abc")).toBeUndefined();
    expect(coerceLeaf(numberNode, "1e309")).toBeUndefined();
    expect(coerceLeaf(numberNode, "12.5")).toBe(12.5);
  });
});

describe("live commit values", () => {
  it("commitTextValue clears on empty, coerces finite numbers, keeps raw text otherwise", () => {
    // Reported QA request: keystrokes must stage without a blur click, so
    // the input and blur paths share one commit derivation.
    expect(commitTextValue({ kind: "string" }, "  ")).toBeUndefined();
    expect(commitTextValue({ kind: "string" }, "  Operator  ")).toBe("Operator");
    expect(commitTextValue({ kind: "number" }, "600000")).toBe(600000);
    expect(commitTextValue({ kind: "number" }, "12.5")).toBe(12.5);
    // Malformed numbers commit as text so the server rejects them with a
    // path-specific inline error, exactly like a blur commit.
    expect(commitTextValue({ kind: "number" }, "abc")).toBe("abc");
    expect(commitTextValue({ kind: "duration" }, "5m")).toBe("5m");
  });

  it("commitListValue splits lines and only clears a previously-set list", () => {
    expect(commitListValue("a@example.com\nb@example.com\n", undefined)).toEqual({
      commit: true,
      value: ["a@example.com", "b@example.com"],
    });
    expect(commitListValue("   \n  ", ["a@example.com"])).toEqual({ commit: true, value: undefined });
    // Emptied editor with nothing previously set stages nothing.
    expect(commitListValue("", undefined)).toEqual({ commit: false, value: undefined });
  });
});

describe("leaf control resync", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  const node = { kind: "number", default: 50 };
  const keys = ["search", "params", "candidateLimit"];

  // The structured form: each commit stages into parent state, which
  // re-renders the leaf with the staged value.
  function Form({
    initial,
    onStaged,
    leaf = node,
  }: {
    initial: unknown;
    onStaged: (v: unknown) => void;
    leaf?: Record<string, unknown>;
  }) {
    const [value, setValue] = useState(initial);
    return leafControl(
      leaf,
      keys,
      value,
      (_keys: string[], next: unknown) => {
        onStaged(next);
        setValue(next);
      },
      false,
      "ctl",
      "",
      "",
      false,
      0,
    );
  }

  function inputValue() {
    return (host.querySelector("input") as HTMLInputElement).value;
  }

  it("keeps a keystroke committed before the mount effect flushes", async () => {
    let staged: unknown;
    await act(async () => {
      render(h(Form, { initial: undefined, onStaged: (v) => { staged = v; } }), host);
      const input = host.querySelector("input") as HTMLInputElement;
      input.value = "-1";
      input.dispatchEvent(new (globalThis.window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
    });
    expect(staged).toBe(-1);
    expect(inputValue()).toBe("-1");
  });

  it("keeps a list keystroke committed before the mount effect flushes", async () => {
    let staged: unknown;
    await act(async () => {
      render(
        h(Form, { initial: ["a"], onStaged: (v) => { staged = v; }, leaf: { kind: "stringArray" } }),
        host,
      );
      const area = host.querySelector("textarea") as HTMLTextAreaElement;
      area.value = "a\nb";
      area.dispatchEvent(new (globalThis.window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
    });
    expect(staged).toEqual(["a", "b"]);
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("a\nb");
  });

  it("still resyncs to a value it did not send", async () => {
    // Same instance throughout: the root vnode keeps its component type, so
    // the resync effect, not a fresh mount, is what carries the new value.
    const mount = (value: unknown) =>
      render(leafControl(node, keys, value, () => {}, false, "ctl", "", "", false, 0), host);
    await act(async () => { mount(12); });
    expect(inputValue()).toBe("12");
    await act(async () => { mount(77); });
    expect(inputValue()).toBe("77");
  });

  it("keeps a keystroke that overtakes a pending external resync", async () => {
    // The external value renders outside `act`, so its resync effect is
    // still pending when the user types; the parent adopts the keystroke
    // the way the structured form does. The user's text must win.
    const mount = (value: unknown) =>
      render(leafControl(node, keys, value, (_k: string[], v: unknown) => mount(v), false, "ctl", "", "", false, 0), host);
    await act(async () => { mount(12); });
    expect(inputValue()).toBe("12");
    mount(42);
    const input = host.querySelector("input") as HTMLInputElement;
    input.value = "5000";
    input.dispatchEvent(new (globalThis.window as unknown as { Event: typeof Event }).Event("input", { bubbles: true }));
    // Long enough for Preact's deferred effect flush to fire.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(inputValue()).toBe("5000");
  });
});
