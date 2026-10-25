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
  appendFileSync(
    process.env.OMNESIS_FAKE_CODEX_LOG,
    `${JSON.stringify({ event, processId: process.pid, ...detail })}\n`,
  );
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
/** The positive witness a scripted verdict cites: the evidence frame's own source text. */
function evidenceWitness(evidence) {
  try {
    const frame = JSON.parse(evidence);
    if (Array.isArray(frame.evidenceParts) && frame.evidenceParts.length)
      return evidenceWitness(frame.evidenceParts[0]);
    if (frame.verifiedReferences?.[0]?.text) return frame.verifiedReferences[0].text.slice(0, 1024);
    if (frame.sources?.[0]?.authority === "selected_quote" && frame.sources[0].selectedQuotes?.[0])
      return frame.sources[0].selectedQuotes[0].slice(0, 1024);
    if (typeof frame.sources?.[0]?.text === "string") return frame.sources[0].text.slice(0, 1024);
  } catch {
    /* Ordinary source text. */
  }
  return evidence.slice(0, 1024);
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
    if (prompt.includes('"assessment":"annotation_atomic"')) {
      const input = JSON.parse(prompt.trim().split("\n").at(-1));
      const reject = input.claim.includes("unsupported-claim");
      return finish(
        thread,
        JSON.stringify({
          coverage: { verdict: "complete", reason: "Scripted coverage." },
          assertions: [
            {
              id: "a1",
              spans: [{ text: input.claim, occurrence: 0 }],
              candidate: {
                actor: null,
                action: null,
                target: null,
                stage: null,
                time: null,
                condition: null,
                quantifier: null,
              },
              verdict: reject ? "unsupported" : "supported",
              evidenceQuotes: reject ? [] : [evidenceWitness(input.evidence)],
              reason: "Scripted fixture verdict.",
            },
          ],
          placementSupport: {
            verdict: "not_applicable",
            evidenceQuotes: [],
            reason: "Scripted generic annotation.",
          },
        }),
      );
    }
    if (prompt.includes("contentInContext") && prompt.includes("placementSupport")) {
      const input = JSON.parse(prompt.trim().split("\n").at(-1));
      const reject = input.claim.includes("unsupported-claim");
      let witness = input.evidence;
      try {
        const frame = JSON.parse(input.evidence);
        if (typeof frame.sources?.[0]?.text === "string") witness = frame.sources[0].text;
      } catch {
        /* Ordinary source text. */
      }
      const assessment = {
        verdict: reject ? "unsupported" : "supported",
        evidenceQuotes: reject ? [] : [witness.slice(0, 1024)],
        reason: "Scripted fixture verdict.",
      };
      return finish(
        thread,
        JSON.stringify({ contentInContext: assessment, placementSupport: assessment }),
      );
    }
    return finish(thread, /^Claim: .*unsupported-claim/m.test(prompt) ? "NEUTRAL" : "ENTAILMENT");
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
          return call(thread, "knowledge_fetch", { id: item.id, editing: true }, (reply) => {
            const fetched = parseTool(reply);
            const node = fetched?.kind === "structured" ? fetched.data : null;
            if (!node) return finish(thread, "Missing offered node.");
            if (
              node.validity !== "current" ||
              (!node.ownerId && !(node.kind === "root" && node.markdown === "")) ||
              !node.claims.every((claim) => /^legacy(?:-context-\d+)?$/.test(claim.id))
            )
              return finish(thread, "Owner needs an explicit factual repair decision.");
            // A node read's metadata and claims are already the editable shape;
            // references live under readOnly.
            const refs = new Map(node.readOnly.claims.map((claim) => [claim.id, claim.refs]));
            const save = () =>
              call(
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
                    metadata: node.metadata,
                    claims: node.claims.map((claim) => ({
                      ...claim,
                      relations: Object.fromEntries(
                        (refs.get(claim.id) ?? []).map((ref) => [ref, "context"]),
                      ),
                    })),
                  },
                  inputFingerprint: item.inputFingerprint,
                  reviewedClaimIds: item.pendingClaimIds ?? [],
                },
                (reply) => {
                  const result = parseTool(reply);
                  return result?.kind === "error"
                    ? finish(thread, `Canonical save refused: ${result.code}: ${result.message}`)
                    : consume();
                },
              );
            return node.kind === "root"
              ? call(thread, "knowledge_list", { kind: "wiki" }, () => save())
              : save();
          });
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
        // One observation (no model gate at note time), then one supported
        // and one unsupported durable annotation: each annotation asks the
        // Codex entailment verifier while this parent turn waits.
        const annotate = (variant, then) =>
          call(
            thread,
            "annotate_durable",
            {
              docId,
              claimType: `codex-bench-${variant}`,
              claimText: variant === "unsupported-claim" ? "unsupported-claim" : quote,
              evidenceDocId: docId,
              evidenceQuote: quote,
              confidence: 0.9,
              claimBasis: "quoted",
            },
            then,
          );
        const createNext = () =>
          call(thread, "observation_list", {}, (reply) => {
            if (parseTool(reply)?.kind === "error")
              return finish(thread, "Observation inventory read refused; preserve pending work.");
            call(
              thread,
              "observation_note",
              {
                summary: "codex-bench-accepted: the workshop registration closes on Friday.",
                citations: [docId],
                claims: [{ docId, quote }],
                annotationDependencies: [],
              },
              () =>
                call(thread, "annotation_search", { docId }, () =>
                  annotate("accepted", () => annotate("unsupported-claim", complete)),
                ),
            );
          });
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
        data: ["parent", "verifier", "ocr"].map((role) => ({
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
