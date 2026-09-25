// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  accessOverview,
  InMemoryOAuthClientProvider,
  portalJson,
  portalRequest,
  stageConnectionApproval,
  type AccessOverview,
  type AuthorizedMcpClient,
  type StagedConnectionApproval,
  type TestGrantRule,
} from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

const notesRule: TestGrantRule = { capability: "notes", sources: { mode: "all", sourceIds: [] } };
const answerRule: TestGrantRule = {
  capability: "answer",
  sources: { mode: "all", sourceIds: [] },
  release: { mode: "unreviewed" },
};
const NOTES_TOOLS = ["add_note"];
const ANSWER_TOOLS = ["ask_omnesis", "get_answer_status"];
const ANSWER_AND_NOTES_TOOLS = ["ask_omnesis", "get_answer_status", "add_note"];

let nextCallbackPort = 48_300;
function callback(): string {
  nextCallbackPort += 1;
  return `http://127.0.0.1:${nextCallbackPort}/callback`;
}

type AccessLevel = NonNullable<AccessOverview["levels"]>[number];

describe("connections and access levels — spawned gateway", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", agentBackend: "replay" });
    await harness.start();
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("two approvals from the same app are two connections, each with the access level chosen for it", async () => {
    const appName = "fictional coding agent";
    const first = await stageConnectionApproval(harness, {
      clientName: appName,
      redirectUrl: callback(),
    });
    expect(first.lookup.reconnect).toBeNull();
    expect(first.lookup.connection).toEqual({
      defaultName: appName,
      defaultLevelName: appName,
      match: null,
      recommended: "new-level",
    });
    const laptop = await (
      await first.approve({
        kind: "new-connection",
        name: `${appName} · laptop`,
        level: { kind: "new", name: "coding agent notes only", rules: [notesRule] },
      })
    ).finish();

    try {
      const second = await stageConnectionApproval(harness, {
        clientName: appName,
        redirectUrl: callback(),
      });
      let desktop: AuthorizedMcpClient | undefined;
      try {
        const laptopLevelId = grantOf(
          await accessOverview(harness.gatewayUrl, laptop.portal),
          laptop.grantId,
        )?.levelId;
        expect(laptopLevelId).toEqual(expect.any(String));
        expect(second.lookup.reconnect).toBeNull();
        expect(second.lookup.connection).toMatchObject({
          defaultName: appName,
          recommended: "existing-level",
          match: {
            connectionId: laptop.principalId,
            connectionName: `${appName} · laptop`,
            matchedBy: "name",
            levelId: laptopLevelId,
          },
        });
        desktop = await (
          await second.approve({
            kind: "new-connection",
            name: `${appName} · desktop`,
            level: {
              kind: "new",
              name: "coding agent answers and notes",
              rules: [answerRule, notesRule],
            },
          })
        ).finish();

        expect(desktop.principalId).not.toBe(laptop.principalId);
        expect(desktop.grantId).not.toBe(laptop.grantId);
        expect(await toolNames(laptop)).toEqual(NOTES_TOOLS);
        expect(await toolNames(desktop)).toEqual(ANSWER_AND_NOTES_TOOLS);
        const overview = await accessOverview(harness.gatewayUrl, laptop.portal);
        expect(liveConnectionNames(overview)).toEqual(
          expect.arrayContaining([`${appName} · laptop`, `${appName} · desktop`]),
        );
        expect(grantOf(overview, desktop.grantId)?.levelId).not.toBe(laptopLevelId);
      } finally {
        await second.close();
        if (desktop) await closeAll(desktop);
      }
    } finally {
      await closeAll(laptop);
    }
  }, 90_000);

  test("an older app's connect approval never joins an existing connection", async () => {
    const appName = "fictional legacy notebook";
    const approveLegacy = async (): Promise<AuthorizedMcpClient> => {
      const staged = await stageConnectionApproval(harness, {
        clientName: appName,
        redirectUrl: callback(),
      });
      return (
        await staged.approve({ kind: "connect", rules: [notesRule], credentialLabel: appName })
      ).finish();
    };
    const first = await approveLegacy();
    try {
      const second = await approveLegacy();
      try {
        expect(second.principalId).not.toBe(first.principalId);
        const overview = await accessOverview(harness.gatewayUrl, first.portal);
        const names = liveConnectionNames(overview);
        expect(names).toContain(appName);
        expect(names).toContain(`${appName} 2`);
        const levelNames = (overview.levels ?? []).map((level) => level.name);
        expect(levelNames).toContain(appName);
        expect(levelNames).toContain(`${appName} 2`);
        const firstLevelId = grantOf(overview, first.grantId)?.levelId;
        expect(firstLevelId).toEqual(expect.any(String));
        expect(grantOf(overview, second.grantId)?.levelId).toEqual(expect.any(String));
        expect(grantOf(overview, second.grantId)?.levelId).not.toBe(firstLevelId);
        expect(await toolNames(first)).toEqual(NOTES_TOOLS);
        expect(await toolNames(second)).toEqual(NOTES_TOOLS);
      } finally {
        await closeAll(second);
      }
    } finally {
      await closeAll(first);
    }
  }, 90_000);

  test("an older app signing in again with the same registered client gets a second connection", async () => {
    const appName = "fictional returning notebook";
    const redirectUrl = callback();
    const firstStaged = await stageConnectionApproval(harness, {
      clientName: appName,
      redirectUrl,
    });
    const first = await (
      await firstStaged.approve({ kind: "connect", rules: [notesRule], credentialLabel: appName })
    ).finish();

    try {
      const clientInformation = first.provider.savedClientInformation;
      expect(clientInformation?.client_id).toEqual(expect.any(String));
      const sameClient = new InMemoryOAuthClientProvider({ clientName: appName, redirectUrl });
      sameClient.saveClientInformation(clientInformation!);
      const again = await stageConnectionApproval(harness, sameClient);
      let second: AuthorizedMcpClient | undefined;
      try {
        expect(again.lookup.connection).toMatchObject({
          match: { connectionId: first.principalId, matchedBy: "client" },
        });
        second = await (
          await again.approve({ kind: "connect", rules: [notesRule], credentialLabel: appName })
        ).finish();

        expect(second.provider.savedClientInformation?.client_id).toBe(
          clientInformation!.client_id,
        );
        expect(second.principalId).not.toBe(first.principalId);
        expect(second.grantId).not.toBe(first.grantId);
        expect(await toolNames(first)).toEqual(NOTES_TOOLS);
        expect(await toolNames(second)).toEqual(NOTES_TOOLS);
        const overview = await accessOverview(harness.gatewayUrl, first.portal);
        expect(activeSignIns(overview, first.principalId)).toEqual([first.credentialId]);
        expect(activeSignIns(overview, second.principalId)).toEqual([second.credentialId]);
      } finally {
        await again.close();
        if (second) await closeAll(second);
      }
    } finally {
      await closeAll(first);
    }
  }, 90_000);

  test("a shared access level is suggested to the same app, and editing it changes every connection that uses it", async () => {
    const appName = "fictional research agent";
    const levelName = "research agent shared level";
    const first = await stageConnectionApproval(harness, {
      clientName: appName,
      redirectUrl: callback(),
    });
    const alpha = await (
      await first.approve({
        kind: "new-connection",
        name: `${appName} · alpha`,
        level: { kind: "new", name: levelName, rules: [notesRule] },
      })
    ).finish();

    let beta: AuthorizedMcpClient | undefined;
    let third: StagedConnectionApproval | undefined;
    try {
      let overview = await accessOverview(harness.gatewayUrl, alpha.portal);
      const level = levelNamed(overview, levelName);
      expect(level).toMatchObject({ connectionCount: 1 });
      expect(grantOf(overview, alpha.grantId)?.levelId).toBe(level.id);

      const second = await stageConnectionApproval(harness, {
        clientName: appName,
        redirectUrl: callback(),
      });
      try {
        expect(second.lookup.connection).toMatchObject({
          recommended: "existing-level",
          match: { connectionId: alpha.principalId, levelId: level.id },
        });
        beta = await (
          await second.approve({
            kind: "new-connection",
            name: `${appName} · beta`,
            level: { kind: "existing", levelId: level.id, expectedLevelRevision: level.revision },
          })
        ).finish();
      } finally {
        await second.close();
      }

      third = await stageConnectionApproval(harness, {
        clientName: appName,
        redirectUrl: callback(),
      });
      expect(await toolNames(beta)).toEqual(NOTES_TOOLS);
      const edited = await portalJson<{ level: { revision: number } }>(
        harness.gatewayUrl,
        alpha.portal,
        `/admin/access/levels/${encodeURIComponent(level.id)}`,
        { expectedRevision: level.revision, rules: [answerRule, notesRule] },
        "PATCH",
      );
      expect(edited.level.revision).toBeGreaterThan(level.revision);
      expect(await toolNames(alpha)).toEqual(ANSWER_AND_NOTES_TOOLS);
      expect(await toolNames(beta)).toEqual(ANSWER_AND_NOTES_TOOLS);
      expect(alpha.provider.authorizationRedirects).toBe(1);
      expect(beta.provider.authorizationRedirects).toBe(1);

      const stale = await portalRequest(
        harness.gatewayUrl,
        alpha.portal,
        "POST",
        decisionPath(third),
        {
          decision: "approve",
          selection: {
            kind: "new-connection",
            name: `${appName} · gamma`,
            level: { kind: "existing", levelId: level.id, expectedLevelRevision: level.revision },
          },
        },
      );
      expect(stale).toMatchObject({ status: 409, body: { error: "stale-revision" } });

      overview = await accessOverview(harness.gatewayUrl, alpha.portal);
      const sharedGrant = grantOf(overview, alpha.grantId)!;
      const managed = await portalRequest(
        harness.gatewayUrl,
        alpha.portal,
        "PATCH",
        `/admin/access/grants/${encodeURIComponent(alpha.grantId)}`,
        { expectedRevision: sharedGrant.revision, rules: [notesRule] },
      );
      expect(managed).toMatchObject({ status: 409, body: { error: "level-managed" } });

      const inUse = await portalRequest(
        harness.gatewayUrl,
        alpha.portal,
        "DELETE",
        `/admin/access/levels/${encodeURIComponent(level.id)}`,
      );
      expect(inUse).toMatchObject({ status: 409, body: { error: "level-in-use" } });

      const moved = await portalJson<{ grant: { revision: number }; level: { id: string } }>(
        harness.gatewayUrl,
        alpha.portal,
        `/admin/access/connections/${encodeURIComponent(alpha.principalId)}/level`,
        {
          newLevel: { name: `${appName} · alpha only` },
          expectedGrantRevision: sharedGrant.revision,
        },
        "PUT",
      );
      expect(moved.level.id).not.toBe(level.id);
      await portalJson(
        harness.gatewayUrl,
        alpha.portal,
        `/admin/access/grants/${encodeURIComponent(alpha.grantId)}`,
        { expectedRevision: moved.grant.revision, rules: [notesRule] },
        "PATCH",
      );
      expect(await toolNames(alpha)).toEqual(NOTES_TOOLS);
      expect(await toolNames(beta)).toEqual(ANSWER_AND_NOTES_TOOLS);
      overview = await accessOverview(harness.gatewayUrl, alpha.portal);
      expect(overview.levels?.find((candidate) => candidate.id === level.id)).toMatchObject({
        connectionCount: 1,
      });
    } finally {
      if (third) {
        await portalRequest(harness.gatewayUrl, alpha.portal, "POST", decisionPath(third), {
          decision: "deny",
        });
        await third.close();
      }
      await closeAll(alpha, ...(beta ? [beta] : []));
    }
  }, 120_000);

  test("moving a connection onto an existing access level refreshes its tools, and an unused level can be renamed and deleted", async () => {
    const appName = "fictional moving agent";
    const startLevelName = "moving agent starting level";
    const staged = await stageConnectionApproval(harness, {
      clientName: appName,
      redirectUrl: callback(),
    });
    const connection = await (
      await staged.approve({
        kind: "new-connection",
        name: appName,
        level: { kind: "new", name: startLevelName, rules: [notesRule] },
      })
    ).finish();

    try {
      expect(await toolNames(connection)).toEqual(NOTES_TOOLS);
      const created = await portalRequest(
        harness.gatewayUrl,
        connection.portal,
        "POST",
        "/admin/access/levels",
        { name: "moving agent target level", rules: [answerRule] },
      );
      expect(created).toMatchObject({ status: 201, body: { level: { connectionCount: 0 } } });
      const createdTarget = (created.body as { level: AccessLevel }).level;
      const target = (
        await portalJson<{ level: AccessLevel }>(
          harness.gatewayUrl,
          connection.portal,
          `/admin/access/levels/${encodeURIComponent(createdTarget.id)}`,
          { expectedRevision: createdTarget.revision, rules: [answerRule, notesRule] },
          "PATCH",
        )
      ).level;
      expect(target.revision).toBeGreaterThan(createdTarget.revision);
      const startLevel = levelNamed(
        await accessOverview(harness.gatewayUrl, connection.portal),
        startLevelName,
      );
      const connectionLevelPath = `/admin/access/connections/${encodeURIComponent(connection.principalId)}/level`;

      const staleTarget = await portalRequest(
        harness.gatewayUrl,
        connection.portal,
        "PUT",
        connectionLevelPath,
        {
          levelId: target.id,
          expectedLevelRevision: createdTarget.revision,
          expectedGrantRevision: connection.grantRevision,
        },
      );
      expect(staleTarget).toMatchObject({ status: 409, body: { error: "stale-revision" } });
      expect(await toolNames(connection)).toEqual(NOTES_TOOLS);

      const moved = await portalJson<{ grant: { revision: number }; level: { id: string } }>(
        harness.gatewayUrl,
        connection.portal,
        connectionLevelPath,
        {
          levelId: target.id,
          expectedLevelRevision: target.revision,
          expectedGrantRevision: connection.grantRevision,
        },
        "PUT",
      );
      expect(moved.level.id).toBe(target.id);
      expect(moved.grant.revision).toBeGreaterThan(connection.grantRevision);
      expect(await toolNames(connection)).toEqual(ANSWER_AND_NOTES_TOOLS);
      expect(connection.provider.authorizationRedirects).toBe(1);

      let overview = await accessOverview(harness.gatewayUrl, connection.portal);
      expect(grantOf(overview, connection.grantId)?.levelId).toBe(target.id);
      expect(levelNamed(overview, startLevelName)).toMatchObject({ connectionCount: 0 });

      const nothingToChange = await portalRequest(
        harness.gatewayUrl,
        connection.portal,
        "PATCH",
        `/admin/access/levels/${encodeURIComponent(startLevel.id)}`,
        { expectedRevision: startLevel.revision },
      );
      expect(nothingToChange.status).toBe(400);

      const renamedName = "moving agent retired level";
      const renamed = await portalJson<{ level: AccessLevel }>(
        harness.gatewayUrl,
        connection.portal,
        `/admin/access/levels/${encodeURIComponent(startLevel.id)}`,
        { expectedRevision: startLevel.revision, name: renamedName },
        "PATCH",
      );
      expect(renamed.level).toMatchObject({ id: startLevel.id, name: renamedName });
      overview = await accessOverview(harness.gatewayUrl, connection.portal);
      expect(levelNamed(overview, renamedName).id).toBe(startLevel.id);
      expect(overview.levels?.some((level) => level.name === startLevelName)).toBe(false);

      const deleted = await portalRequest(
        harness.gatewayUrl,
        connection.portal,
        "DELETE",
        `/admin/access/levels/${encodeURIComponent(startLevel.id)}`,
      );
      expect(deleted).toEqual({ status: 200, body: { removed: true } });
      overview = await accessOverview(harness.gatewayUrl, connection.portal);
      expect(overview.levels?.some((level) => level.id === startLevel.id)).toBe(false);

      const ontoGone = await portalRequest(
        harness.gatewayUrl,
        connection.portal,
        "PUT",
        connectionLevelPath,
        { levelId: startLevel.id, expectedGrantRevision: moved.grant.revision },
      );
      expect(ontoGone).toMatchObject({ status: 409, body: { error: "inactive-grant" } });
      expect(await toolNames(connection)).toEqual(ANSWER_AND_NOTES_TOOLS);
    } finally {
      await closeAll(connection);
    }
  }, 90_000);

  test("replacing a connection revokes the old sign-in only once the new one completes", async () => {
    const appName = "fictional replaceable agent";
    const first = await stageConnectionApproval(harness, {
      clientName: appName,
      redirectUrl: callback(),
    });
    const original = await (
      await first.approve({
        kind: "new-connection",
        name: appName,
        level: { kind: "new", name: "replaceable agent level", rules: [notesRule] },
      })
    ).finish();

    try {
      const second = await stageConnectionApproval(harness, {
        clientName: appName,
        redirectUrl: callback(),
      });
      let replacement: AuthorizedMcpClient | undefined;
      try {
        const approved = await second.approve({
          kind: "replace-connection",
          connectionId: original.principalId,
          expectedGrantRevision: original.grantRevision,
        });
        expect(await toolNames(original)).toEqual(NOTES_TOOLS);

        replacement = await approved.finish();
        expect(replacement.principalId).toBe(original.principalId);
        expect(replacement.grantId).toBe(original.grantId);
        expect(replacement.credentialId).not.toBe(original.credentialId);
        expect(await toolNames(replacement)).toEqual(NOTES_TOOLS);
        await expect(
          original.client.listTools(undefined, { cacheMode: "refresh" }),
        ).rejects.toBeDefined();
        const overview = await accessOverview(harness.gatewayUrl, original.portal);
        const connection = overview.principals.find((p) => p.id === original.principalId)!;
        expect(connection.name).toBe(appName);
        const live = connection.grants
          .flatMap((grant) => grant.credentials)
          .filter((credential) => !credential.revokedAt);
        expect(live.map((credential) => credential.id)).toEqual([replacement.credentialId]);
      } finally {
        await second.close();
        if (replacement) await closeAll(replacement);
      }
    } finally {
      await closeAll(original);
    }
  }, 90_000);

  test("a replacement that never completes leaves the original sign-in working", async () => {
    const appName = "fictional abandoned replacement agent";
    const first = await stageConnectionApproval(harness, {
      clientName: appName,
      redirectUrl: callback(),
    });
    const original = await (
      await first.approve({
        kind: "new-connection",
        name: appName,
        level: { kind: "new", name: "abandoned replacement level", rules: [notesRule] },
      })
    ).finish();

    try {
      const second = await stageConnectionApproval(harness, {
        clientName: appName,
        redirectUrl: callback(),
      });
      try {
        await second.approve({
          kind: "replace-connection",
          connectionId: original.principalId,
          expectedGrantRevision: original.grantRevision,
        });
      } finally {
        await second.close();
      }

      expect(await toolNames(original)).toEqual(NOTES_TOOLS);
      const overview = await accessOverview(harness.gatewayUrl, original.portal);
      expect(activeSignIns(overview, original.principalId)).toEqual([original.credentialId]);
    } finally {
      await closeAll(original);
    }
  }, 90_000);

  test("renaming a connection relabels its sign-ins", async () => {
    const appName = "fictional renamed agent";
    const staged = await stageConnectionApproval(harness, {
      clientName: appName,
      redirectUrl: callback(),
    });
    const connection = await (
      await staged.approve({
        kind: "new-connection",
        name: appName,
        level: { kind: "new", name: "renamed agent level", rules: [notesRule] },
      })
    ).finish();

    try {
      const newName = "fictional renamed agent · workstation";
      const renamed = await portalJson<{ principal: { id: string; name: string } }>(
        harness.gatewayUrl,
        connection.portal,
        `/admin/access/principals/${encodeURIComponent(connection.principalId)}`,
        { name: newName },
        "PATCH",
      );
      expect(renamed.principal).toMatchObject({ id: connection.principalId, name: newName });

      const overview = await accessOverview(harness.gatewayUrl, connection.portal);
      const principal = overview.principals.find((p) => p.id === connection.principalId)!;
      expect(principal.name).toBe(newName);
      const live = principal.grants
        .flatMap((grant) => grant.credentials)
        .filter((credential) => credential.status === "active" && !credential.revokedAt);
      expect(live).toEqual([
        expect.objectContaining({ id: connection.credentialId, label: newName }),
      ]);
      expect(await toolNames(connection)).toEqual(NOTES_TOOLS);
    } finally {
      await closeAll(connection);
    }
  }, 90_000);

  test("a managed integration signing in again on its device replaces its connection, and it must keep Answer", async () => {
    const executionBinding = await pairManagedIntegration(harness, "fictional managed integration");
    const appName = "fictional managed answer agent";
    const answersLevelName = "managed agent answers";

    const first = await stageConnectionApproval(
      harness,
      { clientName: appName, redirectUrl: callback() },
      { executionBinding },
    );
    const original = await (async () => {
      try {
        expect(first.lookup.request.requiresAnswer).toBe(true);
        expect(first.lookup.connection).toMatchObject({ match: null, recommended: "new-level" });

        const notesOnly = await portalJson<{ level: AccessLevel }>(
          harness.gatewayUrl,
          first.portal,
          "/admin/access/levels",
          { name: "managed agent notes only", rules: [notesRule] },
        );
        const refused = await portalRequest(
          harness.gatewayUrl,
          first.portal,
          "POST",
          decisionPath(first),
          {
            decision: "approve",
            selection: {
              kind: "new-connection",
              name: appName,
              level: {
                kind: "existing",
                levelId: notesOnly.level.id,
                expectedLevelRevision: notesOnly.level.revision,
              },
            },
          },
        );
        expect(refused).toMatchObject({ status: 409, body: { error: "invalid-selection" } });

        return await (
          await first.approve({
            kind: "new-connection",
            name: appName,
            level: { kind: "new", name: answersLevelName, rules: [answerRule] },
          })
        ).finish();
      } finally {
        await first.close();
      }
    })();

    try {
      expect(await toolNames(original)).toEqual(ANSWER_TOOLS);
      const second = await stageConnectionApproval(
        harness,
        { clientName: appName, redirectUrl: callback() },
        { executionBinding },
      );
      let replacement: AuthorizedMcpClient | undefined;
      try {
        expect(second.lookup.connection).toMatchObject({
          recommended: "replace",
          match: {
            connectionId: original.principalId,
            connectionName: appName,
            matchedBy: "device",
          },
        });
        replacement = await (
          await second.approve({
            kind: "replace-connection",
            connectionId: original.principalId,
            expectedGrantRevision: original.grantRevision,
          })
        ).finish();

        expect(replacement.principalId).toBe(original.principalId);
        expect(replacement.credentialId).not.toBe(original.credentialId);
        expect(await toolNames(replacement)).toEqual(ANSWER_TOOLS);
        await expect(
          original.client.listTools(undefined, { cacheMode: "refresh" }),
        ).rejects.toBeDefined();
        const overview = await accessOverview(harness.gatewayUrl, original.portal);
        expect(activeSignIns(overview, original.principalId)).toEqual([replacement.credentialId]);
      } finally {
        await second.close();
        if (replacement) await closeAll(replacement);
      }
    } finally {
      await closeAll(original);
    }
  }, 120_000);

  test("an older managed integration's connect approval on its device replaces its connection", async () => {
    const executionBinding = await pairManagedIntegration(harness, "fictional older integration");
    const appName = "fictional older managed agent";

    const first = await stageConnectionApproval(
      harness,
      { clientName: appName, redirectUrl: callback() },
      { executionBinding },
    );
    const original = await (
      await first.approve({ kind: "connect", rules: [answerRule], credentialLabel: appName })
    ).finish();

    try {
      expect(await toolNames(original)).toEqual(ANSWER_TOOLS);
      const before = await accessOverview(harness.gatewayUrl, original.portal);
      const levelId = grantOf(before, original.grantId)?.levelId;
      expect(levelId).toEqual(expect.any(String));

      const second = await stageConnectionApproval(
        harness,
        { clientName: appName, redirectUrl: callback() },
        { executionBinding },
      );
      let replacement: AuthorizedMcpClient | undefined;
      try {
        expect(second.lookup.connection).toMatchObject({
          recommended: "replace",
          match: { connectionId: original.principalId, matchedBy: "device" },
        });
        replacement = await (
          await second.approve({ kind: "connect", rules: [answerRule], credentialLabel: appName })
        ).finish();

        expect(replacement.principalId).toBe(original.principalId);
        expect(replacement.grantId).toBe(original.grantId);
        expect(replacement.credentialId).not.toBe(original.credentialId);
        expect(await toolNames(replacement)).toEqual(ANSWER_TOOLS);
        await expect(
          original.client.listTools(undefined, { cacheMode: "refresh" }),
        ).rejects.toBeDefined();

        const after = await accessOverview(harness.gatewayUrl, original.portal);
        expect(activeSignIns(after, original.principalId)).toEqual([replacement.credentialId]);
        expect(grantOf(after, original.grantId)?.levelId).toBe(levelId);
        expect(liveConnectionNames(after)).toEqual(liveConnectionNames(before));
        expect((after.levels ?? []).map((level) => level.id)).toEqual(
          (before.levels ?? []).map((level) => level.id),
        );
      } finally {
        await second.close();
        if (replacement) await closeAll(replacement);
      }
    } finally {
      await closeAll(original);
    }
  }, 120_000);
});

