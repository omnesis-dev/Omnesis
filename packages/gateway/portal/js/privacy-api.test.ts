// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import {
  activateModel,
  apiFetch,
  approveSubscriptionApproval,
  approvePrivacyApproval,
  deleteDirectAuditSession,
  deletePrivacyConversation,
  deleteWatchV2Watch,
  denySubscriptionApproval,
  denyPrivacyApproval,
  getDirectAuditEvent,
  getPrivacySubscription,
  getSubscriptionApproval,
  listDirectAuditSessions,
  listDirectSessionEvents,
  listPrivacyApprovals,
  getPrivacyApproval,
  getPrivacyConversation,
  getWatchV2Watch,
  getPrivacyReviewerHealth,
  listPrivacyAuditEvents,
  listPrivacyExchangeFeed,
  listPrivacyExchanges,
  listPrivacySubscriptionFirings,
  listPrivacySubscriptions,
  listSubscriptionApprovals,
  listWatchV2Firings,
  listWatchV2Watches,
  patchAdminConfig,
  purgePrivacySubscription,
  putAdminConfig,
  revokePrivacySubscription,
  checkSession,
  createPrivacyPolicy,
  forkPrivacyPolicy,
  getNamedPrivacyPolicy,
  getNamedPrivacyPolicyHistory,
  getNamedPrivacyPolicyVersion,
  listPrivacyPolicies,
  logout,
  restoreNamedPrivacyPolicy,
  updateNamedPrivacyPolicy,
} from "./api.js";

function okJson(body: unknown = { ok: true }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("portal CSRF lifecycle", () => {
  test("attaches the session token only to unsafe same-origin requests", async () => {
    const csrfToken = "c".repeat(64);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okJson({ authenticated: true, scopes: ["admin"], csrfToken }))
      .mockResolvedValueOnce(okJson())
      .mockResolvedValueOnce(okJson())
      .mockResolvedValueOnce(okJson())
      .mockResolvedValueOnce(okJson())
      .mockResolvedValueOnce(okJson())
      .mockResolvedValueOnce(okJson());
    vi.stubGlobal("fetch", fetchMock);

    await checkSession();
    await apiFetch("/admin/privacy/policy", { method: "PUT", body: "{}" });
    await apiFetch("/admin/privacy/policy", { method: "GET" });
    await apiFetch("//attacker.example/api", { method: "POST", body: "{}" });
    await patchAdminConfig({ search: { params: { candidateLimit: 50 } } });
    await putAdminConfig({ version: 1 });
    await logout();

    const putHeaders = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    const getHeaders = fetchMock.mock.calls[2][1].headers as Record<string, string>;
    const crossOriginHeaders = fetchMock.mock.calls[3][1].headers as Record<string, string>;
    expect(putHeaders["X-Omnesis-CSRF"]).toBe(csrfToken);
    expect(getHeaders["X-Omnesis-CSRF"]).toBeUndefined();
    expect(crossOriginHeaders["X-Omnesis-CSRF"]).toBeUndefined();
    expect((fetchMock.mock.calls[4][1].headers as Record<string, string>)["X-Omnesis-CSRF"]).toBe(
      csrfToken,
    );
    expect((fetchMock.mock.calls[5][1].headers as Record<string, string>)["X-Omnesis-CSRF"]).toBe(
      csrfToken,
    );
  });
});

