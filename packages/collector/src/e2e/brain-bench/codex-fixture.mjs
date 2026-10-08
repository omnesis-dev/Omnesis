// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Deterministic app-server model substitute; every tool executes in the real gateway.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.142.4\n");
  process.exit(0);
}
if (process.argv.includes("login")) {
  process.stdout.write("Logged in with a synthetic account\n");
  process.exit(0);
}

const threads = new Map();
const pending = new Map();
let next = 0;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const log = (event, detail) =>
  appendFileSync(process.env.OMNESIS_FAKE_CODEX_LOG, `${JSON.stringify({ event, ...detail })}\n`);
function finish(thread, text) {
  log("complete", { model: thread.model, threadId: thread.id });
  send({
    method: "item/completed",
    params: {
      threadId: thread.id,
      turnId: thread.turn,
      item: { type: "agentMessage", id: `message-${next++}`, text, phase: "final_answer" },
    },
  });
  send({
    method: "turn/completed",
    params: { threadId: thread.id, turn: { id: thread.turn, status: "completed" } },
  });
}
function call(thread, name, args, then) {
  const id = next++;
  pending.set(id, then);
  send({
    id,
    method: "item/tool/call",
    params: {
      threadId: thread.id,
      turnId: thread.turn,
      callId: `call-${id}`,
      tool: name,
      arguments: args,
    },
  });
}
function run(thread, inputs) {
  const prompt = inputs
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  log("start", {
    model: thread.model,
    threadId: thread.id,
    image: inputs.some((item) => item.type === "image"),
    runId: /Loop agent run (\S+) \(kind:/.exec(prompt)?.[1] ?? null,
  });
  if (thread.model === "fixture-ocr") return finish(thread, "Synthetic image label");
  if (thread.model === "fixture-verifier") {
    return finish(thread, /^Claim: .*unsupported-claim/m.test(prompt) ? "NEUTRAL" : "ENTAILMENT");
  }
  if (thread.model === "fixture-judge") {
    return finish(
      thread,
      `Reason: scripted verdict.\nVERDICT: ${prompt.includes("judge-held") ? "HOLD" : "SHIP"}`,
    );
  }
  if (!prompt.includes("Maintain the evidence-backed synthesis graph for this batch."))
    return finish(thread, "No scripted work.");
  const quote = "The fictional workshop registration closes on Friday.";
  const parseTool = (reply) => {
    const text = reply?.contentItems?.find((item) => item.type === "inputText")?.text;
    return text ? JSON.parse(text) : null;
  };
  const frontier = () =>
    call(thread, "knowledge_next_frontier", {}, (reply) => {
      const result = parseTool(reply);
      if (result?.kind !== "structured")
        return finish(thread, "Frontier unavailable; preserve pending work.");
      if (result.data.done) return finish(thread, "Completed scripted maintenance.");
      const items = [...result.data.items];
      const consume = () => {
        const item = items.shift();
        if (!item) return frontier();
        if (!item.source) {
          const node = item.node;
          if (!node) return finish(thread, "Missing offered node.");
          if (
            node.validity !== "current" ||
            (!node.ownerId && !(node.kind === "root" && node.markdown === "")) ||
            !node.claims.every((claim) => /^legacy(?:-context-\d+)?$/.test(claim.id))
          )
            return finish(thread, "Owner needs an explicit factual repair decision.");
          // Read-side verification/review timestamps are engine-owned.
          const metadata = Object.fromEntries(
            ["importance", "volatility", "uncertainty", "activity", "nextReviewAt", "checkpointAt"]
              .filter((key) => Object.hasOwn(node.metadata, key))
              .map((key) => [key, node.metadata[key]]),
          );
          return call(
            thread,
            "knowledge_save",
            {
              node: {
                id: node.id,
                kind: node.kind,
                ...(node.ownerId ? { ownerId: node.ownerId } : {}),
                title: node.title,
                markdown: node.markdown,
                expectedRevision: node.revision,
                inputVersions: item.inputVersions,
                metadata,
                claims: node.claims.map((claim) => ({
                  id: claim.id,
                  supportLogic: claim.supportLogic,
                  validFrom: claim.validFrom,
                  validUntil: claim.validUntil,
                  relations: Object.fromEntries(claim.refs.map((ref) => [ref, "context"])),
                })),
              },
              inputFingerprint: item.inputFingerprint,
            },
            (reply) =>
              parseTool(reply)?.kind === "error"
                ? finish(thread, "Canonical save refused.")
                : consume(),
          );
        }
        const docId = item.source.id;
        const complete = () =>
          call(
            thread,
            "knowledge_discovery_complete",
            {
              id: item.id,
              inputFingerprint: item.inputFingerprint,
              targets: [],
            },
            (reply) =>
              parseTool(reply)?.kind === "error"
                ? finish(thread, "Source completion refused.")
                : consume(),
          );
        if (item.source.title !== "Fictional registration reminder") return complete();
        const variants = ["accepted", "judge-held", "unsupported-claim"];
        const createNext = () => {
          const variant = variants.shift();
          if (!variant) return complete();
          call(
            thread,
            "brief_create",
            {
              kind: "info",
              title: `codex-bench-${variant}`,
              body: quote,
              citations: [docId],
              confidence: 0.9,
              urgency: 0.6,
              annotationDependencies: [],
              assertedClaims: [
                {
                  claimText: variant === "unsupported-claim" ? "unsupported-claim" : quote,
                  evidenceDocId: docId,
                  evidenceQuote: quote,
                  confidence: 0.9,
                  claimBasis: "quoted",
                },
              ],
            },
            createNext,
          );
        };
        call(thread, "fetch_many", { documents: [{ documentId: docId }] }, createNext);
      };
      consume();
    });
  frontier();
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    const callback = pending.get(message.id);
    pending.delete(message.id);
    callback?.(message.result);
    return;
  }
  const params = message.params ?? {};
  if (message.method === "initialize")
    return send({ id: message.id, result: { userAgent: "brain-bench" } });
  if (message.method === "initialized") return;
  if (message.method === "model/list") {
    return send({
      id: message.id,
      result: {
        data: ["parent", "verifier", "judge", "ocr"].map((role) => ({
          id: `fixture-${role}`,
          model: `fixture-${role}`,
          displayName: `fixture-${role}`,
          inputModalities: ["text", "image"],
          hidden: false,
        })),
        nextCursor: null,
      },
    });
  }
  if (message.method === "thread/start") {
    const id = `thread-${next++}`;
    threads.set(id, { id, model: params.model });
    return send({ id: message.id, result: { thread: { id } } });
  }
  if (message.method === "thread/unsubscribe") return send({ id: message.id, result: {} });
  if (message.method === "turn/start") {
    const thread = threads.get(params.threadId);
    thread.turn = `turn-${next++}`;
    send({ id: message.id, result: { turn: { id: thread.turn, status: "inProgress" } } });
    setImmediate(() => run(thread, params.input));
    return;
  }
  send({ id: message.id, result: {} });
});
