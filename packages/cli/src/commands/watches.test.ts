// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, describe, expect, test, vi, type Mock } from "vitest";

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return { ...actual, gatewayJson: vi.fn() };
});

import { gatewayJson } from "../utils.js";
import { watchesCommand } from "./watches.js";

function command(name: string) {
  const commands = watchesCommand.subCommands as Record<
    string,
    { run: (context: { args: Record<string, unknown> }) => Promise<void> }
  >;
  return commands[name]!;
}

const subscription = {
  id: "sub_fictional_1",
  status: "active",
  condition: { kind: "natural-language", description: "A new Northstar planning memo" },
  reaction: { kind: "agent-workflow", instruction: "Review it and notify the user." },
  workflowHandle: "wf_fictional_1",
  revision: 3,
  expiresAt: 1_900_000_000_000,
};

describe("watches CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  test("exposes only the management verbs", () => {
    expect(Object.keys(watchesCommand.subCommands ?? {})).toEqual([
      "create",
      "list",
      "get",
      "update",
      "revoke",
      "purge",
    ]);
  });

  test("create sends natural-language condition and reaction, never TriggerSpec", async () => {
    (gatewayJson as Mock).mockResolvedValue({ subscription });
    await command("create").run({
      args: {
        condition: "A new Northstar planning memo",
        reaction: "Review it and notify the user.",
        "idempotency-key": "fictional-request-1",
        "workflow-id": "workflow-fictional-1",
        "expires-at": "2030-03-17T17:46:40.000Z",
      },
    });
    expect(gatewayJson).toHaveBeenCalledWith("/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        condition: {
          kind: "natural-language",
          description: "A new Northstar planning memo",
        },
        reaction: {
          kind: "agent-workflow",
          instruction: "Review it and notify the user.",
        },
        idempotencyKey: "fictional-request-1",
        workflowId: "workflow-fictional-1",
        expiresAt: 1_900_000_000_000,
      }),
    });
    expect((gatewayJson as Mock).mock.calls[0]![1].body).not.toContain("TriggerSpec");
  });

  test("update rejects definition and status changes in one request", async () => {
    (gatewayJson as Mock).mockResolvedValue({ subscription });
    await expect(
      command("update").run({
        args: {
          id: "sub_fictional_1",
          "expected-revision": "3",
          "expires-at": "none",
          status: "paused",
        },
      }),
    ).rejects.toThrow(/definition and status in separate requests/);
    expect(gatewayJson).not.toHaveBeenCalled();
  });

  test.each([
    ["clearing expiry", { "expires-at": "none" }, { expectedRevision: 3, expiresAt: null }],
    ["pausing", { status: "paused" }, { expectedRevision: 3, status: "paused" }],
  ])("update supports %s as a separate request", async (_label, args, expectedBody) => {
    (gatewayJson as Mock).mockResolvedValue({ subscription });
    await command("update").run({
      args: {
        id: "sub_fictional_1",
        "expected-revision": "3",
        ...args,
      },
    });
    expect(gatewayJson).toHaveBeenCalledWith("/subscriptions/sub_fictional_1", {
      method: "PATCH",
      body: JSON.stringify(expectedBody),
    });
  });

  test("update requires a positive expected revision before making a request", async () => {
    await expect(
      command("update").run({
        args: {
          id: "sub_fictional_1",
          status: "paused",
        },
      }),
    ).rejects.toThrow(/--expected-revision is required/);
    await expect(
      command("update").run({
        args: {
          id: "sub_fictional_1",
          status: "paused",
          "expected-revision": "0",
        },
      }),
    ).rejects.toThrow(/positive integer/);
    expect(gatewayJson).not.toHaveBeenCalled();
  });

  test("does not silently retry a stale-revision conflict", async () => {
    (gatewayJson as Mock).mockRejectedValue(new Error("stale subscription revision"));
    await expect(
      command("update").run({
        args: {
          id: "sub_fictional_1",
          status: "paused",
          "expected-revision": "2",
        },
      }),
    ).rejects.toThrow(/stale subscription revision/);
    expect(gatewayJson).toHaveBeenCalledOnce();
  });

  test("an empty list explains its own scope rather than reading as 'you have none'", async () => {
    // The route answers as the calling agent device and returns only what that
    // device created, so an operator's own token sees an empty list even while
    // watches are running. The empty state therefore has to name that scope and
    // point at the full runtime view; a bare "No watches." would state the
    // opposite of the truth.
    const lines: string[] = [];
    (console.log as Mock).mockImplementation((line: string) => lines.push(String(line)));
    (gatewayJson as Mock).mockResolvedValue({ subscriptions: [] });
    await command("list").run({ args: {} });

    const printed = lines.join("\n");
    expect(printed).toMatch(/this agent device/i);
    expect(printed, "the reader was not pointed at the full runtime view").toContain(
      "omnesis watch list",
    );
  });

  test("an empty list stays prose-free for a machine reader", async () => {
    // Anything scripting this parses stdout. A sentence printed alongside the
    // JSON would break every such reader, and the explanation above is exactly
    // the kind of thing that leaks.
    const lines: string[] = [];
    (console.log as Mock).mockImplementation((line: string) => lines.push(String(line)));
    (gatewayJson as Mock).mockResolvedValue({ subscriptions: [] });
    await command("list").run({ args: { json: true } });

    expect(lines).toEqual([JSON.stringify({ subscriptions: [] })]);
  });

  test("list and get offer machine-readable output", async () => {
    (gatewayJson as Mock)
      .mockResolvedValueOnce({ subscriptions: [subscription] })
      .mockResolvedValueOnce({ subscription });
    await command("list").run({ args: { json: true } });
    await command("get").run({ args: { id: "sub_fictional_1", json: true } });
    expect(gatewayJson).toHaveBeenNthCalledWith(1, "/subscriptions");
    expect(gatewayJson).toHaveBeenNthCalledWith(2, "/subscriptions/sub_fictional_1");
  });

  test("revoke uses the dedicated prompt API endpoint", async () => {
    (gatewayJson as Mock).mockResolvedValue({ subscription });
    await command("revoke").run({ args: { id: "sub_fictional_1" } });
    expect(gatewayJson).toHaveBeenCalledWith("/subscriptions/sub_fictional_1", {
      method: "DELETE",
    });
  });

  const purged = {
    subscriptionId: "sub_fictional_1",
    status: "revoked",
    revisionsDeleted: 2,
    firingsDeleted: 1,
    evaluationsDeleted: 3,
    answerTokensDeleted: 1,
    managedTriggerDeleted: true,
    workflowsDeleted: 1,
  };

  test("purge drives the admin hard-delete endpoint", async () => {
    (gatewayJson as Mock).mockResolvedValue({ purged });
    await command("purge").run({ args: { id: "sub_fictional_1" } });
    expect(gatewayJson).toHaveBeenCalledWith("/admin/privacy/subscriptions/sub_fictional_1", {
      method: "DELETE",
    });
  });

  test("purge --all-revoked follows the cursor before deleting anything", async () => {
    (gatewayJson as Mock)
      .mockResolvedValueOnce({
        subscriptions: [{ ...subscription, id: "sub_fictional_1" }],
        nextCursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        subscriptions: [{ ...subscription, id: "sub_fictional_2" }],
        nextCursor: null,
      })
      .mockResolvedValue({ purged });
    await command("purge").run({ args: { "all-revoked": true } });
    expect(gatewayJson).toHaveBeenNthCalledWith(
      1,
      "/admin/privacy/subscriptions?status=revoked&limit=100",
    );
    expect(gatewayJson).toHaveBeenNthCalledWith(
      2,
      "/admin/privacy/subscriptions?status=revoked&limit=100&cursor=cursor-1",
    );
    expect(gatewayJson).toHaveBeenNthCalledWith(3, "/admin/privacy/subscriptions/sub_fictional_1", {
      method: "DELETE",
    });
    expect(gatewayJson).toHaveBeenNthCalledWith(4, "/admin/privacy/subscriptions/sub_fictional_2", {
      method: "DELETE",
    });
  });

  test("purge --all-revoked continues past a failing watch and reports it", async () => {
    (gatewayJson as Mock)
      .mockResolvedValueOnce({
        subscriptions: [
          { ...subscription, id: "sub_fictional_1" },
          { ...subscription, id: "sub_fictional_2" },
          { ...subscription, id: "sub_fictional_3" },
        ],
        nextCursor: null,
      })
      .mockResolvedValueOnce({ purged })
      .mockRejectedValueOnce(new Error("Gateway 409"))
      .mockResolvedValueOnce({ purged });
    await expect(command("purge").run({ args: { "all-revoked": true } })).rejects.toThrow(
      /1 watch could not be deleted: sub_fictional_2/,
    );
    // All three deletes were attempted despite the middle failure.
    expect(gatewayJson).toHaveBeenCalledTimes(4);
    expect(gatewayJson).toHaveBeenNthCalledWith(4, "/admin/privacy/subscriptions/sub_fictional_3", {
      method: "DELETE",
    });
  });

  test("purge refuses an id combined with --all-revoked", async () => {
    await expect(
      command("purge").run({ args: { id: "sub_fictional_1", "all-revoked": true } }),
    ).rejects.toThrow(/not both/);
    expect(gatewayJson).not.toHaveBeenCalled();
  });

  test("purge requires an id when --all-revoked is absent", async () => {
    await expect(command("purge").run({ args: {} })).rejects.toThrow(/watch id is required/);
    expect(gatewayJson).not.toHaveBeenCalled();
  });
});

describe("the watches command name", () => {
  test("is spelled `watches` in its own help", () => {
    expect(
      watchesCommand.meta && "name" in watchesCommand.meta ? watchesCommand.meta.name : "",
    ).toBe("watches");
  });
});
