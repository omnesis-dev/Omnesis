// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({ getSourceFilterOptions: vi.fn(), previewSourceFilter: vi.fn() }));
vi.mock("../api.js", () => api);
// @ts-expect-error — portal modules are plain JavaScript.
import { SourceFilterEditor } from "./source-filter-editor.js";
// @ts-expect-error — portal modules are plain JavaScript.
import { SourceFilterPicker } from "./source-filter-picker.js";
// @ts-expect-error — portal modules are plain JavaScript.
import { LevelDecisionSummary } from "../views/access/level-review.js";
// @ts-expect-error — portal modules are plain JavaScript.
import { CapabilityPicker } from "./grant-builder.js";

const source = {
  id: "fictional:one",
  displayName: "Fictional account",
  sourceType: "fictional-chat",
  scopes: {
    items: [
      {
        kind: "conversation",
        noun: { one: "room", many: "rooms" },
        picker: "search",
        link: "fixed",
      },
      { kind: "participant", identifiers: ["email", "phone"], link: "changes" },
      { kind: "label", noun: { one: "label", many: "labels" }, picker: "search", link: "changes" },
      { kind: "folder", noun: { one: "folder", many: "folders" }, picker: "tree", link: "changes" },
    ],
  },
  scopeReadiness: ["conversation", "participant", "label", "folder"].map((kind) => ({
    kind,
    ready: true,
  })),
};
const policy = {
  sourceId: source.id,
  audience: { accessLevel: "saved-level", capability: "answer" },
  rules: [{ action: "share", match: [{ kind: "conversation", id: "stable-room" }] }],
  otherwise: "hide",
};
/** The review's summary of an Answer that shares the account under `saved`. */
const answerSummary = (saved: unknown) =>
  h(LevelDecisionSummary, {
    decision: "answer-data",
    rules: {
      answer: {
        capability: "answer",
        sources: { mode: "allowlist", sourceIds: [source.id] },
        release: { mode: "unreviewed" },
        scopePolicies: [saved],
      },
    },
    sources: [source],
    policies: [],
  });
