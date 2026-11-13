// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { runSchemaSetup } from "../../../src/data/schema.js";
import { createDevice } from "../../../src/data/repositories/DeviceRepository.js";
import { createAccessLevel } from "../../../src/access/store-levels.js";
import { upsertSourceScopes } from "../../../src/access/scope-descriptors.js";
const api = vi.hoisted(() => ({
  decideAccessAuthorization: vi.fn(),
  previewSourceFilter: vi.fn(),
  getSourceFilterOptions: vi.fn(),
}));
vi.mock("../api.js", () => api);
// @ts-expect-error — portal modules are plain JavaScript.
import { buildAuthorizationSelection, RequestReview } from "../views/access/authorization.js";
// @ts-expect-error — portal modules are plain JavaScript.
import { serializeNewAuthorityRules, newAuthorityFilterError } from "./grant-builder-state.js";

const policy = {
  sourceId: "fictional:one",
  audience: { accessLevel: "previous-level", capability: "direct" },
  rules: [{ action: "share", match: [{ kind: "conversation", id: "stable-room" }] }],
  otherwise: "hide",
};
const saved = {
  capability: "direct",
  sources: { mode: "all", sourceIds: [] },
  filterRevision: 7,
  scopePolicies: [policy],
};
let db: Database.Database;
let host: HTMLElement | undefined;
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  db = new Database(":memory:");
  runSchemaSetup(db);
  const device = createDevice(db, { name: "Fictional collector", kind: "collector" }).id;
  db.prepare(
    "INSERT INTO sources(id,type,account_id,device_id,created_at,updated_at) VALUES('fictional:one','fictional','one',?,1,1)",
  ).run(device);
  const scopes = {
    items: [
      {
        kind: "conversation" as const,
        noun: { one: "room", many: "rooms" },
        picker: "search" as const,
        link: "fixed" as const,
      },
    ],
  };
  upsertSourceScopes(db, [{ sourceType: "fictional", scopes }], 1);
  db.prepare(
    "INSERT INTO scope_fact_backfill(source_id,source_type,descriptor_json,ready) VALUES('fictional:one','fictional',?,1)",
  ).run(JSON.stringify(scopes));
});
afterEach(() => {
  if (host) act(() => render(null, host!));
  host = undefined;
  db.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("new consent and management authorities use fresh revision/audience at the actual creation seam", () => {
  const selection = buildAuthorizationSelection({
    kind: "new-level",
    name: "Fictional connection",
    levelName: "Fictional dedicated access",
    rules: { direct: saved },
  });
  const managementRules = serializeNewAuthorityRules({ direct: saved });
  expect(selection.level.rules).toEqual(managementRules);
  for (const [index, rules] of [selection.level.rules, managementRules].entries()) {
    expect(rules[0]).toMatchObject({
      filterRevision: 0,
      scopePolicies: [{ audience: { accessLevel: "new", capability: "direct" } }],
    });
    const created = createAccessLevel(db, {
      name: `Fictional fresh level ${index}`,
      rules,
      actorTokenId: "owner",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    expect(created.value.rules[0]).toMatchObject({
      filterRevision: 1,
      scopePolicies: [{ audience: { accessLevel: created.value.id, capability: "direct" } }],
    });
  }
  expect(saved.filterRevision).toBe(7);
  expect(saved.scopePolicies[0]!.audience.accessLevel).toBe("previous-level");
});

test("a cleared nonzero overlay can seed a fresh unfiltered level with authoring off", () => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  const state = { direct: { ...saved, scopePolicies: [] } };
  expect(newAuthorityFilterError(state, false)).toBeNull();
  const rules = serializeNewAuthorityRules(state);
  expect(rules[0]).toMatchObject({ filterRevision: 0, scopePolicies: [] });
  const created = createAccessLevel(db, {
    name: "Fictional whole-source copy",
    rules,
    actorTokenId: "owner",
  });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error);
  expect(created.value.rules[0]!.scopePolicies ?? []).toEqual([]);
});

test.each([false, null, undefined])(
  "filtered new authority is blocked without stripping restrictions when authoring is %s",
  (enabled) => {
    const state = { direct: saved };
    expect(newAuthorityFilterError(state, enabled)).toContain("Choose an existing access level");
    expect(state.direct.scopePolicies).toEqual([policy]);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    expect(
      createAccessLevel(db, {
        name: "Fictional refused copy",
        rules: serializeNewAuthorityRules(state),
        actorTokenId: "owner",
      }),
    ).toEqual({ ok: false, error: "invalid-selection" });
  },
);

test("reusing an existing level or replacing a connection keeps original authority identifiers and revisions", () => {
  const level = { id: "previous-level", revision: 9, rules: [saved] };
  expect(
    buildAuthorizationSelection({
      kind: "existing-level",
      name: "Fictional connection",
      level,
      rules: { direct: saved },
    }),
  ).toEqual({
    kind: "new-connection",
    name: "Fictional connection",
    level: { kind: "existing", levelId: "previous-level", expectedLevelRevision: 9 },
  });
  expect(
    buildAuthorizationSelection({
      kind: "replace",
      connection: { id: "original-connection", grant: { revision: 11 } },
      rules: { direct: saved },
    }),
  ).toEqual({
    kind: "replace-connection",
    connectionId: "original-connection",
    expectedGrantRevision: 11,
  });
  expect(saved.filterRevision).toBe(7);
});

async function openApproval(enabled: boolean | null | undefined) {
  const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  api.decideAccessAuthorization.mockReset().mockResolvedValue({});
  api.previewSourceFilter
    .mockReset()
    .mockResolvedValue({
      sourceId: "fictional:one",
      total: 1,
      visible: 1,
      hidden: 0,
      unknown: 0,
      items: [],
      readiness: [],
    });
  await act(async () =>
    render(
      h(RequestReview, {
        request: {
          id: "request",
          approvalId: "approval",
          status: "pending",
          clientName: "Fictional assistant",
          resource: "https://gateway.example.org/mcp",
          redirectOrigin: "https://agent.example.org/callback",
          expiresAt: Date.now() + 60000,
        },
        connection: {
          defaultName: "Fictional new connection",
          defaultLevelName: "Fictional copied level",
          recommended: "existing-level",
          match: {
            connectionId: "old-connection",
            levelId: "previous-level",
            grant: { revision: 3, rules: [saved] },
          },
        },
        overview: {
          sourceFilters: { enabled },
          sources: [{ id: "fictional:one", displayName: "Fictional source", available: true }],
          levels: [
            {
              id: "previous-level",
              name: "Fictional existing level",
              revision: 9,
              connectionCount: 1,
              rules: [saved],
            },
          ],
          principals: [],
        },
        onDone: vi.fn(),
      }),
      host!,
    ),
  );
}
function choice(name: string): HTMLInputElement {
  return [...host!.querySelectorAll("label")]
    .find((label) => label.textContent?.includes(name))!
    .querySelector("input") as HTMLInputElement;
}
function continueButton(): HTMLButtonElement {
  return [...host!.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === "Continue",
  )!;
}
async function choose(name: string) {
  await act(async () => {
    const input = choice(name);
    input.checked = true;
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

test.each([false, null, undefined])(
  "consent blocks a filtered new-level clone with gate %s while existing-level reuse still works",
  async (enabled) => {
    await openApproval(enabled);
    expect(continueButton().hasAttribute("disabled")).toBe(false);
    await choose("New access level");
    expect(host!.textContent).toContain("Choose an existing access level to keep its filters");
    expect(continueButton().hasAttribute("disabled")).toBe(true);
    expect(api.decideAccessAuthorization).not.toHaveBeenCalled();
    await choose("Fictional existing level");
    expect(host!.textContent).not.toContain(
      "Choose an existing access level to keep its filters",
    );
    expect(continueButton().hasAttribute("disabled")).toBe(false);
    await act(async () => continueButton().click());
    const allow = [...host!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.trim().startsWith("Allow "),
    )!;
    await act(async () => allow.click());
    expect(api.decideAccessAuthorization).toHaveBeenCalledWith("approval", {
      decision: "approve",
      selection: {
        kind: "new-connection",
        name: "Fictional new connection",
        level: { kind: "existing", levelId: "previous-level", expectedLevelRevision: 9 },
      },
    });
  },
);

test("consent with authoring on submits the matched filters as a new authority, not their old revision", async () => {
  await openApproval(true);
  await choose("New access level");
  // Every decision of the new level is left as the matched connection had it.
  for (let step = 0; step < 8 && continueButton(); step++)
    await act(async () => continueButton().click());
  const allow = [...host!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
    button.textContent?.trim().startsWith("Allow "),
  )!;
  await act(async () => allow.click());
  expect(api.decideAccessAuthorization.mock.lastCall![1].selection.level.rules[0]).toMatchObject({
    filterRevision: 0,
    scopePolicies: [{ audience: { accessLevel: "new", capability: "direct" } }],
  });
});
