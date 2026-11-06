// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test, vi } from "vitest";

// @ts-expect-error — portal modules are plain JS without sibling declarations.
import * as accessApi from "./api.js";

const {
  checkSession,
  completeAccessAuthorization,
  createAccessLevel,
  decideAccessAuthorization,
  deleteAccessLevel,
  getAccessAuthorization,
  getAccessOverview,
  getSourceFilterOptions,
  previewSourceFilter,
  lookupAccessAuthorization,
  moveConnectionLevel,
  revokeAccess,
  updateAccessLevel,
} = accessApi;

afterEach(() => vi.unstubAllGlobals());

describe("delegated access API wrappers", () => {
  test("source picker and preview requests bind the account path, preserve cancellation and use owner CSRF",async()=>{
    const fetchMock=vi.fn(async(input:string)=>input==="/portal/api/session" ? Response.json({authenticated:true,scope:["admin"],csrfToken:"fictional-csrf"}) : Response.json({sourceId:"fictional:account/one",items:[]}));
    vi.stubGlobal("fetch",fetchMock);await checkSession();
    const controller=new AbortController();
    await getSourceFilterOptions("fictional:account/one",{kind:"folder",q:"project",parentId:"folder/root",cursor:"opaque-cursor"},controller.signal);
    const policy={sourceId:"fictional:account/one",audience:{accessLevel:"new",capability:"direct"},rules:[{action:"share",match:[{kind:"folder",id:"folder/root"}]}],otherwise:"hide"};
    await previewSourceFilter("fictional:account/one",policy,controller.signal);
    const get=fetchMock.mock.calls[1] as unknown as [string,RequestInit];
    expect(get[0]).toBe("/admin/access/source-filters/fictional%3Aaccount%2Fone/options?kind=folder&q=project&parentId=folder%2Froot&cursor=opaque-cursor");
    expect(get[1].signal).toBe(controller.signal);
    const post=fetchMock.mock.calls[2] as unknown as [string,RequestInit];
    expect(post[0]).toBe("/admin/access/source-filters/fictional%3Aaccount%2Fone/preview");
    expect(post[1].signal).toBe(controller.signal);
    expect(post[1].headers).toMatchObject({"X-Omnesis-CSRF":"fictional-csrf"});
    expect(JSON.parse(post[1].body as string)).toEqual({policy});
  });
  test("use the Portal access routes and attach CSRF to every mutation", async () => {
    const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
      if (input === "/portal/api/session") {
        return Response.json({ authenticated: true, scope: ["admin"], csrfToken: "csrf-test" });
      }
      if (input === "/admin/access") return Response.json({ principals: [] });
      return Response.json({ request: {}, revoked: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    await checkSession();

    await getAccessOverview();
    await lookupAccessAuthorization("ABCD-EFGH");
    await getAccessAuthorization("approval/1");
    await decideAccessAuthorization("approval/1", {
      decision: "approve",
      selection: {
        kind: "connect",
        rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
        credentialLabel: "example-agent",
      },
    });
    await completeAccessAuthorization("approval/1");
    await revokeAccess("credential", "credential/1");

    expect(fetchMock.mock.calls[1]).toEqual([
      "/admin/access",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    ]);
    expect(fetchMock.mock.calls[2]).toEqual([
      "/portal/api/access/authorizations/lookup",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Omnesis-CSRF": "csrf-test" }),
        body: JSON.stringify({ code: "ABCD-EFGH" }),
      }),
    ]);
    expect(fetchMock.mock.calls[3]).toEqual([
      "/portal/api/access/authorizations/approval%2F1",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    ]);
    expect(fetchMock.mock.calls[4][0]).toBe(
      "/portal/api/access/authorizations/approval%2F1/decision",
    );
    expect(fetchMock.mock.calls[4][1]).toEqual(expect.objectContaining({
      body: JSON.stringify({
        decision: "approve",
        selection: {
          kind: "connect",
          rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }],
          credentialLabel: "example-agent",
        },
      }),
      headers: expect.objectContaining({ "X-Omnesis-CSRF": "csrf-test" }),
    }));
    expect(fetchMock.mock.calls[5]).toEqual([
      "/portal/api/access/authorizations/approval%2F1/complete",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-Omnesis-CSRF": "csrf-test" }),
      }),
    ]);
    expect(fetchMock.mock.calls[6]).toEqual([
      "/portal/api/access/revoke",
      expect.objectContaining({
        body: JSON.stringify({ kind: "credential", id: "credential/1" }),
        headers: expect.objectContaining({ "X-Omnesis-CSRF": "csrf-test" }),
      }),
    ]);
    });

  test("manage access levels and a connection's level on their own routes, with CSRF", async () => {
    const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
      if (input === "/portal/api/session") {
        return Response.json({ authenticated: true, scope: ["admin"], csrfToken: "csrf-level" });
      }
      return Response.json({ level: {}, removed: true, grant: {} });
    });
    vi.stubGlobal("fetch", fetchMock);
    await checkSession();
    const rules = [{ capability: "notes", sources: { mode: "all", sourceIds: [] } }];

    await createAccessLevel({ name: "Fictional research", rules });
    await updateAccessLevel("level/1", { expectedRevision: 4, name: "Renamed level" });
    await deleteAccessLevel("level/1");
    await moveConnectionLevel("connection/1", { levelId: "level/1", expectedLevelRevision: 2 }, 7);
    await moveConnectionLevel("connection/1", { newLevel: { name: "Fictional helper" } }, 8);

    const csrf = expect.objectContaining({ "X-Omnesis-CSRF": "csrf-level" });
    expect(fetchMock.mock.calls.slice(1)).toEqual([
      ["/admin/access/levels", expect.objectContaining({
        method: "POST", headers: csrf, body: JSON.stringify({ name: "Fictional research", rules }),
      })],
      ["/admin/access/levels/level%2F1", expect.objectContaining({
        method: "PATCH", headers: csrf, body: JSON.stringify({ expectedRevision: 4, name: "Renamed level" }),
      })],
      ["/admin/access/levels/level%2F1", expect.objectContaining({ method: "DELETE", headers: csrf })],
      ["/admin/access/connections/connection%2F1/level", expect.objectContaining({
        method: "PUT", headers: csrf, body: JSON.stringify({ levelId: "level/1", expectedLevelRevision: 2, expectedGrantRevision: 7 }),
      })],
      ["/admin/access/connections/connection%2F1/level", expect.objectContaining({
        method: "PUT", headers: csrf, body: JSON.stringify({ newLevel: { name: "Fictional helper" }, expectedGrantRevision: 8 }),
      })],
    ]);
});
});
