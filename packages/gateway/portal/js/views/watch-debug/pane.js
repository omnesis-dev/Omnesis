// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The right pane: everything the DSL configures on one node, structured.
 *
 * The canvas says what a watch is shaped like; this says what it is set to.
 * Every field is rendered as itself — a filter as its predicates, a recall arm
 * with its threshold, a judge with the sentence it puts and the schema it must
 * answer in — because a pane that dumped the JSON would be the definition
 * disclosure that already exists on the Watches page. The raw JSON is still
 * one toggle away, since it is what you copy when a watch is not doing what you
 * expected.
 *
 * When a state snapshot has been read it opens with what the node is *holding* —
 * the cells, read for the node's own type — above what it is *set to*. That
 * order is deliberate: someone who opened a node while debugging wants the live
 * cell first and the configuration as the thing they check it against.
 *
 * Nothing here mutates: this page is read-only by design, and pausing, probing
 * and firing stay in the CLI.
 */

import { html } from "htm/preact";

import { navigate } from "../../lib/router.js";
import {
  isPlainObject,
  isWatchNodeStateful,
  textList,
  watchDeliveryFields,
  watchFiringPolicyLabel,
  watchNodeBadges,
  watchNodeSummary,
  watchNodeTraits,
  watchPropositions,
} from "../../lib/watch-dsl.js";
import { formatPrivacyDate } from "../shared/privacy-vocabulary.js";
import {
  installedWatchDelivery,
  installedWatchRequest,
  installedWatchStatusLabel,
  watchInstant,
  watchVerdictSentence,
} from "../watches/vocabulary.js";
import { WatchNodeStateSection, WatchWatchStateSection } from "./state.js";

/**
 * The pane itself. It borrows the Sources debug drawer's chrome — sticky
 * header, padded body — but not its dimming backdrop: the canvas is laid out
 * top to bottom precisely so a source→sink path stays readable while a node is
 * open, and a backdrop over it would take that back. So the pane overlays the
 * right edge, the canvas beside it stays live, and clicking another node moves
 * the pane rather than having to close it first.
 */
export function WatchDagPane({
  selection,
  watch,
  dag,
  state = null,
  selectedKeyHash = null,
  onSelectKey = () => {},
  onClose,
}) {
  if (!selection) return null;
  const node = selection.kind === "node" ? dag?.nodeById.get(selection.id) : null;
  const title =
    selection.kind === "watch"
      ? watch.name
      : node?.kind === "sink"
        ? "sink"
        : (node?.type ?? "Unknown node");
  const subtitle = selection.kind === "node" && node?.kind === "node" ? node.id : null;
  return html`<div
    class="sources-drawer watch-dag-drawer"
    role="dialog"
    aria-label=${`Watch definition — ${title}`}
  >
    <div class="sources-drawer-header">
      <h3>${title}${subtitle ? html` — <code>${subtitle}</code>` : null}</h3>
      <button type="button" class="btn-tiny" onClick=${onClose}>close</button>
    </div>
    <div class="sources-drawer-body">
      ${selection.kind === "watch"
        ? html`<${WatchPane}
            watch=${watch}
            dag=${dag}
            state=${state}
            onSelectKey=${onSelectKey}
          />`
        : node
          ? node.kind === "sink"
            ? html`<${SinkPane} node=${node} />`
            : html`<${NodePane}
                node=${node}
                dag=${dag}
                state=${state}
                selectedKeyHash=${selectedKeyHash}
              />`
          : html`<p class="privacy-empty">
              This node is no longer part of the definition on screen.
            </p>`}
    </div>
  </div>`;
}

// ── The watch as a whole ────────────────────────────────────────────────────

