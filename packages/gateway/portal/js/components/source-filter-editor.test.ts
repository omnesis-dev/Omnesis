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
import { SourcePolicySummary } from "./source-filter-preview.js";
// @ts-expect-error — portal modules are plain JavaScript.
import { SourceFilters } from "./source-filters.js";
// @ts-expect-error — portal modules are plain JavaScript.
import { CapabilityPicker, GrantDataPrivacy } from "./grant-builder.js";

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
    await act(async () => button("Review filter").click());
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
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("shows exact counts, unknown withholding, missing resolved labels and records without changing saved policy", async () => {
  const saved = {
    ...policy,
    rules: [{ action: "share", match: [{ kind: "conversation", id: "missing-room" }] }],
  };
  await mount({ savedPolicy: saved });
  expect(host.textContent).toContain("Retired room");
  expect(host.textContent).toContain("Missing — decision retained");
  expect(host.querySelector(".source-filter-counts")?.textContent).toContain(
    "12 visible8 hidden3 unknown",
  );
  expect(host.textContent).toContain("Unknown records are included in hidden");
  expect(host.textContent).toContain("Fictional sample");
  expect(saved.rules[0]!.match[0]!.id).toBe("missing-room");
});

test("saved filters remain inspectable and immutable when the authoring gate is off", async () => {
  const onApply = vi.fn(),
    onRemove = vi.fn();
  await mount({ enabled: false, onApply, onRemove });
  await waitOptions();
  expect(host.textContent).toContain("saved restriction remains enforced");
  expect(host.textContent).not.toContain("Apply filter");
  expect(host.textContent).not.toContain("Remove this source filter");
  expect(host.querySelector(".source-filter-options input")).toBeNull();
  expect(onApply).not.toHaveBeenCalled();
  expect(onRemove).not.toHaveBeenCalled();
});