describe("privacy API wrappers", () => {
  test("uses family-scoped policy library routes while retaining Default compatibility", async () => {
    const fetchMock = vi.fn(async () => okJson());
    vi.stubGlobal("fetch", fetchMock);
    const familyId = "family/example";

    await listPrivacyPolicies();
    await createPrivacyPolicy({ name: "Research safe", templateId: "guarded" });
    await getNamedPrivacyPolicy(familyId);
    await updateNamedPrivacyPolicy(familyId, { policy: "# Safe\n", beforeVersion: 8 });
    await getNamedPrivacyPolicyHistory(familyId, { limit: 25, beforeVersion: 8 });
    await getNamedPrivacyPolicyVersion(familyId, 7);
    await restoreNamedPrivacyPolicy(familyId, 7, "rev-2");
    await forkPrivacyPolicy(familyId, { name: "Research safe copy" });

    expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method])).toEqual([
      ["/admin/privacy/policies", "GET"],
      ["/admin/privacy/policies", "POST"],
      ["/admin/privacy/policies/family%2Fexample", "GET"],
      ["/admin/privacy/policies/family%2Fexample", "PATCH"],
      ["/admin/privacy/policies/family%2Fexample/history?limit=25&beforeVersion=8", "GET"],
      ["/admin/privacy/policies/family%2Fexample/history/7", "GET"],
      ["/admin/privacy/policies/family%2Fexample/restore", "POST"],
      ["/admin/privacy/policies/family%2Fexample/fork", "POST"],
    ]);
    expect((fetchMock.mock.calls[6][1] as RequestInit).body).toBe(JSON.stringify({
      version: 7,
      expectedRevision: "rev-2",
    }));
    expect((fetchMock.mock.calls[3][1] as RequestInit).body).toBe(JSON.stringify({
      policy: "# Safe\n",
      beforeVersion: 8,
    }));
  });

  test("use the admin privacy routes and encode opaque ids", async () => {
    const fetchMock = vi.fn(async () => okJson());
    vi.stubGlobal("fetch", fetchMock);

    await getPrivacyReviewerHealth();
    await listPrivacyApprovals({ status: "pending", limit: 1 });
    await listPrivacyApprovals({ status: "all", cursor: "approval/cursor" });
    await getPrivacyApproval("approval/example");
    await approvePrivacyApproval("approval/example");
    await denyPrivacyApproval("approval/example");
    await listPrivacyExchangeFeed({ limit: 20, cursor: "exchange/cursor" });
    await getPrivacyConversation("conversation/example");
    await listPrivacyExchanges("conversation/example", { limit: 25, cursor: "exchange/cursor" });
    await listPrivacyAuditEvents("conversation/example", { limit: 30, cursor: "event/cursor" });
    await deletePrivacyConversation("conversation/example");
    await listSubscriptionApprovals({ status: "pending", limit: 15 });
    await getSubscriptionApproval("subscription-approval/example");
    await approveSubscriptionApproval("subscription-approval/example");
    await denySubscriptionApproval("subscription-approval/example");
    await listPrivacySubscriptions({ status: "active", limit: 10, cursor: "watch/cursor" });
    await getPrivacySubscription("subscription/example");
    await listPrivacySubscriptionFirings("subscription/example", {
      limit: 5,
      cursor: "firing/cursor",
    });
    await revokePrivacySubscription("subscription/example");
    await purgePrivacySubscription("subscription/example");

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      method: (init as RequestInit).method,
      body: (init as RequestInit).body,
      cache: (init as RequestInit).cache,
    }));
    expect(calls).toEqual([
      { url: "/admin/privacy/reviewer-health", method: "GET", body: undefined, cache: "no-store" },
      {
        url: "/admin/privacy/approvals?status=pending&limit=1",
        method: "GET",
        body: undefined,
        cache: "no-store",
      },
      {
        url: "/admin/privacy/approvals?status=all&limit=100&cursor=approval%2Fcursor",
        method: "GET",
        body: undefined,
        cache: "no-store",
      },
      { url: "/admin/privacy/approvals/approval%2Fexample", method: "GET", body: undefined, cache: "no-store" },
      {
        url: "/admin/privacy/approvals/approval%2Fexample/approve",
        method: "POST",
        body: undefined,
        cache: "no-store",
      },
      { url: "/admin/privacy/approvals/approval%2Fexample/deny", method: "POST", body: undefined, cache: "no-store" },
      {
        url: "/admin/privacy/exchanges?limit=20&cursor=exchange%2Fcursor",
        method: "GET",
        body: undefined,
        cache: "no-store",
      },
      { url: "/admin/privacy/conversations/conversation%2Fexample", method: "GET", body: undefined, cache: "no-store" },
      {
        url: "/admin/privacy/conversations/conversation%2Fexample/exchanges?limit=25&cursor=exchange%2Fcursor",
        method: "GET",
        body: undefined,
        cache: "no-store",
      },
      {
        url: "/admin/privacy/conversations/conversation%2Fexample/events?limit=30&cursor=event%2Fcursor",
        method: "GET",
        body: undefined,
        cache: "no-store",
      },
      { url: "/admin/privacy/conversations/conversation%2Fexample", method: "DELETE", body: undefined, cache: "no-store" },
      {
        url: "/admin/privacy/subscription-approvals?status=pending&limit=15",
        method: "GET",
        body: undefined,
        cache: "no-store",
      },
      {
        url: "/admin/privacy/subscription-approvals/subscription-approval%2Fexample",
        method: "GET",
        body: undefined,
        cache: "no-store",
      },
      {
        url: "/admin/privacy/subscription-approvals/subscription-approval%2Fexample/resolve",
        method: "POST",
        body: JSON.stringify({ decision: "approve" }),
        cache: "no-store",
      },
      {
        url: "/admin/privacy/subscription-approvals/subscription-approval%2Fexample/resolve",
        method: "POST",
        body: JSON.stringify({ decision: "deny" }),
        cache: "no-store",
      },
      {
        url: "/admin/privacy/subscriptions?status=active&limit=10&cursor=watch%2Fcursor",
        method: "GET",
        body: undefined,
        cache: "no-store",
      },
      {
        url: "/admin/privacy/subscriptions/subscription%2Fexample",
        method: "GET",
        body: undefined,
        cache: "no-store",
      },
      {
        url: "/admin/privacy/subscriptions/subscription%2Fexample/firings?limit=5&cursor=firing%2Fcursor",
        method: "GET",
        body: undefined,
        cache: "no-store",
      },
      {
        url: "/admin/privacy/subscriptions/subscription%2Fexample/revoke",
        method: "POST",
        body: undefined,
        cache: "no-store",
      },
      {
        url: "/admin/privacy/subscriptions/subscription%2Fexample",
        method: "DELETE",
        body: undefined,
        cache: "no-store",
      },
    ]);
  });

  test("reads and removes runtime watches through the admin watch-v2 routes", async () => {
    const fetchMock = vi.fn(async () => okJson());
    vi.stubGlobal("fetch", fetchMock);

    await listWatchV2Watches();
    await getWatchV2Watch("watch/example");
    await listWatchV2Firings("watch/example", { limit: 25 });
    await deleteWatchV2Watch("watch/example");

    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url,
      method: (init as RequestInit).method,
      cache: (init as RequestInit).cache,
    }));
    // `no-store` on every one: a watch's status and its firing count change
    // under the operator while the page is open, and a cached listing would
    // report a watch as still running after they removed it.
    expect(calls).toEqual([
      { url: "/admin/watch/watches", method: "GET", cache: "no-store" },
      { url: "/admin/watch/watches/watch%2Fexample", method: "GET", cache: "no-store" },
      {
        url: "/admin/watch/watches/watch%2Fexample/firings?limit=25",
        method: "GET",
        cache: "no-store",
      },
      { url: "/admin/watch/watches/watch%2Fexample", method: "DELETE", cache: "no-store" },
    ]);
  });

  test("reads and removes Direct transcript sessions", async () => {
    const fetchMock = vi.fn(async () => okJson());
    vi.stubGlobal("fetch", fetchMock);

    await listDirectAuditSessions({ limit: 20 });
    await listDirectSessionEvents("session/example", { limit: 40 });
    await getDirectAuditEvent("event/example");
    await deleteDirectAuditSession("session/example");

    expect(fetchMock.mock.calls.map(([url, init]) => [url, (init as RequestInit).method])).toEqual([
      ["/admin/privacy/direct/sessions?limit=20", "GET"],
      ["/admin/privacy/direct/sessions/session%2Fexample/events?limit=40", "GET"],
      ["/admin/privacy/direct/events/event%2Fexample", "GET"],
      ["/admin/privacy/direct/sessions/session%2Fexample", "DELETE"],
    ]);
  });

  test("targets an independent capability when activating a shared catalog role", async () => {
    const fetchMock = vi.fn(async () => okJson());
    vi.stubGlobal("fetch", fetchMock);

    await activateModel("review-model", "agent", "privacy-reviewer");

    expect(fetchMock).toHaveBeenCalledWith(
      "/admin/models/activate",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "review-model",
          role: "agent",
          capability: "privacy-reviewer",
        }),
      }),
    );
  });
});