async function toolNames(authorized: AuthorizedMcpClient): Promise<string[]> {
  const listed = await authorized.client.listTools(undefined, { cacheMode: "refresh" });
  return listed.tools.map((tool) => tool.name);
}

function liveConnectionNames(overview: AccessOverview): string[] {
  return overview.principals
    .filter((principal) => !principal.revokedAt)
    .map((principal) => principal.name);
}

function grantOf(
  overview: AccessOverview,
  grantId: string,
): AccessOverview["principals"][number]["grants"][number] | undefined {
  return overview.principals.flatMap((principal) => principal.grants).find((g) => g.id === grantId);
}

function levelNamed(overview: AccessOverview, name: string): AccessLevel {
  const level = overview.levels?.find((candidate) => candidate.name === name);
  if (!level) throw new Error(`The access overview has no level named "${name}".`);
  return level;
}

/** Ids of the connection's active, unrevoked sign-ins. */
function activeSignIns(overview: AccessOverview, connectionId: string): string[] {
  return (overview.principals.find((principal) => principal.id === connectionId)?.grants ?? [])
    .flatMap((grant) => grant.credentials)
    .filter((credential) => credential.status === "active" && !credential.revokedAt)
    .map((credential) => credential.id);
}

/**
 * Pairs an agent device the way a managed OpenClaw integration does and
 * returns the binding its OAuth sign-ins present, which ties each sign-in to
 * that device.
 */
