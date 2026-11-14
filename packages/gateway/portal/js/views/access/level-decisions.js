// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The decisions that make up an access level, one question per screen:
// permissions, the sources Answer uses, the sources Direct reads, what happens
// to new sources, and how answers are released. Every page that sets a level's
// permissions renders these components — creating a level, editing one, and
// approving a connection onto a new level — so each question has one wording,
// one layout and one filter dialog.

import { html } from "htm/preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { CapabilityPicker, PERMISSIONS_QUESTION } from "../../components/grant-builder.js";
import {
  NO_CAPABILITY_MESSAGE,
  blocksNewSources,
  capabilityName,
  copyRuleSources,
  setFutureSourcesAllowed,
  hasCapability,
  releaseError,
  defaultPolicyFamilyId,
  policyFamilyId,
  policyFamilyName,
  sourceId,
  sourceBoundaryBlocksSavedFilter,
  sourceBoundaryError,
} from "../../components/grant-builder-state.js";
import { copyRuleFilters } from "../../components/source-filter-state.js";
import { LevelDataDecision } from "./level-data-decision.js";
import { LevelDecisionSummary } from "./level-review.js";
import {
  dataDecisionCapability,
  directFollowsAnswer,
  directMirrorsAnswer,
  levelDecisionPath,
} from "./level-flow-state.js";

/** The one label for giving Direct exactly what Answer has, and the one for giving it its own. */
const SAME_AS_ANSWER_LABEL = "Use same sources and filters as Answer";
const OWN_SOURCES_LABEL = "Choose different sources";

const DIRECT_QUESTION = [
  "Which sources can Direct read?",
  "Direct allows the agent to read allowed original records directly without Answer’s privacy review.",
];

