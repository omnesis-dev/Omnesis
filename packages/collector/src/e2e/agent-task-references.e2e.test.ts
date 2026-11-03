// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { BrainBench, call, waitFor } from "./brain-bench/index.js";

const FIRST_REQUEST =
  "Add a task to arrange the fictional mosaic samples, with the guide attached.";
const SECOND_REQUEST = "Add a separate task to label the fictional mosaic drawers.";
const FIRST_TITLE = "Arrange the fictional mosaic samples";
const SECOND_TITLE = "Label the fictional mosaic drawers";

describe("conversation references on agent-created tasks", () => {
  let bench: BrainBench;
  let guideId: string;

  beforeAll(async () => {
    bench = await BrainBench.start({
      experimental: false,
      brainAgent: false,
      universe: "e2e-minimal",
      syncSources: false,
      agent: {
        behaviors: [
          {
            messageContains: FIRST_REQUEST,
            plan: () => ({
              calls: [call("task_create", { title: FIRST_TITLE, docs: [guideId] })],
              finalText: "Added the sample task with its guide.",
            }),
          },
          {
            messageContains: SECOND_REQUEST,
            plan: { calls: [call("task_create", { title: SECOND_TITLE })], finalText: "Added." },
          },
        ],
      },
    });
    await bench.push({
      externalId: "invented-mosaic-guide",
      title: "Fictional mosaic sample guide",
      content: "Arrange the invented sample tiles by their fictional catalogue number.",
    });
    guideId = await bench.docId("invented-mosaic-guide");
  }, 240_000);

  afterAll(async () => {
    await bench?.destroy();
  }, 60_000);

  async function send(sessionId: string, text: string): Promise<void> {
    const response = await bench.harness.gatewayFetch(`/agent/sessions/${sessionId}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    expect(response.status).toBe(200);
    await waitFor(
      "the task-creating conversation turn",
      async () => {
        const controls = await bench.harness.gatewayJson<{ busy: boolean }>(
          `/agent/sessions/${sessionId}/controls`,
        );
        return bench.conversationCalls.some((entry) => entry.context.message === text) &&
          !controls.busy
          ? true
          : null;
      },
      60_000,
    );
  }

  test("keeps explicit references and links the creating chat before and after restart", async () => {
    const { sessionId } = await bench.harness.gatewayJson<{ sessionId: string }>(
      "/agent/sessions",
      {
        method: "POST",
        body: JSON.stringify({ timeZone: "UTC" }),
      },
    );
    await send(sessionId, FIRST_REQUEST);
    const { tasks } = await bench.obs.tasks("anytime");
    const first = tasks.find((task) => task.title === FIRST_TITLE);
    expect(first).toBeDefined();
    const conversationDocumentId = await bench.docId(sessionId);
    expect(first!.documents.map((document) => document.id).sort()).toEqual(
      [guideId, conversationDocumentId].sort(),
    );
    expect((await bench.obs.task(first!.id)).history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "created", conversationId: sessionId }),
      ]),
    );

    await bench.harness.restartGateway();
    await bench.harness.gatewayJson("/agent/sessions", {
      method: "POST",
      body: JSON.stringify({ resumeFromId: sessionId, timeZone: "UTC" }),
    });
    await send(sessionId, SECOND_REQUEST);
    const after = await bench.obs.tasks("anytime");
    const second = after.tasks.find((task) => task.title === SECOND_TITLE);
    expect(second?.documents.map((document) => document.id)).toEqual([conversationDocumentId]);
    expect(
      (await bench.obs.task(first!.id)).task.documents.map((document) => document.id).sort(),
    ).toEqual([guideId, conversationDocumentId].sort());
    const conversation = await bench.harness.gatewayJson<{ messages: unknown[] }>(
      `/agent/conversations/${sessionId}`,
    );
    expect(JSON.stringify(conversation.messages)).toContain(FIRST_REQUEST);
    expect(JSON.stringify(conversation.messages)).toContain(SECOND_REQUEST);
    expect(
      after.tasks.filter((task) => [FIRST_TITLE, SECOND_TITLE].includes(task.title)),
    ).toHaveLength(2);
  }, 180_000);
});