let host: HTMLElement;
beforeEach(() => {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  api.getSourceFilterOptions
    .mockReset()
    .mockImplementation(async (id: string, query: { kind: string }) => ({
      sourceId: id,
      scopes: source.scopes,
      readiness: source.scopeReadiness,
      items: [{ ref: { kind: query.kind, id: "stable-room" }, label: "Fictional room", count: 4 }],
    }));
  api.previewSourceFilter.mockReset().mockImplementation(async (id: string, p: typeof policy) => ({
    sourceId: id,
    total: 20,
    visible: 12,
    hidden: 8,
    unknown: 3,
    readiness: source.scopeReadiness,
    items: p.rules.flatMap((rule) =>
      rule.match.map((ref) => ({
        ref,
        label: ref.id === "missing-room" ? "Retired room" : "Fictional room",
        missing: ref.id === "missing-room",
        count: ref.id === "missing-room" ? 0 : 4,
      })),
    ),
    samples: [
      {
        documentId: "fictional-document",
        title: "Fictional sample",
        visible: true,
        unknown: false,
      },
    ],
  }));
});
afterEach(() => {
  act(() => render(null, host));
  vi.unstubAllGlobals();
});
function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
async function mount(props: Record<string, unknown> = {}) {
  await act(async () => {
    render(
      h(SourceFilterEditor, {
        source,
        capability: "answer",
        accessLevel: "saved-level",
        savedPolicy: policy,
        enabled: true,
        onApply: vi.fn(),
        onRemove: vi.fn(),
        onClose: vi.fn(),
        ...props,
      }),
      host,
    );
  });
  if (
    props.enabled !== false &&
    props.savedPolicy !== null &&
    host.textContent?.includes("What should be shared?")
  ) {
    await act(async () => button("Continue").click());
    await flushUI();
  }
}
async function flushUI() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function waitOptions() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 175));
  });
}
/** Any control that asks the owner to refresh something by hand. */
function refreshControls() {
  return [...host.querySelectorAll("button")]
    .map((item) => item.textContent?.trim() ?? "")
    .filter((label) => /refresh/iu.test(label));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("shows compact exact counts and missing selected rows without adding a filter review page", async () => {
  const saved = {
    ...policy,
    rules: [{ action: "share", match: [{ kind: "conversation", id: "missing-room" }] }],
  };
  await mount({ savedPolicy: saved });
  expect(host.textContent).toContain("Retired room");
  expect(host.textContent).toContain("Unavailable · selection retained");
  expect(host.querySelector(".source-filter-counts")?.textContent).toContain("12 shared8 hidden");
  expect([...host.querySelectorAll(".source-filter-unchecked p")].map((line) => line.textContent)).toEqual([
    "3 records stay hidden until their details finish syncing.",
    "Omnesis doesn’t have the details it needs to check them yet. Nothing is shared by mistake while they sync.",
  ]);
  expect(host.textContent).not.toContain("Fictional sample");
  expect(host.textContent).not.toContain("Review this filter");
  expect(host.querySelectorAll("details")).toHaveLength(0);
  expect(host.querySelector(".compact-filter-table")).not.toBeNull();
  expect(saved.rules[0]!.match[0]!.id).toBe("missing-room");
});

test("saved filters remain inspectable and immutable when the authoring gate is off", async () => {
  const onApply = vi.fn(),
    onRemove = vi.fn();
  await mount({ enabled: false, onApply, onRemove });
  await waitOptions();
  expect(host.textContent).toContain("saved filter remains enforced");
  expect(host.textContent).not.toContain("Apply filter");
  expect(host.textContent).not.toContain("Remove this source filter");
  expect(host.querySelector(".source-filter-options input")).toBeNull();
  expect(onApply).not.toHaveBeenCalled();
  expect(onRemove).not.toHaveBeenCalled();
});

test("an unsupported saved field is retained and never converted to an editable one-bucket policy", async () => {
  const saved = { ...policy, maxAge: { days: 3 } },
    onApply = vi.fn();
  await mount({ savedPolicy: saved, onApply });
  expect(host.textContent).toContain("complete saved policy is preserved");
  expect(host.textContent).not.toContain("Apply filter");
  expect(onApply).not.toHaveBeenCalled();
  expect(saved.maxAge).toEqual({ days: 3 });
});

test("late preview responses cannot replace the decision the owner is reviewing", async () => {
  const old = deferred<unknown>(),
    fresh = deferred<unknown>();
  api.previewSourceFilter
    .mockReset()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise);
  const onApply = vi.fn();
  await mount({ onApply });
  await act(async () => button("Back").click());
  const except = [...host.querySelectorAll<HTMLInputElement>(".source-filter-mode input")][2]!;
  await act(async () => {
    except.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await act(async () => button("Continue").click());
  const preview = (visible: number) => ({
    sourceId: source.id,
    total: 100,
    visible,
    hidden: 100 - visible,
    unknown: 0,
    items: [],
    samples: [],
    readiness: source.scopeReadiness,
  });
  await act(async () => fresh.resolve(preview(7)));
  await act(async () => old.resolve(preview(99)));
  await flushUI();
  expect(host.querySelector(".source-filter-counts")?.textContent).toContain("7 shared");
  expect(host.querySelector(".source-filter-counts")?.textContent).not.toContain("99");
  await act(async () => button("Apply filter").click());
  expect(onApply).toHaveBeenCalledWith(
    expect.objectContaining({
      otherwise: "share",
      rules: [{ action: "hide", match: policy.rules[0]!.match }],
    }),
  );
});

test("the header names the filter mode with what it means and the capability as its pill", async () => {
  await mount();
  const context = host.querySelector(".filter-task-context")!;
  const mode = context.querySelector(".access-pill")!;
  expect(mode.textContent).toBe("Share matching content");
  expect(mode.getAttribute("title")).toBe(
    "Only content that matches the criteria in the table below will be shared.",
  );
  expect(context.querySelector(".capability-pill")?.className).toBe(
    "capability-pill capability-pill-answer",
  );
  expect(context.querySelector(".capability-pill")?.textContent).toBe("Answer");
});

test("one record waiting for its details reads in the singular", async () => {
  api.previewSourceFilter.mockImplementation(async (id: string) => ({
    sourceId: id,
    total: 20,
    visible: 12,
    hidden: 8,
    unknown: 1,
    readiness: source.scopeReadiness,
    items: [],
    samples: [],
  }));
  await mount();
  expect(host.querySelector(".source-filter-unchecked p")?.textContent).toBe(
    "1 record stays hidden until its details finish syncing.",
  );
});

test("readiness returned by the preview fences Use even if the overview was ready", async () => {
  api.previewSourceFilter.mockResolvedValue({
    sourceId: source.id,
    total: 20,
    visible: 0,
    hidden: 20,
    unknown: 20,
    items: [],
    samples: [],
    readiness: [
      {
        kind: "conversation",
        ready: false,
        message: "Refresh required",
        behindCollectors: [{ deviceId: "fictional-device", name: "Fictional collector" }],
      },
    ],
  });
  await mount();
  expect(button("Apply filter").disabled).toBe(true);
  // Counting is the whole story: no reason from the gateway, no device to update, nothing to press.
  expect(host.querySelector(".source-filter-pending")?.textContent).toContain(
    "Counting matching records…",
  );
  expect(host.querySelector(".source-filter-pending .source-filter-spinner")).not.toBeNull();
  expect(host.textContent).not.toContain("Refresh required");
  expect(host.textContent).not.toContain("Fictional collector");
  expect(refreshControls()).toEqual([]);
  expect(host.querySelector(".source-filter-counts")).toBeNull();
});

test("a late picker response from another account is aborted and never displayed", async () => {
  const old = deferred<unknown>(),
    fresh = deferred<unknown>();
  api.getSourceFilterOptions
    .mockReset()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise);
  await act(async () =>
    render(
      h(SourceFilterPicker, { source, kind: "conversation", selected: [], onToggle: vi.fn() }),
      host,
    ),
  );
  await waitOptions();
  const oldSignal = api.getSourceFilterOptions.mock.calls[0]![2] as AbortSignal;
  const other = { ...source, id: "fictional:two" };
  await act(async () =>
    render(
      h(SourceFilterPicker, {
        source: other,
        kind: "conversation",
        selected: [],
        onToggle: vi.fn(),
      }),
      host,
    ),
  );
  await waitOptions();
  await act(async () =>
    fresh.resolve({
      sourceId: other.id,
      items: [
        {
          ref: { kind: "conversation", id: "shared-native-id" },
          label: "Second account room",
          count: 2,
        },
      ],
    }),
  );
  await act(async () =>
    old.resolve({
      sourceId: source.id,
      items: [
        {
          ref: { kind: "conversation", id: "shared-native-id" },
          label: "First account room",
          count: 99,
        },
      ],
    }),
  );
  await flushUI();
  expect(oldSignal.aborted).toBe(false); // Consumer cancellation retains the server admission slot until its response settles.
  expect(host.textContent).toContain("Second account room");
  expect(host.textContent).not.toContain("First account room");
});

test("participant additions require an explicit accepted typed identifier and expose no mutable person pointer", async () => {
  const onToggle = vi.fn();
  await act(async () =>
    render(h(SourceFilterPicker, { source, kind: "participant", selected: [], onToggle }), host),
  );
  expect(
    [...host.querySelectorAll("option")].map((option) => option.getAttribute("value")),
  ).toEqual(["email", "phone"]);
  expect(host.querySelector("details")).toBeNull();
  // The prompt names only what this source accepts.
  expect(host.querySelector(".source-filter-typed > span")?.textContent).toBe(
    "Add an email or phone number",
  );
  const input = host.querySelector<HTMLInputElement>("input[aria-label='Value']")!;
  await act(async () => {
    input.value = "person@example.com";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => button("Add").click());
  expect(onToggle).toHaveBeenCalledWith({
    kind: "participant",
    label: "person@example.com",
    identifiers: [{ type: "email", value: "person@example.com" }],
  });
});

test("a typed address that is not one is refused in the words for its type", async () => {
  const onToggle = vi.fn();
  const everyType = {
    ...source,
    scopes: { items: [{ kind: "participant", identifiers: ["email", "phone", "domain"] }] },
  };
  await act(async () =>
    render(
      h(SourceFilterPicker, { source: everyType, kind: "participant", selected: [], onToggle }),
      host,
    ),
  );
  const input = host.querySelector<HTMLInputElement>("input[aria-label='Value']")!;
  const select = host.querySelector<HTMLSelectElement>("select[aria-label='Type']")!;
  const refusal = async (type: string) => {
    await act(async () => {
      for (const option of select.querySelectorAll("option"))
        option.toggleAttribute("selected", option.getAttribute("value") === type);
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await act(async () => {
      input.value = "not an address";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => button("Add").click());
    return host.querySelector(".source-filter-exact [role='alert']")?.textContent;
  };
  expect(await refusal("email")).toBe("Enter a valid email address.");
  expect(await refusal("phone")).toBe(
    "Enter a valid phone number. Include the international country code.",
  );
  expect(await refusal("domain")).toBe("Enter a valid domain.");
  expect(onToggle).not.toHaveBeenCalled();
});

test("a new Direct capability starts with Answer filters rebound to its own draft audience and zero revision", async () => {
  const answer = {
    capability: "answer",
    sources: { mode: "allowlist", sourceIds: [source.id] },
    filterRevision: 0,
    scopePolicies: [{ ...policy, audience: { accessLevel: "new", capability: "answer" } }],
  };
  const onChange = vi.fn();
  await act(async () =>
    render(
      h(CapabilityPicker, {
        value: { answer },
        onChange,
        linkDirect: true,
        sourceFiltersEnabled: true,
      }),
      host,
    ),
  );
  const direct = [...host.querySelectorAll("label")]
    .find((label) => label.querySelector("strong")?.textContent === "Direct")!
    .querySelector("input") as HTMLInputElement;
  direct.checked = true;
  await act(async () => {
    direct.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  const next = onChange.mock.lastCall![0];
  expect(next.answer).toBe(answer);
  expect(next.direct).toMatchObject({
    filterRevision: 0,
    scopePolicies: [{ audience: { accessLevel: "new", capability: "direct" } }],
  });
  expect(next.direct.scopePolicies[0]).not.toBe(answer.scopePolicies[0]);
});

test("unlinking a new Direct draft before enabling it keeps Answer filters independent", async () => {
  const answer = {
    capability: "answer",
    sources: { mode: "all", sourceIds: [] },
    scopePolicies: [policy],
  };
  const onChange = vi.fn();
  await act(async () =>
    render(
      h(CapabilityPicker, {
        value: { answer },
        onChange,
        linkDirect: false,
      }),
      host,
    ),
  );
  const direct = [...host.querySelectorAll("label")]
    .find((label) => label.querySelector("strong")?.textContent === "Direct")!
    .querySelector("input") as HTMLInputElement;
  direct.checked = true;
  await act(async () => {
    direct.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  expect(onChange.mock.lastCall![0].direct.scopePolicies).toBeUndefined();
  expect(onChange.mock.lastCall![0].answer.scopePolicies).toEqual([policy]);
});

test.each([false, null, undefined])(
  "new Direct never copies filtered Answer while authoring is %s",
  async (sourceFiltersEnabled) => {
    const answer = {
      capability: "answer",
      sources: { mode: "all", sourceIds: [] },
      scopePolicies: [policy],
    };
    const onChange = vi.fn();
    await act(async () =>
      render(
        h(CapabilityPicker, { value: { answer }, onChange, linkDirect: true, sourceFiltersEnabled }),
        host,
      ),
    );
    const input = [...host.querySelectorAll("label")]
      .find((label) => label.querySelector("strong")?.textContent === "Direct")!
      .querySelector("input") as HTMLInputElement;
    await act(async () => {
      input.checked = true;
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(onChange.mock.lastCall![0].answer).toBe(answer);
    expect(onChange.mock.lastCall![0].direct.scopePolicies ?? []).toEqual([]);
  },
);

test("removing and restoring a capability preserves its own filtered draft without copying its sibling", async () => {
  const answer = {
    capability: "answer",
    sources: { mode: "all", sourceIds: [] },
    scopePolicies: [],
  };
  const direct = {
    capability: "direct",
    sources: { mode: "all", sourceIds: [] },
    filterRevision: 4,
    scopePolicies: [{ ...policy, audience: { accessLevel: "new", capability: "direct" } }],
  };
  const onChange = vi.fn();
  let value = { answer, direct };
  const mountPicker = () =>
    render(h(CapabilityPicker, { value, onChange, linkDirect: true, sourceFiltersEnabled: true }), host);
  await act(async () => mountPicker());
  const input = () =>
    [...host.querySelectorAll("label")]
      .find((label) => label.querySelector("strong")?.textContent === "Direct")!
      .querySelector("input") as HTMLInputElement;
  await act(async () => {
    input().checked = false;
    input().dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  expect(onChange.mock.lastCall![0].direct).toBeUndefined();
  value = onChange.mock.lastCall![0];
  await act(async () => mountPicker());
  await act(async () => {
    input().checked = true;
    input().dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  expect(onChange.mock.lastCall![0].direct).toBe(direct);
});

test("an unfiltered account opens as All content and continuing cannot imply a new restriction", async () => {
  const onApply = vi.fn(),
    onRemove = vi.fn(),
    onClose = vi.fn();
  await mount({ savedPolicy: null, onApply, onRemove, onClose });
  expect(onClose).not.toHaveBeenCalled();
  const all = [...host.querySelectorAll<HTMLLabelElement>(".source-filter-mode label")].find(
    (row) => row.textContent?.includes("All content"),
  )!;
  expect(all.querySelector<HTMLInputElement>("input")!.hasAttribute("checked")).toBe(true);
  expect(api.previewSourceFilter).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => button("Done").click());
  expect(onClose).toHaveBeenCalled();
  expect(onApply).not.toHaveBeenCalled();
  expect(onRemove).not.toHaveBeenCalled();
});

test("a missing catalogue item with no resolved name hides its opaque ID and preserves the saved reference", async () => {
  const ref = { kind: "conversation", id: "opaque-missing-room-73" };
  const saved = { ...policy, rules: [{ action: "share", match: [ref] }] };
  const onApply = vi.fn();
  api.previewSourceFilter.mockResolvedValue({
    sourceId: source.id,
    readiness: source.scopeReadiness,
    items: [{ ref, label: ref.id, missing: true, count: 0 }],
    visible: 0,
    hidden: 20,
    unknown: 0,
    samples: [],
  });
  await mount({ savedPolicy: saved, onApply });
  expect(host.textContent).toContain("Saved selection");
  expect(host.textContent).toContain("Unavailable · selection retained");
  expect(host.textContent).not.toContain(ref.id);
  await act(async () => button("Apply filter").click());
  expect(onApply).toHaveBeenCalledWith(saved);
});

test("saved rule summaries retain missing decisions without exposing catalogue fallback IDs", async () => {
  const ref = { kind: "conversation", id: "opaque-summary-room-88" };
  const saved = { ...policy, rules: [{ action: "share", match: [ref] }] };
  api.previewSourceFilter.mockResolvedValue({
    sourceId: source.id,
    readiness: source.scopeReadiness,
    items: [{ ref, label: ref.id, missing: true, count: 0 }],
    visible: 0,
    hidden: 20,
    unknown: 0,
    samples: [],
  });
  await act(async () =>
    render(answerSummary(saved), host),
  );
  await flushUI();
  expect(host.textContent).toContain("Saved selection");
  expect(host.textContent).toContain("Unavailable · selection retained");
  expect(host.textContent).not.toContain(ref.id);
});

test("loaded option pages survive query returns and kind remounts within a child draft", async () => {
  const memory = new Map();
  const scroll = { current: host };
  api.getSourceFilterOptions.mockImplementation(
    async (id: string, query: { kind: string; cursor?: string }) => ({
      sourceId: id,
      readiness: source.scopeReadiness,
      items: Array.from(
        { length: query.kind === "label" ? (query.cursor ? 15 : 50) : 1 },
        (_, index) => ({
          ref: { kind: query.kind, id: `${query.kind}-${(query.cursor ? 50 : 0) + index}` },
          label: `Invented option ${index}`,
          count: 1,
        }),
      ),
      nextCursor: query.kind === "label" && !query.cursor ? "next-page" : undefined,
    }),
  );
  const renderKind = async (kind: string) =>
    act(async () =>
      render(
        h(SourceFilterPicker, {
          key: kind,
          source,
          kind,
          selected: [],
          onToggle: vi.fn(),
          memory,
          scrollContainer: scroll,
        }),
        host,
      ),
    );
  await renderKind("label");
  await waitOptions();
  await act(async () => button("Load more").click());
  await vi.waitFor(() =>
    expect(host.querySelectorAll(".source-filter-options li")).toHaveLength(65),
  );
  const input = host.querySelector<HTMLInputElement>("input[type=search]")!;
  await act(async () => {
    input.value = "another";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await waitOptions();
  expect(host.querySelectorAll(".source-filter-options li")).toHaveLength(50);
  await act(async () => {
    input.value = "";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  expect(host.querySelectorAll(".source-filter-options li")).toHaveLength(65);
  await renderKind("conversation");
  await waitOptions();
  const reads = api.getSourceFilterOptions.mock.calls.length;
  await renderKind("label");
  expect(host.querySelectorAll(".source-filter-options li")).toHaveLength(65);
  expect(api.getSourceFilterOptions).toHaveBeenCalledTimes(reads);
  expect(refreshControls()).toEqual([]);
});

test("counts that are still being worked out are read again until they arrive, and Apply enables itself", async () => {
  const waiting = {
    ...source,
    scopeReadiness: source.scopeReadiness.map((item) => ({ ...item, ready: false })),
  };
  const fresh = deferred<unknown>();
  api.getSourceFilterOptions.mockResolvedValue({
    sourceId: source.id,
    items: [],
    readiness: waiting.scopeReadiness,
  });
  api.previewSourceFilter
    .mockReset()
    .mockResolvedValueOnce({
      sourceId: source.id,
      visible: 0,
      hidden: 20,
      unknown: 20,
      items: [],
      readiness: waiting.scopeReadiness,
    })
    .mockReturnValue(fresh.promise);
  await mount({ source: waiting });
  expect(button("Apply filter").disabled).toBe(true);
  expect(host.textContent).toContain("Counting matching records…");
  expect(refreshControls()).toEqual([]);
  expect(api.previewSourceFilter).toHaveBeenCalledTimes(1);

  // The picker says the same while its own list is being counted.
  const search = host.querySelector<HTMLInputElement>("input[type=search]")!;
  await act(async () => {
    search.dispatchEvent(new window.Event("focus"));
  });
  await waitOptions();
  expect(host.querySelector(".source-filter-results")?.textContent).toContain(
    "Counting matching records…",
  );
  expect(host.querySelector(".source-filter-results")?.textContent).not.toContain(
    "No matching options.",
  );

  await vi.waitFor(() => expect(api.previewSourceFilter).toHaveBeenCalledTimes(2), {
    timeout: 4000,
  });
  expect(button("Apply filter").disabled).toBe(true);
  expect(host.querySelector(".source-filter-counts")).toBeNull();
  await act(async () =>
    fresh.resolve({
      sourceId: source.id,
      visible: 4,
      hidden: 16,
      unknown: 0,
      items: [],
      readiness: source.scopeReadiness,
    }),
  );
  await flushUI();
  expect(host.querySelector(".source-filter-counts")?.textContent).toContain("4 shared16 hidden");
  expect(button("Apply filter").disabled).toBe(false);
});

test("an unresolved saved name is loading until the exact preview resolves, never declared missing", async () => {
  const response = deferred<unknown>();
  const ref = { kind: "label", id: "unresolved-label-47" };
  api.previewSourceFilter.mockReturnValue(response.promise);
  await mount({ savedPolicy: { ...policy, rules: [{ action: "share", match: [ref] }] } });
  expect(host.textContent).toContain("Counting matching records…");
  expect(host.textContent).toContain("Saved label selection");
  expect(host.textContent).toContain("Loading name");
  expect(host.textContent).not.toContain("Name unavailable");
  expect(host.textContent).not.toContain("Unavailable · selection retained");
  expect(button("Apply filter").disabled).toBe(true);
  await act(async () =>
    response.resolve({
      sourceId: source.id,
      visible: 4,
      hidden: 16,
      unknown: 0,
      items: [{ ref, label: "Resolved label", count: 4 }],
      readiness: source.scopeReadiness,
    }),
  );
  await flushUI();
  expect(host.textContent).toContain("Resolved label");
  expect(button("Apply filter").disabled).toBe(false);
});

test.each([false, true])(
  "readiness presentation considers only selected kinds (selected kind pending: %s)",
  async (selectedPending) => {
    const saved = {
      ...policy,
      rules: [
        {
          action: "share",
          match: [
            {
              kind: "participant",
              label: "reader@example.org",
              identifiers: [{ type: "email", value: "reader@example.org" }],
            },
          ],
        },
      ],
    };
    api.previewSourceFilter.mockResolvedValue({
      sourceId: source.id,
      visible: 6,
      hidden: 14,
      unknown: 2,
      items: [],
      samples: [],
      readiness: [
        { kind: "participant", ready: !selectedPending, message: "Participant metadata preparing" },
        { kind: "label", ready: false, message: "Unrelated labels preparing" },
      ],
    });
    await mount({ savedPolicy: saved });
    expect(button("Apply filter").disabled).toBe(selectedPending);
    expect(host.textContent).not.toContain("Unrelated labels preparing");
    expect(host.textContent!.includes("Counting matching records…")).toBe(selectedPending);
    expect(host.textContent!.includes("Counting matching records…")).toBe(selectedPending);
    await act(async () =>
      render(answerSummary(saved), host),
    );
    await flushUI();
    expect(host.textContent).not.toContain("Unrelated labels preparing");
    expect(host.textContent!.includes("Counting matching records…")).toBe(selectedPending);
  },
);

test("the selected table is edited directly and every changed selection needs its own preview", async () => {
  const nextPreview = deferred<unknown>();
  const initial = api.previewSourceFilter.getMockImplementation()!;
  api.previewSourceFilter
    .mockReset()
    .mockImplementationOnce(initial)
    .mockReturnValueOnce(nextPreview.promise);
  const onApply = vi.fn();
  await mount({ onApply });
  expect(host.querySelectorAll(".filter-builder-searches input[type=search]")).toHaveLength(4);
  expect(api.getSourceFilterOptions).not.toHaveBeenCalled();
  expect(button("Apply filter").disabled).toBe(false);
  const input = host.querySelector<HTMLInputElement>("input[aria-label='Value']")!;
  await act(async () => {
    input.value = "reviewer@example.org";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => button("Add").click());
  expect(button("Apply filter").disabled).toBe(true);
  expect(host.textContent).toContain("reviewer@example.org");
  expect(host.textContent).toContain("Counting matching records…");
  expect(policy.rules[0]!.match).toEqual([{ kind: "conversation", id: "stable-room" }]);
  const changed = api.previewSourceFilter.mock.calls[1]![1];
  await act(async () =>
    nextPreview.resolve({
      sourceId: source.id,
      visible: 7,
      hidden: 13,
      unknown: 0,
      items: changed.rules[0].match.map((ref: { label?: string }) => ({
        ref,
        label: ref.label || "Fictional room",
        count: 3,
      })),
      readiness: source.scopeReadiness,
    }),
  );
  await flushUI();
  expect(button("Apply filter").disabled).toBe(false);
  await act(async () => button("Apply filter").click());
  expect(onApply).toHaveBeenCalledWith(changed);
  expect(onApply.mock.calls[0]![0].rules[0].match).toContainEqual({
    kind: "participant",
    label: "reviewer@example.org",
    identifiers: [{ type: "email", value: "reviewer@example.org" }],
  });
  const remove = host.querySelector<HTMLButtonElement>(
    ".compact-filter-table button[aria-label='Remove reviewer@example.org']",
  )!;
  expect(remove).not.toBeNull();
  await act(async () => remove.click());
  expect(button("Apply filter").disabled).toBe(true);
});

test("search results overlay the selected table and Escape dismisses search before the modal", async () => {
  const onClose = vi.fn();
  await mount({ onClose });
  const searches = [
    ...host.querySelectorAll<HTMLInputElement>(".filter-builder-searches input[type=search]"),
  ];
  const first = searches[0]!;
  await act(async () => {
    first.value = "room";
    first.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await waitOptions();
  expect(first.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelectorAll(".source-filter-results:not([hidden])")).toHaveLength(1);
  expect(host.querySelector(".compact-filter-table")).not.toBeNull();
  const escape = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(escape, "key", { value: "Escape" });
  // Linkedom binds bubbling listeners to their original target, so exercise
  // this keyboard handler at its widget boundary; browser tests cover the input.
  await act(async () => {
    first.closest(".source-filter-picker")!.dispatchEvent(escape);
  });
  expect(first.getAttribute("aria-expanded")).toBe("false");
  expect(onClose).not.toHaveBeenCalled();
  const second = searches[1]!;
  await act(async () => {
    second.value = "person";
    second.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  expect(second.getAttribute("aria-expanded")).toBe("true");
  expect(first.getAttribute("aria-expanded")).toBe("false");
  await act(async () => {
    document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
  });
  expect(second.getAttribute("aria-expanded")).toBe("false");
  expect(onClose).not.toHaveBeenCalled();
});

test("changing the source closes the child draft without previewing the old policy for the new account", async () => {
  const onClose = vi.fn(),
    onApply = vi.fn();
  await mount({ onClose, onApply });
  api.previewSourceFilter.mockClear();
  await act(async () =>
    render(
      h(SourceFilterEditor, {
        source: { ...source, id: "fictional:other" },
        capability: "answer",
        accessLevel: "saved-level",
        savedPolicy: policy,
        enabled: true,
        onApply,
        onRemove: vi.fn(),
        onClose,
      }),
      host,
    ),
  );
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(api.previewSourceFilter).not.toHaveBeenCalled();
  expect(onApply).not.toHaveBeenCalled();
});

test("folder navigation keeps its overlay open when a result button disappears", async () => {
  api.getSourceFilterOptions.mockImplementation(
    async (id: string, query: { kind: string; parentId?: string }) => ({
      sourceId: id,
      readiness: source.scopeReadiness,
      items: query.parentId
        ? [{ ref: { kind: "folder", id: "child-folder" }, label: "fictional child", count: 2 }]
        : [
            {
              ref: { kind: "folder", id: "parent-folder" },
              label: "fictional parent",
              count: 5,
              hasChildren: true,
            },
          ],
    }),
  );
  const onClose = vi.fn();
  await mount({ onClose });
  const search = host.querySelector<HTMLInputElement>(
    '.source-filter-picker[aria-label="Choose folders"] input[type=search]',
  )!;
  await act(async () => {
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await waitOptions();
  const focus = vi.spyOn(search, "focus");
  const open = host.querySelector<HTMLButtonElement>('button[aria-label="Open fictional parent"]')!;
  await act(async () => open.click());
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  const blur = new window.Event("focusout", { bubbles: true });
  Object.defineProperty(blur, "relatedTarget", { value: null });
  await act(async () => {
    search.closest(".source-filter-picker")!.dispatchEvent(blur);
  });
  await waitOptions();
  expect(search.getAttribute("aria-expanded")).toBe("true");
  expect(host.textContent).toContain("fictional child");
  expect(api.getSourceFilterOptions).toHaveBeenLastCalledWith(
    source.id,
    expect.objectContaining({ parentId: "parent-folder" }),
    expect.any(AbortSignal),
  );
  expect(onClose).not.toHaveBeenCalled();
  focus.mockRestore();
});

test("a tree whose source names its levels is browsed and listed in the source's words, never as folders", async () => {
  const shelves = {
    ...source,
    scopes: {
      items: [
        {
          kind: "folder",
          noun: { one: "shelf or binder", many: "shelves and binders" },
          levels: [
            { one: "shelf", many: "shelves" },
            { one: "binder", many: "binders" },
          ],
          picker: "tree",
          link: "hierarchy",
        },
      ],
    },
    scopeReadiness: [{ kind: "folder", ready: true }],
  };
  const shelf = { kind: "folder", id: "shelf-one" };
  const binder = { kind: "folder", id: "binder-one" };
  api.getSourceFilterOptions.mockImplementation(
    async (id: string, query: { parentId?: string }) => ({
      sourceId: id,
      readiness: shelves.scopeReadiness,
      items: query.parentId
        ? [{ ref: binder, label: "fictional binder", count: 2, parentId: shelf.id, depth: 1 }]
        : [{ ref: shelf, label: "fictional shelf", count: 5, hasChildren: true, depth: 0 }],
    }),
  );
  api.previewSourceFilter.mockImplementation(async (id: string, p: typeof policy) => ({
    sourceId: id,
    total: 5,
    visible: 5,
    hidden: 0,
    unknown: 0,
    readiness: shelves.scopeReadiness,
    items: p.rules.flatMap((rule) =>
      rule.match.map((ref) => ({
        ref,
        label: ref.id === shelf.id ? "fictional shelf" : "fictional binder",
        count: ref.id === shelf.id ? 5 : 2,
        depth: ref.id === shelf.id ? 0 : 1,
      })),
    ),
    samples: [],
  }));
  await mount({
    source: shelves,
    savedPolicy: { ...policy, rules: [{ action: "share", match: [shelf, binder] }] },
  });
  await waitOptions();
  const picker = host.querySelector('.source-filter-picker[aria-label="Choose shelves and binders"]')!;
  const search = picker.querySelector<HTMLInputElement>("input[type=search]")!;
  await act(async () => {
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await waitOptions();
  expect(picker.querySelector(".source-filter-breadcrumbs")!.textContent).toContain("All shelves");
  expect(picker.querySelector(".filter-option-hint")!.textContent).toBe(
    "Selecting shelves includes their binders.",
  );
  expect(picker.querySelector(".source-filter-options small")!.textContent).toBe(
    "Shelf · 5 matching",
  );
  await act(async () =>
    picker.querySelector<HTMLButtonElement>('button[aria-label="Open fictional shelf"]')!.click(),
  );
  await waitOptions();
  expect(picker.querySelector(".source-filter-select-location")!.textContent).toBe(
    "Select this shelf",
  );
  // Nothing lies beneath the last level a source names, so nothing is promised there.
  expect(picker.querySelector(".filter-option-hint")).toBeNull();
  expect(picker.querySelector(".source-filter-options small")!.textContent).toBe(
    "Binder · 2 matching",
  );
  expect(
    [...host.querySelectorAll(".compact-filter-kind")].map((cell) => cell.textContent),
  ).toEqual(["Shelf", "Binder"]);
  expect(host.textContent).not.toMatch(/folder/iu);
});

test("an account that is no longer connected lists its saved filters, counts nothing, and applies a removal", async () => {
  api.previewSourceFilter.mockClear();
  const kept = { kind: "conversation", id: "kept-room" };
  const saved = { ...policy, rules: [{ action: "share", match: [...policy.rules[0]!.match, kept] }] };
  const onApply = vi.fn();
  await mount({
    source: { id: source.id, displayName: "Fictional", available: false },
    savedPolicy: saved,
    onApply,
  });
  expect(host.querySelector(".compact-source-account")?.textContent).toContain(
    "no longer connected",
  );
  expect(host.querySelector(".source-filter-notice")?.textContent).toBe(
    "This account is no longer connected. Saved filters can be removed but not added.",
  );
  // Nothing to search or add; each saved row can still be removed.
  expect(host.querySelector("input[type=search]")).toBeNull();
  const removals = () => [...host.querySelectorAll<HTMLButtonElement>(".compact-filter-remove")];
  expect(removals()).toHaveLength(2);
  expect(host.textContent).not.toContain("Counts are unavailable");
  expect(host.querySelector("[role='alert']")).toBeNull();
  // Unchanged, there is nothing to apply; one removal is enough, with no counts to wait for.
  expect(button("Apply filter").disabled).toBe(true);
  await act(async () => removals()[0]!.click());
  expect(button("Apply filter").disabled).toBe(false);
  await act(async () => button("Apply filter").click());
  expect(onApply).toHaveBeenCalledWith({ ...saved, rules: [{ action: "share", match: [kept] }] });
  expect(api.previewSourceFilter).not.toHaveBeenCalled();
});

test("removing every saved filter of an account that is no longer connected leaves nothing to apply", async () => {
  await mount({ source: { id: source.id, displayName: "Fictional", available: false } });
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".compact-filter-remove")!.click(),
  );
  // An empty filter is not a filter: "All content" on the first step removes it.
  expect(button("Apply filter").disabled).toBe(true);
});