/** Each decision's question and, where it has one, the line under it. */
const LEVEL_DECISION_QUESTIONS = {
  permissions: [PERMISSIONS_QUESTION, ""],
  "answer-data": ["Which sources can Answer use?", ""],
  "direct-data": DIRECT_QUESTION,
  "direct-choice": DIRECT_QUESTION,
  future: ["What about new sources?", ""],
  release: ["How should answers be released?", ""],
};
function InfoTip({ id, label, children }) {
  const [dismissed, setDismissed] = useState(false);
  const root = useRef(null),
    hovered = useRef(false);
  useLayoutEffect(() => {
    const onEscape = (event) => {
      if (event.key !== "Escape" || !hovered.current) return;
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
      root.current?.querySelector("button")?.blur?.();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, []);
  return html`<span
    ref=${root}
    class="compact-info"
    data-dismissed=${dismissed}
    onMouseEnter=${() => {
      hovered.current = true;
      setDismissed(false);
    }}
    onMouseLeave=${() => {
      hovered.current = false;
    }}
    onFocusIn=${() => setDismissed(false)}
    ><button
      type="button"
      aria-label=${`About ${label}`}
      aria-describedby=${id}
      onKeyDown=${(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setDismissed(true);
          event.currentTarget.blur();
        }
      }}
    >
      <svg
        aria-hidden="true"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.3"
      >
        <circle cx="8" cy="8" r="6" />
        <path d="M8 7v4" />
        <circle cx="8" cy="4.7" r=".7" fill="currentColor" stroke="none" />
      </svg></button
    ><span id=${id} role="tooltip">${children}</span></span
  >`;
}
function AnswerRelease({ rule, policies, disabled, onChange }) {
  const selected = rule.release.mode === "reviewed" ? rule.release.policyFamilyId : "";
  return html`<fieldset class="grant-builder-release" disabled=${disabled}>
    <legend>Privacy for Answer</legend>
    <div class="grant-builder-release-choice grant-builder-release-reviewed">
      <div class="compact-release-title">
        <label for="level-release-reviewed"
          ><input
            id="level-release-reviewed"
            name="level-release"
            type="radio"
            checked=${rule.release.mode === "reviewed"}
            onChange=${() => onChange({ ...rule, release: { mode: "reviewed", policyFamilyId: selected || defaultPolicyFamilyId(policies) } })}
          /><strong>Review answers with a privacy policy</strong></label
        >
        <${InfoTip}
          id="level-release-reviewed-info"
          label="privacy review"
          children="The selected privacy policy reviews each answer before it is released."
        />
      </div>
      ${
        rule.release.mode === "reviewed"
          ? html`<select
              aria-label="Answer privacy policy"
              value=${selected}
              onChange=${(event) => onChange({ ...rule, release: { mode: "reviewed", policyFamilyId: event.currentTarget.value } })}
            >
              <option value="">Choose a policy</option>
              ${policies.map((policy) => html`<option value=${policyFamilyId(policy)}>${policyFamilyName(policy)}</option>`)}
            </select>`
          : null
      }
    </div>
    <div class="grant-builder-release-choice grant-builder-risk">
      <div class="compact-release-title">
        <label for="level-release-unreviewed"
          ><input
            id="level-release-unreviewed"
            name="level-release"
            type="radio"
            checked=${rule.release.mode === "unreviewed"}
            onChange=${() => onChange({ ...rule, release: { mode: "unreviewed" } })}
          /><strong>Release without privacy review</strong></label
        >
        <${InfoTip}
          id="level-release-unreviewed-info"
          label="automatic release"
          children="The agent can only see data from allowed records, but no privacy reviewer checks the answer."
        />
      </div>
    </div>
  </fieldset>`;
}
/** What stops one decision from being left as it stands; empty when nothing does. */
function levelDecisionError(step, rules, sources) {
  if (step === "permissions") return hasCapability(rules) ? "" : NO_CAPABILITY_MESSAGE;
  if (step === "release") return releaseError(rules) || "";
  const capability = dataDecisionCapability(step);
  return capability
    ? sourceBoundaryError(rules[capability], capabilityName(capability), sources) || ""
    : "";
}

/**
 * What a page showing one decision at a time keeps for the open step: whether
 * leaving it was attempted, and where focus goes — to the step's heading as
 * it opens, to its refusal when leaving is refused. `pass(rules, sources)`
 * marks the attempt and answers whether the step can be left; a step that is
 * not a decision always can.
 *
 * `focusOnMount: false` leaves focus alone for the step the page opens on, for
 * a page whose own heading takes it.
 */
export function useDecisionStep(step, { focusOnMount = true } = {}) {
  const [attempted, setAttempted] = useState(false);
  const headingRef = useRef(null),
    alertRef = useRef(null);
  const moved = useRef(focusOnMount);
  useEffect(() => {
    setAttempted(false);
    if (moved.current) headingRef.current?.focus?.();
    moved.current = true;
  }, [step]);
  return {
    attempted,
    headingRef,
    alertRef,
    pass(rules, sources) {
      setAttempted(true);
      if (!levelDecisionError(step, rules, sources)) return true;
      alertRef.current?.focus?.();
      return false;
    },
  };
}

/**
 * What a draft remembers across its decisions: the rules of a capability that
 * was switched off, and the Direct selection that a copy of Answer's replaced.
 * Both come back when the owner reverses the choice. The page that owns the
 * draft holds this, since each decision unmounts when the next one opens.
 */
export function useLevelDecisionMemory() {
  const capabilities = useRef({});
  const separateDirect = useRef(null);
  return { capabilities, separateDirect };
}

/**
 * The walk through a new level's decisions, in the order `levelDecisionPath`
 * gives for the rules as they stand.
 *
 * `change(target)` opens one decision from the final review. Continuing from
 * it returns to the review, by way of any decision the change newly requires:
 * one that was not on the path before, or new sources once a reading
 * permission was added.
 */
export function useNewLevelWalk({ step, onStep, rules, linkDirect }) {
  const correction = useRef(null);
  const path = levelDecisionPath(rules, !linkDirect);
  const current = path.includes(step) ? step : path[0];
  const position = path.indexOf(current);
  return {
    path,
    current,
    position,
    correcting: correction.current !== null,
    /** The step Back leads to, or null on the first decision. */
    previous: correction.current ? "review" : position > 0 ? path[position - 1] : null,
    change(target) {
      correction.current = { path: [...path], capabilities: Object.keys(rules), visited: new Set() };
      onStep(
        target === "direct-data" && directFollowsAnswer(rules, linkDirect)
          ? "direct-choice"
          : target,
      );
    },
    advance() {
      const returning = correction.current;
      if (!returning) {
        onStep(path[position + 1] ?? "review");
        return;
      }
      returning.visited.add(current);
      const addedReading = ["answer", "direct"].some(
        (key) => rules[key] && !returning.capabilities.includes(key),
      );
      const required = path.filter(
        (key) =>
          key !== "review" &&
          (!returning.path.includes(key) || (key === "future" && addedReading)) &&
          !returning.visited.has(key),
      );
      if (required.length) onStep(required[0]);
      else {
        correction.current = null;
        onStep("review");
      }
    },
    retreat() {
      if (correction.current) {
        correction.current = null;
        onStep("review");
      } else if (position > 0) onStep(path[position - 1]);
    },
    /** Forgets a change opened from the review, for a page that leaves the walk. */
    reset() {
      correction.current = null;
    },
  };
}

/**
 * One decision: its question, the reason it cannot be left yet, and its
 * controls. `step` is a decision of `levelDecisionPath`.
 *
 * `notice` replaces the decision's own validation message with the page's —
 * a save that failed, say. The validation message shows once `attempted`.
 */
export function LevelDecision({
  step,
  rules,
  onRules,
  sources,
  policies,
  sourceFiltersEnabled,
  accessLevel,
  isNew = false,
  linkDirect,
  onLinkDirect,
  disabled = false,
  isLocked,
  requiresAnswer = false,
  memory,
  attempted = false,
  notice = null,
  headingRef,
  alertRef,
}) {
  const [question, detail] = LEVEL_DECISION_QUESTIONS[step];
  const validation = levelDecisionError(step, rules, sources);
  const locked = () => disabled || isLocked?.() === true;
  const linked = directFollowsAnswer(rules, linkDirect);
  // Whether Direct follows Answer is one choice wherever it is asked: its own
  // step on a new level, and the top of Direct data on a saved level, where
  // Direct's own accounts follow it on the same screen.
  const directChoice =
    step === "direct-choice" || (step === "direct-data" && !isNew && Boolean(rules.answer));
  const dataCapability =
    step === "direct-data" && directChoice && linked ? null : dataDecisionCapability(step);
  // Direct linked to Answer follows every change to Answer's sources and filters.
  const update = (capability, next) => {
    if (locked()) return;
    const value = { ...rules, [capability]: next };
    if (capability === "answer" && linked)
      value.direct = copyRuleFilters(copyRuleSources(value.direct, next), next, accessLevel);
    onRules(value);
  };
  const copyBlocked =
    !sourceFiltersEnabled &&
    [rules.answer, rules.direct].some((rule) => rule?.scopePolicies?.length);
  const reuse = () => {
    if (locked() || copyBlocked) return;
    if (!linkDirect) memory.separateDirect.current = rules.direct;
    onRules({
      ...rules,
      direct: copyRuleFilters(
        copyRuleSources(rules.direct, rules.answer),
        rules.answer,
        accessLevel,
      ),
    });
    onLinkDirect(true);
  };
  const separate = () => {
    if (locked()) return;
    if (memory.separateDirect.current) onRules({ ...rules, direct: memory.separateDirect.current });
    memory.separateDirect.current = null;
    onLinkDirect(false);
  };
  return html`<header class="guided-question">
      <h3 ref=${headingRef} tabindex="-1">${question}</h3>
      ${detail ? html`<p>${detail}</p>` : null}
    </header>
    ${notice ?? (attempted && validation ? html`<p class="access-field-error" role="alert" tabindex="-1" ref=${alertRef}>${validation}</p>` : null)}
    <div class="guided-decision-body">
      ${
        step === "permissions"
          ? html`<${CapabilityPicker}
              value=${rules}
              onChange=${(value) => {
                if (locked()) return;
                // Answer added beside Direct's own selection must not take it over.
                if (value.answer && !rules.answer && rules.direct) {
                  onLinkDirect(false);
                } else if (value.answer && value.direct && !rules.direct) {
                  // Direct added beside Answer is linked exactly when it starts as Answer's copy.
                  onLinkDirect(directMirrorsAnswer(value));
                }
                onRules(value);
              }}
              memory=${memory.capabilities}
              requiresAnswer=${requiresAnswer}
              policies=${policies}
              disabled=${disabled}
              linkDirect=${linkDirect}
              accessLevel=${accessLevel}
              sourceFiltersEnabled=${sourceFiltersEnabled}
            />`
          : null
      }
      ${
        directChoice
          ? html`<div class="guided-choices">
              <label class=${`guided-choice${linked ? " is-selected" : ""}`}
                ><input
                  type="radio"
                  name="direct-data-choice"
                  checked=${linked}
                  disabled=${disabled || copyBlocked}
                  onChange=${reuse}
                /><span><strong>${SAME_AS_ANSWER_LABEL}</strong></span></label
              ><label class=${`guided-choice${!linked ? " is-selected" : ""}`}
                ><input
                  type="radio"
                  name="direct-data-choice"
                  checked=${!linked}
                  disabled=${disabled}
                  onChange=${separate}
                /><span><strong>${OWN_SOURCES_LABEL}</strong></span></label
              >${linked ? html`<div class="guided-reuse-summary"><${LevelDecisionSummary} decision="answer-data" rules=${rules} sources=${sources} policies=${policies} /></div>` : null}
            </div>`
          : null
      }
      ${dataCapability ? html`<${LevelDataDecision} capability=${dataCapability} rule=${rules[dataCapability]} onChange=${(value) => update(dataCapability, value)} sources=${sources} enabled=${sourceFiltersEnabled} disabled=${disabled} accessLevel=${accessLevel} />` : null}
      ${
        step === "future"
          ? html`<div class="guided-future-choices">
              ${["answer", "direct"].map((capability) =>
                rules[capability] && !(capability === "direct" && linked)
                  ? html`<fieldset disabled=${disabled}>
                      <legend>
                        ${linked ? "Answer and Direct" : capabilityName(capability)}
                      </legend>
                      ${[
                        [
                          false,
                          "Keep new sources blocked",
                          "I will allow each new source when I am ready.",
                        ],
                        [
                          true,
                          "Allow new sources automatically",
                          "New sources will be included without another approval.",
                        ],
                      ].map(
                        ([allowed, label, detail]) =>
                          html`<div class="guided-choice-row">
                            <label
                              class=${`guided-choice${blocksNewSources(rules[capability]) !== allowed ? " is-selected" : ""}`}
                              ><input
                                type="radio"
                                name=${`future-${capability}`}
                                disabled=${sourceBoundaryBlocksSavedFilter(setFutureSourcesAllowed(rules[capability], allowed, sources.map(sourceId)), sourceFiltersEnabled)}
                                checked=${blocksNewSources(rules[capability]) !== allowed}
                                onChange=${() => update(capability, setFutureSourcesAllowed(rules[capability], allowed, sources.map(sourceId)))}
                              /><span><strong>${label}</strong></span></label
                            ><${InfoTip}
                              id=${`future-${capability}-${allowed}-info`}
                              label=${label}
                              children=${detail}
                            />
                          </div>`,
                      )}
                    </fieldset>`
                  : null,
              )}
            </div>`
          : null
      }
      ${step === "release" ? html`<${AnswerRelease} rule=${rules.answer} policies=${policies} disabled=${disabled} onChange=${(value) => update("answer", value)} />` : null}
    </div>`;
}