async function pairManagedIntegration(
  harness: SyntheticE2EHarness,
  deviceName: string,
): Promise<{ deviceToken: string; harness: "openclaw" }> {
  const pendingPairing = await harness.gatewayJson<{ pairingCode: string }>("/admin/devices/pair", {
    method: "POST",
    body: JSON.stringify({ name: deviceName, kind: "agent", scopes: ["subscriptions:receive"] }),
  });
  const agentIntegration = {
    harness: "openclaw",
    deliveryProtocolMin: 3,
    deliveryProtocolMax: 4,
    maxConcurrentRuns: 1,
    watchPrivacyPolicyVersion: 1,
  };
  const paired = await harness.gatewayJson<{ credentials: { management: { token: string } } }>(
    "/devices/pair",
    {
      method: "POST",
      body: JSON.stringify({
        pairingCode: pendingPairing.pairingCode,
        agentIntegration: { harness: "openclaw" },
        capabilities: { suggestedName: deviceName, agentIntegration },
      }),
    },
  );
  return { deviceToken: paired.credentials.management.token, harness: "openclaw" };
}

function decisionPath(staged: StagedConnectionApproval): string {
  return `/portal/api/access/authorizations/${encodeURIComponent(staged.lookup.request.approvalId)}/decision`;
}

async function closeAll(...clients: AuthorizedMcpClient[]): Promise<void> {
  await Promise.allSettled(
    clients.flatMap((authorized) => [authorized.client.close(), authorized.transport.close()]),
  );
}