function WatchPane({ watch, dag, state, onSelectKey }) {
  const definition = dag?.definition ?? watch?.dsl?.watch ?? null;
  const request = installedWatchRequest(watch);
  const delivery = installedWatchDelivery(watch);
  const propositions = watchPropositions(definition);
  const compileRunHref = watch.compileRunId
    ? `/portal/debug/cognition/runs/${encodeURIComponent(watch.compileRunId)}`
    : null;
  const constants = isPlainObject(definition?.constants) ? Object.entries(definition.constants) : [];
  // Fields the DSL carries are printed as written — an expiry instant and a
  // fingerprint are values you compare and paste, and humanising them would
  // lose the comparison. Fields the store carries *about* the watch are
  // humanised, because they are facts about this install rather than part of
  // the definition.
  const runRows = [
    ["Status", installedWatchStatusLabel(watch.status)],
    ["Paused because", watch.note],
    ["Firing policy", watchFiringPolicyLabel(definition?.firing_policy)],
    ["Expires", definition?.expires_at ?? "Never — it has no horizon of its own"],
    ["Ontology fingerprint", code(definition?.ontology_fingerprint)],
    ["Delivery", delivery.text],
    // The referents the instruction names, on one line. A reader who never
    // opens the sink node still has to be able to see what the wake points at.
    [
      "Referents",
      (delivery.bindings ?? []).map(([name, referent]) => `${name} = ${referent}`).join(", "),
    ],
    ["Added", formatPrivacyDate(watchInstant(watch.addedAt))],
    ["Watching from", `journal event ${watch.fromSeq ?? 0}`],
    ["Watch id", code(watch.id)],
    ["Name", code(definition?.name ?? watch.name)],
  ];
  const verdict = watch?.verdict ?? null;
  return html`
    <${WatchWatchStateSection} state=${state} onSelectKey=${onSelectKey} />
    ${verdict
      ? html`<${Section} title="Whether it is any good">
          <p class="watch-pane-prose">
            ${watchVerdictSentence(watch)}.
          </p>
          <p class="watch-pane-note">
            Read from what this watch has caught, declined and been judged on. A
            watch that has said nothing looks the same on every other section of
            this page whether it is waiting, too narrow, or reaching nobody.
          </p>
        <//>`
      : null}
    <${Section} title="What you asked for">
      <p class="watch-pane-prose">
        ${request ?? "This watch was written as a definition, so it carries no request."}
      </p>
    <//>
    <${Section} title="What it decides">
      <p class="watch-pane-note">
        An installed watch stores no approved interpretation. What it decides is the propositions
        its judging nodes carry — the exact sentences a model is asked to answer.
      </p>
      ${propositions.length > 0
        ? html`<ul class="watch-pane-list">
            ${propositions.map(
              (item) => html`<li key=${`${item.nodeId}:${item.kind}`}>
                <code>${item.nodeId}</code> <span class="watch-pane-dim">(${item.kind})</span>
                <p class="watch-pane-prose">${item.proposition}</p>
              </li>`,
            )}
          </ul>`
        : html`<p class="privacy-empty">
            Nothing is judged: this watch fires on a condition Omnesis decides outright.
          </p>`}
    <//>
    <${Section} title="How it runs">
      <${Rows} rows=${runRows} />
      ${compileRunHref
        ? html`<p class="watch-pane-prose">
            <a
              class="watch-link"
              href=${compileRunHref}
              onClick=${(event) => {
                if (
                  event.metaKey
                  || event.ctrlKey
                  || event.shiftKey
                  || event.altKey
                  || event.button !== 0
                ) return;
                event.preventDefault();
                navigate(compileRunHref);
              }}
            >View the compile transcript</a>
          </p>`
        : html`<p class="watch-pane-note">
            No compile transcript: this watch was installed from a hand-written definition.
          </p>`}
    <//>
    ${constants.length > 0
      ? html`<${Section} title="Constants">
          <p class="watch-pane-note">
            Values the compiler resolved from the corpus once, because they will never arrive as an
            event.
          </p>
          <ul class="watch-pane-list">
            ${constants.map(
              ([name, constant]) => html`<li key=${name}>
                <code>${name}</code> <span class="watch-pane-dim">${constant?.type}</span>
                <p class="watch-pane-prose">${String(constant?.value)}</p>
                <p class="watch-pane-note">
                  From <code>${constant?.provenance_doc}</code>${constant?.provenance_note
                    ? ` — ${constant.provenance_note}`
                    : ""}
                </p>
              </li>`,
            )}
          </ul>
        <//>`
      : null}
    <${WatchRawJson} value=${watch.dsl} />
  `;
}

// ── One node ────────────────────────────────────────────────────────────────

function NodePane({ node, dag, state, selectedKeyHash }) {
  const raw = node.node;
  const inbound = dag.edges.filter((edge) => edge.to === node.id);
  const traits = watchNodeTraits(node.type);
  const badges = watchNodeBadges(raw);
  return html`
    <${WatchNodeStateSection}
      node=${node}
      state=${state}
      selectedKeyHash=${selectedKeyHash}
    />
    <${Section} title="What it is">
      <${Rows}
        rows=${[
          ["Type", code(node.type)],
          ["Id", code(node.id)],
          ["In one line", watchNodeSummary(raw)],
          [
            "Holds state",
            traits === null
              ? "This build does not recognise the type, so it makes no claim."
              : isWatchNodeStateful(raw)
                ? "Yes — a cell lives between arm and fire"
                : "No — it evaluates on arrival and keeps nothing",
          ],
        ]}
      />
      ${raw.comment
        ? html`<p class="watch-pane-prose watch-pane-comment">${raw.comment}</p>`
        : null}
    <//>
    <${Section} title="Inputs">
      ${inbound.length === 0
        ? html`<p class="privacy-empty">
            Nothing upstream — this is a trip-wire, armed by the journal.
          </p>`
        : html`<ul class="watch-pane-list">
            ${inbound.map(
              (edge) => html`<li key=${edge.from}>
                <code>${edge.from}</code>
                <span class=${`watch-dag-note ${edge.role === "cancel" ? "cancel" : "arm"}`}>
                  ${edge.role}
                </span>
                ${edge.broadcast
                  ? html`<span class="watch-dag-note broadcast">broadcast</span>`
                  : null}
                ${edge.key
                  ? html`<${ExpressionMap} map=${edge.key} caption="Keyed by" />`
                  : html`<p class="watch-pane-note">
                      No key on this edge${edge.broadcast
                        ? " — it fans out to every live key."
                        : "."}
                    </p>`}
              </li>`,
            )}
          </ul>`}
      <${Rows}
        rows=${[
          [
            "Keyed",
            node.keyed
              ? `Yes — one cell per (${node.keyComponents.join(", ")})`
              : "No — one global cell",
          ],
          ["Cancellable", traits === null ? null : traits.cancellable ? "Yes" : "No"],
        ]}
      />
    <//>
    ${nodeDetail(node.type, raw)}
    ${badges.length > 0
      ? html`<${Section} title="Behaviour">
          <${Rows} rows=${badges.map((badge) => [badge.label, badge.title])} />
        <//>`
      : null}
    ${isPlainObject(raw.output_map)
      ? html`<${Section} title="Output">
          <p class="watch-pane-note">
            What this node hands downstream, and the name each field arrives under.
          </p>
          <${ExpressionMap} map=${raw.output_map} />
        <//>`
      : null}
    <${WatchRawJson} value=${raw} />
  `;
}

/**
 * The fields only this node type has. An unrecognised type gets nothing here
 * and falls through to its raw JSON, which is the honest answer.
 */
function nodeDetail(type, node) {
  const detail = NODE_DETAILS[type];
  return detail ? detail(node) : null;
}

const NODE_DETAILS = {
  "source.document_event": (node) => html`
    <${Section} title="Filter">
      <${Rows}
        rows=${[
          ["Source", textList(node.filter?.source)],
          ["Document type", textList(node.filter?.documentType)],
          ["Events", textList(node.filter?.event)],
        ]}
      />
      ${Array.isArray(node.filter?.metadata) && node.filter.metadata.length > 0
        ? html`<${Rows}
            rows=${node.filter.metadata.map((predicate, index) => [
              index === 0 ? "Metadata" : "",
              code(metadataPredicateText(predicate)),
            ])}
          />`
        : null}
      ${Array.isArray(node.filter?.people) && node.filter.people.length > 0
        ? html`<${Rows}
            rows=${node.filter.people.map((predicate, index) => [
              index === 0 ? "People" : "",
              personPredicateText(predicate),
            ])}
          />`
        : null}
    <//>
    ${isPlainObject(node.recall)
      ? html`<${Section} title="Recall">
          <p class="watch-pane-note">
            How a document is put in front of the judge. The arms are OR-composed, and nomination
            is never firing.
          </p>
          <${Rows}
            rows=${[
              ["Semantic query", node.recall.semantic?.query],
              [
                "Similarity floor",
                Number.isFinite(node.recall.semantic?.threshold)
                  ? String(node.recall.semantic.threshold)
                  : null,
              ],
              ["Literal terms", textList(node.recall.lexical?.terms)],
              ["Term kind", node.recall.lexical?.match],
            ]}
          />
        <//>`
      : null}
    ${isPlainObject(node.judge)
      ? html`<${Section} title="Judge">
          <p class="watch-pane-prose">${node.judge.proposition}</p>
          <${SchemaTable} schema=${node.judge.output_schema} />
        <//>`
      : null}
  `,
  "source.analytics_row": (node) => html`
    <${Section} title="Rows">
      <${Rows}
        rows=${[
          ["Table", code(node.table)],
          ["Arrivals", textList(node.op)],
          ["Backfill", node.backfill ?? "ignore"],
        ]}
      />
      ${node.predicate ? html`<${Code} text=${node.predicate} />` : null}
    <//>
  `,
  "source.open_loop": (node) => html`
    <${Section} title="Loops">
      <${Rows}
        rows=${[
          ["Arrivals", textList(node.op)],
          ["Named loops", textList(node.loop_ids) ?? "Any loop"],
          ["States", textList(node.filter?.state)],
          ["Actors", textList(node.filter?.actors)],
          ["Involved", textList(node.filter?.involved)],
        ]}
      />
    <//>
  `,
  "source.time": (node) => html`
    <${Section} title="Clock">
      <${Rows}
        rows=${[
          ["Recurring", code(node.recurring)],
          ["One-off", node.one_off],
        ]}
      />
    <//>
  `,
  "stateless.transform": (node) => html`
    <${Section} title="Query">
      <${Code} text=${node.query} />
    <//>
  `,
  "stateful.wait": (node) => html`
    <${Section} title="Wait">
      <${Rows} rows=${[["Duration", node.duration]]} />
      <p class="watch-pane-note">The wait is the deadline: its expiry is the fire.</p>
    <//>
  `,
  "stateful.and": (node) => html`
    <${Section} title="Join">
      <${Rows} rows=${[["Deadline", node.deadline]]} />
    <//>
  `,
  "stateful.threshold": (node) => html`
    <${Section} title="Threshold">
      <${Rows}
        rows=${[
          ["Arms needed", Number.isInteger(node.n) ? String(node.n) : null],
          ["Deadline", node.deadline],
        ]}
      />
    <//>
  `,
  "stateful.sequence": (node) => html`
    <${Section} title="Order">
      <p class="watch-pane-prose">
        ${Array.isArray(node.order) ? node.order.join(" → ") : "No order declared."}
      </p>
      <${Rows} rows=${[["Deadline", node.deadline]]} />
    <//>
  `,
  "stateful.cooldown": (node) => html`
    <${Section} title="Cooldown">
      <${Rows} rows=${[["Minimum interval", node.min_interval]]} />
    <//>
  `,
  "stateful.persistence": (node) => html`
    <${Section} title="Persistence">
      <${Rows}
        rows=${[
          ["Window", node.duration],
          ["Events needed", Number.isInteger(node.min_events) ? String(node.min_events) : null],
        ]}
      />
    <//>
  `,
  sql: (node) => html`
    <${Section} title="Query">
      <${Code} text=${node.query} />
      <${Rows}
        rows=${[
          ["Fires on", node.fire_on],
          ["Level before the first run", node.initial_level],
          ["Re-run interval", node.timer],
          ["Must hold for", node.persistence],
          ["Deadline", node.deadline],
        ]}
      />
    <//>
  `,
  llm: (node) => html`
    <${Section} title="Deliberation">
      <${Rows} rows=${[["Mode", node.mode]]} />
      <p class="watch-pane-prose">${node.proposition}</p>
      <${SchemaTable} schema=${node.output_schema} />
      <${Rows}
        rows=${[
          ["Fires when", code(node.fire_when ?? "decision")],
          ["Horizon", node.scope?.horizon],
          ["Tools", textList(node.tools)],
          [
            "Budget",
            isPlainObject(node.budget)
              ? `${node.budget.tool_calls} tool calls · ${node.budget.tokens} tokens`
              : null,
          ],
          ["Deadline", node.deadline],
        ]}
      />
    <//>
  `,
};

function metadataPredicateText(predicate) {
  if (!isPlainObject(predicate)) return null;
  const value = Array.isArray(predicate.value)
    ? `[${predicate.value.join(", ")}]`
    : predicate.value;
  return value === undefined
    ? `${predicate.path} ${predicate.op}`
    : `${predicate.path} ${predicate.op} ${String(value)}`;
}

/**
 * A role-based person predicate in words. There is no direction field on a
 * document, so inbound is a sender that is not self and outbound is one that is
 * — which is what `isSelf` is saying here.
 */
function personPredicateText(predicate) {
  if (!isPlainObject(predicate)) return null;
  if (typeof predicate.person === "string") return `${predicate.role}: ${predicate.person}`;
  if (predicate.isSelf === true) return `${predicate.role}: you`;
  if (predicate.isSelf === false) return `${predicate.role}: anyone but you`;
  return `${predicate.role}: anyone`;
}

// ── The sink ────────────────────────────────────────────────────────────────

function SinkPane({ node }) {
  const delivery = watchDeliveryFields(node.delivery);
  return html`
    <${Section} title="Input">
      <${Rows} rows=${[["From", code(node.node?.input)]]} />
      <p class="watch-pane-note">
        The terminal node. What it hands the sink is what the firing carries.
      </p>
    <//>
    ${isPlainObject(node.node?.output_map)
      ? html`<${Section} title="Output">
          <p class="watch-pane-note">The fields a firing is recorded with.</p>
          <${ExpressionMap} map=${node.node.output_map} />
        <//>`
      : html`<${Section} title="Output">
          <p class="privacy-empty">
            No output map: the firing carries the terminal node's own output.
          </p>
        <//>`}
    <${Section} title="Delivery">
      ${delivery
        ? html`
            <${Rows}
              rows=${[["Kind", code(delivery.kind)], ...delivery.fields]}
            />
            ${delivery.note ? html`<p class="watch-pane-note">${delivery.note}</p>` : null}
          `
        : html`<p class="privacy-empty">
            Delivers nowhere. Every firing is recorded and nobody is told.
          </p>`}
    <//>
    <${WatchRawJson} value=${{ sink: node.node, delivery: node.delivery }} />
  `;
}

// ── Shared building blocks ──────────────────────────────────────────────────

function Section({ title, children }) {
  return html`<section class="watch-pane-section">
    <h4>${title}</h4>
    ${children}
  </section>`;
}

/**
 * Label / value pairs. A null value drops its row entirely: an absent field is
 * not the same as an empty one, and a row reading "—" invites a reader to
 * wonder which it was.
 */
function Rows({ rows }) {
  const present = rows.filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (present.length === 0) return null;
  return html`<dl class="watch-pane-rows">
    ${present.map(
      ([label, value], index) => html`<div key=${`${label}:${index}`}>
        <dt>${label}</dt>
        <dd>${value}</dd>
      </div>`,
    )}
  </dl>`;
}

/** A `{name: expression}` map — a key extractor, an output map. */
function ExpressionMap({ map, caption = null }) {
  const entries = isPlainObject(map) ? Object.entries(map) : [];
  if (entries.length === 0) return null;
  return html`<div class="watch-pane-map">
    ${caption ? html`<span class="watch-pane-dim">${caption}</span>` : null}
    <dl class="watch-pane-rows is-mono">
      ${entries.map(
        ([name, expression]) => html`<div key=${name}>
          <dt><code>${name}</code></dt>
          <dd><code>${String(expression)}</code></dd>
        </div>`,
      )}
    </dl>
  </div>`;
}

/** The typed shape an answer must come back in. */
function SchemaTable({ schema }) {
  const entries = isPlainObject(schema) ? Object.entries(schema) : [];
  if (entries.length === 0) {
    return html`<p class="watch-pane-note">
      The answer carries no fields of its own — the decision is the whole of it.
    </p>`;
  }
  return html`<${ExpressionMap} map=${schema} caption="Answers in" />`;
}

function Code({ text }) {
  if (typeof text !== "string" || text.length === 0) return null;
  return html`<pre class="watch-pane-code">${text}</pre>`;
}

function code(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return html`<code>${value}</code>`;
}

/**
 * The node exactly as it is stored. Closed by default — the structured reading
 * above is the point of the pane — and open when what you need is the text to
 * paste somewhere else.
 */
export function WatchRawJson({ value }) {
  return html`<details class="watch-dag-raw">
    <summary>Raw JSON</summary>
    <pre>${JSON.stringify(value, null, 2)}</pre>
  </details>`;
}