test.each([false, null, undefined])(
  "a closed or absent authoring gate (%s) hides descriptor-only actions while keeping saved inspection",
  async (enabled) => {
    const sibling = { ...source, id: "fictional:two", displayName: "Unfiltered sibling" };
    const value = {
      answer: {
        capability: "answer",
        sources: { mode: "all", sourceIds: [] },
        scopePolicies: [policy],
      },
      direct: {
        capability: "direct",
        sources: { mode: "all", sourceIds: [] },
        scopePolicies: [],
      },
    };
    const onChange = vi.fn();
    const props = { value, sources: [source, sibling], enabled, onChange };
    await act(async () => render(h(SourceFilters, props), host));
    expect(host.querySelectorAll(".source-filter-source")).toHaveLength(1);
    expect(host.textContent).not.toContain("Unfiltered sibling");
    expect(host.textContent).not.toContain("Add filter");
    expect(host.textContent).not.toContain("Copy Answer filters to Direct once");
    await act(async () => button("Inspect saved filter").click());
    expect(host.textContent).toContain("saved restriction remains enforced");
    expect(host.textContent).not.toContain("Apply filter");
    expect(host.textContent).not.toContain("Remove this source filter");
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => button("Close").click());
    await act(async () => render(h(SourceFilters, { ...props, enabled: true }), host));
    expect(host.querySelectorAll(".source-filter-source")).toHaveLength(4);
    expect(
      [...host.querySelectorAll("button")].filter(
        (entry) => entry.textContent?.trim() === "Add filter",
      ),
    ).toHaveLength(3);
  },
);

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
  await act(async () => button("Back").click());
  const except = [...host.querySelectorAll<HTMLInputElement>(".source-filter-mode input")][2]!;
  await act(async () => {
    except.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await act(async () => button("Continue").click());
  await act(async () => button("Review filter").click());
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
  expect(host.querySelector(".source-filter-counts")?.textContent).toContain("7 visible");
  expect(host.querySelector(".source-filter-counts")?.textContent).not.toContain("99");
  await act(async () => button("Apply filter").click());
  expect(onApply).toHaveBeenCalledWith(
    expect.objectContaining({
      otherwise: "share",
      rules: [{ action: "hide", match: policy.rules[0]!.match }],
    }),
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
  expect(host.textContent).toContain("Refresh required");
  expect(host.textContent).toContain("Fictional collector");
  expect(host.querySelectorAll(".source-filter-readiness")).toHaveLength(1);
  expect(host.textContent).toContain("Provisional counts");
  expect(host.textContent!.indexOf("Refresh required")).toBeLessThan(host.textContent!.indexOf("visible"));
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
  const disclosure = host.querySelector<HTMLDetailsElement>(".source-filter-typed-disclosure")!;
  await act(async () => {
    disclosure.open = true;
    disclosure.dispatchEvent(new window.Event("toggle"));
  });
  const input = host.querySelector<HTMLInputElement>("input[aria-label='Exact identifier']")!;
  await act(async () => {
    input.value = "person@example.com";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => button("Add identifier").click());
  expect(onToggle).toHaveBeenCalledWith({
    kind: "participant",
    label: "person@example.com",
    identifiers: [{ type: "email", value: "person@example.com" }],
  });
});

test("filter linking is separate from source boundaries and saved filters only copy on explicit owner action", async () => {
  const answer = {
    capability: "answer",
    sources: { mode: "all", sourceIds: [] },
    filterRevision: 7,
    scopePolicies: [policy],
  };
  const direct = {
    capability: "direct",
    sources: { mode: "allowlist", sourceIds: [source.id] },
    filterRevision: 3,
    scopePolicies: [],
  };
  const onChange = vi.fn();
  await act(async () =>
    render(
      h(SourceFilters, {
        value: { answer, direct },
        sources: [source],
        enabled: true,
        accessLevel: "saved-level",
        onChange,
      }),
      host,
    ),
  );
  expect(onChange).not.toHaveBeenCalled();
  await act(async () => button("Copy Answer filters to Direct once").click());
  const next = onChange.mock.calls[0]![0];
  expect(next.direct.filterRevision).toBe(3);
  expect(next.direct.sources).toEqual(direct.sources);
  expect(next.direct.scopePolicies[0].audience).toEqual({
    accessLevel: "saved-level",
    capability: "direct",
  });
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
        isNew: true,
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
        isNew: true,
        linkFilters: false,
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
  "closed authoring (%s) protects filtered sources while allowing ordinary source and privacy edits",
  async (sourceFiltersEnabled) => {
    const sibling = { ...source, id: "fictional:two", displayName: "Whole sibling" };
    const answer = {
      capability: "answer",
      sources: { mode: "all", sourceIds: [] },
      release: { mode: "unreviewed" },
      filterRevision: 7,
      scopePolicies: [policy],
    };
    const direct = {
      capability: "direct",
      sources: { mode: "all", sourceIds: [] },
      scopePolicies: [],
    };
    const onChange = vi.fn(),
      onLinkSources = vi.fn();
    await act(async () =>
      render(
        h(GrantDataPrivacy, {
          value: { answer, direct },
          sources: [source, sibling],
          onChange,
          onLinkSources,
          linkSources: true,
          sourceFiltersEnabled,
        }),
        host,
      ),
    );
    const inputs = [...host.querySelectorAll<HTMLInputElement>(".grant-builder-source input")];
    expect(inputs[0]!.hasAttribute("disabled")).toBe(true);
    expect(inputs[1]!.hasAttribute("disabled")).toBe(false);
    expect(button("Block all").hasAttribute("disabled")).toBe(true);
    expect(host.textContent).toContain("Sources with saved filters must stay allowed");
    await act(async () => {
      inputs[1]!.checked = false;
      inputs[1]!.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(onChange.mock.lastCall![0].answer.scopePolicies).toEqual([policy]);
    expect(onChange.mock.lastCall![0].direct.scopePolicies).toEqual([]);
    expect(onChange.mock.lastCall![0].answer.sources).toEqual({
      mode: "denylist",
      sourceIds: [sibling.id],
    });
    const unlink = host.querySelectorAll<HTMLInputElement>(".grant-builder-link-sources input")[1]!;
    expect(unlink.hasAttribute("disabled")).toBe(false);
    await act(async () => {
      unlink.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(onLinkSources).toHaveBeenCalledWith(false);
    const reviewed = host.querySelector<HTMLInputElement>(".grant-builder-release-reviewed input")!;
    await act(async () => {
      reviewed.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(onChange.mock.lastCall![0].answer.scopePolicies).toEqual([policy]);
    expect(onChange.mock.lastCall![0].answer.release.mode).toBe("reviewed");
  },
);

test("a shared source boundary protects saved filters from both capabilities and refuses an incompatible relink", async () => {
  const sibling = { ...source, id: "fictional:two" };
  const answer = {
    capability: "answer",
    sources: { mode: "allowlist", sourceIds: [source.id] },
    release: { mode: "unreviewed" },
    scopePolicies: [],
  };
  const direct = {
    capability: "direct",
    sources: { mode: "allowlist", sourceIds: [sibling.id] },
    scopePolicies: [
      {
        ...policy,
        sourceId: sibling.id,
        audience: { accessLevel: "saved-level", capability: "direct" },
      },
    ],
  };
  const onChange = vi.fn();
  await act(async () =>
    render(
      h(GrantDataPrivacy, {
        value: { answer, direct },
        sources: [source, sibling],
        onChange,
        linkSources: false,
        sourceFiltersEnabled: false,
      }),
      host,
    ),
  );
  expect(
    host
      .querySelector<HTMLInputElement>(".grant-builder-link-sources input")!
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(host.textContent).toContain("Sources with saved filters must stay allowed");
  await act(async () =>
    render(
      h(GrantDataPrivacy, {
        value: {
          answer: { ...answer, sources: { mode: "all", sourceIds: [] } },
          direct: { ...direct, sources: { mode: "all", sourceIds: [] } },
        },
        sources: [source, sibling],
        onChange,
        linkSources: true,
        sourceFiltersEnabled: false,
      }),
      host,
    ),
  );
  const inputs = host.querySelectorAll<HTMLInputElement>(".grant-builder-source input");
  expect(inputs[0]!.hasAttribute("disabled")).toBe(false);
  expect(inputs[1]!.hasAttribute("disabled")).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
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
        h(CapabilityPicker, { value: { answer }, onChange, isNew: true, sourceFiltersEnabled }),
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
    render(h(CapabilityPicker, { value, onChange, isNew: true, sourceFiltersEnabled: true }), host);
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
  const all = [...host.querySelectorAll<HTMLLabelElement>(".guided-choice")].find((row) =>
    row.textContent?.includes("All content"),
  )!;
  expect(all.querySelector<HTMLInputElement>("input")!.hasAttribute("checked")).toBe(true);
  await act(async () => button("Continue").click());
  expect(host.textContent).toContain("All content in this account");
  expect(api.previewSourceFilter).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => button("Share all content").click());
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
  expect(host.textContent).toContain("Missing — decision retained");
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
    render(h(SourcePolicySummary, { policy: saved, source, capability: "Answer" }), host),
  );
  await flushUI();
  expect(host.textContent).toContain("Saved selection");
  expect(host.textContent).toContain("missing, decision retained");
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
  expect(host.textContent).toContain("Refresh list");
});

test("an explicit option refresh can recover readiness while Apply still waits for a fresh policy preview", async () => {
  const waiting = {
    ...source,
    scopeReadiness: source.scopeReadiness.map((item) => ({ ...item, ready: false })),
  };
  const option = {
    sourceId: source.id,
    items: [{ ref: policy.rules[0]!.match[0], label: "Invented room", count: 1 }],
  };
  api.getSourceFilterOptions
    .mockResolvedValueOnce({ ...option, readiness: waiting.scopeReadiness })
    .mockResolvedValueOnce({ ...option, readiness: source.scopeReadiness });
  await mount({ source: waiting });
  await waitOptions();
  expect(host.textContent).toContain("Choose matching content");
  await act(async () => button("Refresh list").click());
  await flushUI();
  await act(async () => button("Review filter").click());
  await flushUI();
  expect(host.textContent).toContain("Review this filter");
  expect(api.previewSourceFilter).toHaveBeenCalled();
  expect(button("Apply filter").disabled).toBe(false);
});

test("an unresolved saved name is loading until the exact preview resolves, never declared missing", async () => {
  const response = deferred<unknown>();
  api.previewSourceFilter.mockReturnValue(response.promise);
  await mount({ savedPolicy: { ...policy, rules: [{ action: "share", match: [{ kind: "label", id: "unresolved-label-47" }] }] } });
  expect(host.textContent).toContain("Loading saved selection name");
  expect(host.textContent).not.toContain("Name unavailable");
  expect(host.textContent).not.toContain("Missing —");
  expect(button("Apply filter").disabled).toBe(true);
});
