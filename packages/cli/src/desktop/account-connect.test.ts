// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { connectDesktopAccount, desktopEnrollmentUI } from "./account-connect.js";
import { DesktopInteractionBroker } from "./protocol.js";
import { desktopProfile } from "./environment.js";
import type { requestDesktopGateway } from "./gateway-access.js";

function fixture() {
  const profile = desktopProfile("/tmp/fictional-account-flow");
  const controller = new AbortController();
  const prompts: Record<string, unknown>[] = [];
  const broker = new DesktopInteractionBroker(async ({ interaction }) => {
    prompts.push(interaction);
    if (interaction.kind === "openBrowser" || interaction.kind === "connectCode")
      queueMicrotask(() => broker.respond(interaction.id, "continue"));
  });
  const context = { signal: controller.signal, interactions: broker };
  const request = vi
    .fn<typeof requestDesktopGateway>()
    .mockResolvedValue({ account: { linked: true } });
  return { profile, controller, context, prompts, request };
}

test("account connection presents signed-in browser action and waits for actual linked status", async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce({
    account: { linked: false },
    connect: {
      state: "waiting",
      authorizeUrl: "https://relay.example.test/sign-in",
      code: "ABCD-EFGH",
    },
  });
  const result = await connectDesktopAccount(
    f.profile,
    { intent: "existing", termsAccepted: true },
    f.context,
    { request: f.request, sleep: async () => {} },
  );
  expect(result.account?.linked).toBe(true);
  expect(f.prompts[0]).toMatchObject({
    kind: "openBrowser",
    url: "https://relay.example.test/sign-in",
    code: "ABCD-EFGH",
  });
  expect(f.request.mock.calls.map(([, path]) => path)).toEqual([
    "/admin/cloud-relay/connect",
    "/admin/cloud-relay",
  ]);
});

test("cancelled account connection cancels gateway operation with a fresh bounded signal", async () => {
  const f = fixture();
  f.request.mockResolvedValue({ account: { linked: false }, connect: { state: "registering" } });
  await expect(
    connectDesktopAccount(
      f.profile,
      { intent: "create", termsAccepted: true, invite: "fictional-invite" },
      f.context,
      {
        request: f.request,
        sleep: async () => {
          f.controller.abort();
        },
      },
    ),
  ).rejects.toThrow();
  const cancel = f.request.mock.calls.at(-1)!;
  expect(cancel[1]).toBe("/admin/cloud-relay/connect/cancel");
  expect(cancel[2]?.signal?.aborted).toBe(false);
});

test("missing consent or invalid browser destination never succeeds", async () => {
  const f = fixture();
  await expect(
    connectDesktopAccount(f.profile, { intent: "create", termsAccepted: false }, f.context, {
      request: f.request,
    }),
  ).rejects.toThrow();
  expect(f.request).not.toHaveBeenCalled();
  f.request.mockResolvedValueOnce({
    account: { linked: false },
    connect: { state: "waiting", authorizeUrl: "http://untrusted.example.test" },
  });
  await expect(
    connectDesktopAccount(f.profile, { termsAccepted: true }, f.context, { request: f.request }),
  ).rejects.toThrow();
  expect(f.prompts).toEqual([]);
  expect(f.request.mock.calls.at(-1)![1]).toBe("/admin/cloud-relay/connect/cancel");
});

test("native library choices and code comparisons reject unrecognized responses", async () => {
  const f = fixture();
  const ui = desktopEnrollmentUI(f.context);
  const choosing = ui.chooseGateway(
    [
      {
        gatewayId: "00000000-0000-4000-8000-000000000001",
        publicOrigin: "https://library.example.test",
        online: true,
      },
    ],
    f.controller.signal,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const prompt = f.prompts[0]!;
  expect(() => f.context.interactions.respond(String(prompt.id), "unknown-library")).toThrow(
    "invalid",
  );
  f.context.interactions.respond(String(prompt.id), "00000000-0000-4000-8000-000000000001");
  expect(await choosing).toBe("00000000-0000-4000-8000-000000000001");
});

test("invite errors have fixed actionable messages without exposing provider error text", async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce({
    account: { linked: false },
    connect: { state: "failed", error: "invite-expired" },
  });
  await expect(
    connectDesktopAccount(f.profile, { termsAccepted: true }, f.context, { request: f.request }),
  ).rejects.toThrow("invitation has expired");
  f.request.mockResolvedValueOnce({
    account: { linked: false },
    connect: { state: "failed", error: "fictional-private-provider-error" },
  });
  await expect(
    connectDesktopAccount(f.profile, { termsAccepted: true }, f.context, { request: f.request }),
  ).rejects.not.toThrow("fictional-private-provider-error");
});

test("malformed optional route evidence cannot break a linked account status", async () => {
  const f = fixture();
  f.request.mockResolvedValue({
    account: { linked: true },
    tunnel: 42,
    certificate: null,
    publicMcp: { ready: "invalid" },
  });
  const result = await connectDesktopAccount(
    f.profile,
    { intent: "existing", termsAccepted: true },
    f.context,
    { request: f.request, sleep: async () => {} },
  );
  expect(result.account?.linked).toBe(true);
});
