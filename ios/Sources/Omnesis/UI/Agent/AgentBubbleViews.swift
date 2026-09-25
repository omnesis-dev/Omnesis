// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

/// Render a user message, styling any URLs it contains as tinted,
/// underlined, tappable links while the surrounding prose inherits the
/// bubble's foreground style. URLs are found with `NSDataDetector` (the
/// same detector the system uses), so bare `https://…` and `www.…` forms
/// both light up. Non-link text carries no explicit colour, so it falls
/// back to the `Text`'s `foregroundStyle`.
@available(iOS 17.0, *)
func userMessageWithLinks(_ text: String) -> AttributedString {
    let mutable = NSMutableAttributedString(string: text)
    let full = NSRange(location: 0, length: (text as NSString).length)
    if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
        for match in detector.matches(in: text, range: full) {
            guard let url = match.url else { continue }
            mutable.addAttribute(.link, value: url, range: match.range)
            mutable.addAttribute(.foregroundColor, value: UIColor(Theme.accent), range: match.range)
            mutable.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: match.range)
        }
    }
    return AttributedString(mutable)
}

/// One conversation turn — user input bubble or assistant aggregated
/// reply. Mirrors `MessageBubble` in the portal so the structure of a
/// "turn" reads the same regardless of surface.
@available(iOS 17.0, *)
struct AgentTurnBubble: View {
    let turn: AgentTurn

    var body: some View {
        switch turn {
        case .user(_, let text):
            // Borderless soft bubble — matches the portal's rebalanced
            // user message. The accent-tinted fill is enough to read as
            // "this was you"; an additional stroke made the bubble
            // visually louder than the assistant's answer.
            HStack {
                Spacer(minLength: 32)
                Text(userMessageWithLinks(text))
                    .font(.system(size: 15))
                    .tint(Theme.accent)
                    .foregroundStyle(Theme.textPrimary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Theme.accent.opacity(0.10))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .textSelection(.enabled)
            }
        case .assistant(let assistant):
            VStack(alignment: .leading, spacing: 10) {
                let pillRuns = computeCitationPillRuns(parts: assistant.parts)
                ForEach(Array(assistant.parts.enumerated()), id: \.offset) { idx, part in
                    // A thinking part is "live" only while it is the trailing
                    // part of an in-flight turn (no stopReason yet). The moment
                    // anything follows it — or the turn ends — it stops being
                    // live and fades itself out.
                    AgentPartView(
                        part: part,
                        pillRun: pillRuns[idx],
                        thinkingActive: assistant.stopReason == nil && idx == assistant.parts.count - 1,
                        turnDone: assistant.stopReason != nil
                    )
                }
                if let failure = assistant.failure {
                    // Two registers, deliberately: the sentence says what went
                    // wrong in the reader's language, the line beneath carries
                    // the code and the provider's own disposition for whoever
                    // has to go and fix the model assignment.
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(Theme.danger)
                            Text(failure.message)
                                .font(.system(size: 12))
                                .foregroundStyle(Theme.danger)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        if let detail = failure.detailLine {
                            Text(detail)
                                .font(Theme.monospace(size: 10))
                                .foregroundStyle(Theme.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(Theme.danger.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                }
                if let stopped = assistant.stopped {
                    // A stop is not an error: no icon, no tinted chip — one
                    // quiet italic line, the register the portal uses for
                    // the same note.
                    Text(stopped)
                        .font(.system(size: 12))
                        .italic()
                        .foregroundStyle(Theme.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// Result of `computeCitationPillRuns` for one part slot.
/// `lead == true` on the first pending annotate of a contiguous run;
/// `count` is the number of pending annotates in that run.
@available(iOS 17.0, *)
struct AgentCitationPillRun: Equatable {
    let lead: Bool
    let count: Int
}

/// Walk `parts[]` and return a map from part index → `AgentCitationPillRun`
/// for every pending-annotate slot. Mirrors the portal's
/// `computeCitationPillRuns`: a contiguous run of pending annotate
/// tool parts collapses into ONE pill rendered at the run's lead slot
/// with `count == run length`. The natural alternative (one pill per
/// part) reads as a stack of identical animations when the agent
/// fires off five annotates in a row.
@available(iOS 17.0, *)
func computeCitationPillRuns(parts: [AgentPart]) -> [Int: AgentCitationPillRun] {
    func isPendingAnnotate(_ part: AgentPart) -> Bool {
        if case .tool(let call) = part, call.tool == "annotate", call.result == nil {
            return true
        }
        return false
    }
    var out: [Int: AgentCitationPillRun] = [:]
    var i = 0
    while i < parts.count {
        if !isPendingAnnotate(parts[i]) {
            i += 1
            continue
        }
        var j = i
        while j < parts.count, isPendingAnnotate(parts[j]) {
            j += 1
        }
        let runLength = j - i
        out[i] = AgentCitationPillRun(lead: true, count: runLength)
        for k in (i + 1) ..< j {
            out[k] = AgentCitationPillRun(lead: false, count: runLength)
        }
        i = j
    }
    return out
}

/// Inline "Citing N document(s)" pill rendered at the lead slot of a
/// run of pending annotate calls. A pulsing accent dot + muted label,
/// sized to read as a soft interjection in the middle of the agent's
/// prose rather than as another action card. Count grows as more
/// annotate calls land in the same run; pill disappears the moment
/// the last annotate resolves and the part collapses to EmptyView.
@available(iOS 17.0, *)
struct AgentCitingPill: View {
    var count: Int = 1
    @State private var pulse: Bool = false

    private var label: String {
        let n = max(1, count)
        return "Citing \(n) document\(n == 1 ? "" : "s")"
    }

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(Theme.accent)
                .frame(width: 5, height: 5)
                .opacity(pulse ? 1.0 : 0.35)
                .animation(
                    .easeInOut(duration: 0.7).repeatForever(autoreverses: true),
                    value: pulse
                )
            Text(label)
                .font(.system(size: 11))
                .foregroundStyle(Theme.textMuted)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Theme.accent.opacity(0.07))
        .clipShape(Capsule())
        .onAppear { pulse = true }
        .accessibilityLabel(label)
    }
}

// MARK: - Thinking indicator

/// The thinking indicator reuses the ephemeral cards' cadence: once the
/// agent moves on from reasoning, hold a beat (so a quick thought doesn't
/// flash), fade out, then collapse to nothing. Mirrors `agentEphemeralHoldNs`
/// / `agentEphemeralFadeSeconds` in AgentEphemeralCards, and ThinkingBlock on
/// the portal + AgentThinkingBlock on Android.
private let agentThinkingHoldNs: UInt64 = 450_000_000
private let agentThinkingFadeSeconds: Double = 0.3
private let agentThinkingFadeNs = UInt64(agentThinkingFadeSeconds * 1_000_000_000)

/// Thinking indicator. Rendered for a `thinking` part only while it is the
/// live trailing part of an in-flight turn (`active`). The instant the agent
/// appends anything after it — another reasoning pass, a tool call, or the
/// answer text — or the turn ends, `active` flips false: the block holds a
/// beat, fades out, then collapses to `EmptyView`, leaving nothing in the
/// transcript.
///
/// Two invariants fall out of this: never more than one on screen (each
/// block is already fading by the time the next reasoning pass begins, since
/// consecutive thinking deltas coalesce and any two thinking parts are
/// separated by a tool/text part), and resumed history shows none at all
/// (the coordinator drops thinking parts on rebuild, and a part that mounts
/// already-inactive starts in the `gone` phase — no flash).
@available(iOS 17.0, *)
struct AgentThinkingBlock: View {
    let text: String
    let active: Bool

    private enum Phase { case live, dismissing, gone }
    @State private var phase: Phase
    @State private var expanded = false

    init(text: String, active: Bool) {
        self.text = text
        self.active = active
        _phase = State(initialValue: active ? .live : .gone)
    }

    var body: some View {
        Group {
            if phase != .gone {
                VStack(alignment: .leading, spacing: 4) {
                    Button {
                        withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(Theme.textMuted)
                                .rotationEffect(.degrees(expanded ? 90 : 0))
                            AgentThinkingShimmerLabel(text: "Thinking")
                            AgentThinkingDots()
                        }
                    }
                    .buttonStyle(.plain)
                    if expanded {
                        Text(text)
                            .font(.system(size: 12))
                            .foregroundStyle(Theme.textSecondary)
                            .padding(.leading, 2)
                            .transition(.opacity)
                    }
                }
                .opacity(phase == .dismissing ? 0 : 1)
                .offset(y: phase == .dismissing ? -4 : 0)
            }
        }
        .task(id: active) { await runLifecycle(active: active) }
    }

    private func runLifecycle(active: Bool) async {
        if active {
            // (Re)activated — cancel any pending dismissal and show.
            if phase != .live { withAnimation { phase = .live } }
            return
        }
        // active == false. Only a currently-live block runs the dismiss
        // lifecycle; one that was never live (resumed history) is already
        // `gone` and stays that way.
        guard phase == .live else { return }
        try? await Task.sleep(nanoseconds: agentThinkingHoldNs)
        if Task.isCancelled { return }
        withAnimation(.easeOut(duration: agentThinkingFadeSeconds)) { phase = .dismissing }
        try? await Task.sleep(nanoseconds: agentThinkingFadeNs)
        if Task.isCancelled { return }
        phase = .gone
    }
}

/// Three accent dots that bounce in a staggered wave — the "the agent is
/// reasoning" indicator next to the word. Mirrors the portal's
/// `.agent-thinking-dots` and Android's `ThinkingDots`.
@available(iOS 17.0, *)
private struct AgentThinkingDots: View {
    @State private var animating = false
    var body: some View {
        HStack(spacing: 2) {
            ForEach(0 ..< 3, id: \.self) { i in
                Circle()
                    .fill(Theme.accent)
                    .frame(width: 3, height: 3)
                    .opacity(animating ? 1.0 : 0.25)
                    .offset(y: animating ? -2 : 0)
                    .animation(
                        .easeInOut(duration: 0.65)
                            .repeatForever(autoreverses: true)
                            .delay(Double(i) * 0.18),
                        value: animating
                    )
            }
        }
        .padding(.bottom, 1)
        .onAppear { animating = true }
    }
}

/// "Thinking" with an accent highlight that sweeps across the glyphs while
/// the agent reasons. A moving gradient band masked to the text. Mirrors the
/// portal's `.agent-thinking-label` shimmer.
@available(iOS 17.0, *)
private struct AgentThinkingShimmerLabel: View {
    let text: String
    @State private var phase: CGFloat = 0

    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Theme.textMuted)
            .overlay(
                GeometryReader { geo in
                    let w = geo.size.width
                    LinearGradient(
                        colors: [.clear, Theme.accent, .clear],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                    .frame(width: w * 0.7)
                    .offset(x: -w * 0.7 + phase * (w * 1.7))
                }
                .mask(Text(text).font(.system(size: 12, weight: .medium)))
                .allowsHitTesting(false)
            )
            .onAppear {
                withAnimation(.linear(duration: 2.1).repeatForever(autoreverses: false)) {
                    phase = 1
                }
            }
    }
}

// MARK: - Turn-level working indicator

/// Default quiet window the transcript must hold before the working dots
/// reveal. Above the streaming-token cadence (each token bump restarts the
/// timer, so the dots never flash mid-stream) but short enough that the brief
/// gaps a real turn leaves — a finished text block before the next tool call, a
/// completed card before the next step — clear it and read as "still working"
/// rather than frozen. A longer window silently swallowed those short gaps, so
/// the dots effectively never appeared.
let agentWorkingRevealDelayNs: UInt64 = 350_000_000

/// A small row of bouncing dots pinned below the in-flight assistant turn — the
/// transcript's answer to "is anything still happening?" during the beats where
/// no sub-item carries its own affordance: after a text block finishes but
/// before the next tool call opens, between `message.start` and the first
/// delta, or while an ephemeral card has faded but its successor hasn't landed.
///
/// `active` (recomputed by the parent each render) is true only while the turn
/// is in flight AND the trailing content is static — a live thinking shimmer, a
/// pending tool spinner, or a running sub-agent already signals activity, so
/// the dots stay out of their way. `version` bumps on every transcript
/// mutation; the reveal is debounced against it, so during actively streaming
/// text (constant bumps) the dots never appear, and they surface only once the
/// stream goes quiet with the turn still open. This is the ONE indicator that
/// does not depend on a specific part existing — it closes the gaps the
/// per-item cards structurally cannot.
@available(iOS 17.0, *)
struct AgentWorkingIndicator: View {
    let active: Bool
    let version: Int

    @State private var revealed: Bool
    @State private var animating: Bool

    /// `initiallyRevealed` seeds the reveal state so a synchronous snapshot
    /// render (which captures before the debounce `.task` fires) can show the
    /// dots; production call sites leave it `false` and let `settle()` decide.
    init(active: Bool, version: Int, initiallyRevealed: Bool = false) {
        self.active = active
        self.version = version
        _revealed = State(initialValue: initiallyRevealed)
        _animating = State(initialValue: initiallyRevealed)
    }

    /// Restarts the debounce whenever activity state or transcript content
    /// changes. Bundling both into the `.task` id means a streaming turn
    /// re-arms the timer on every token.
    private struct SettleKey: Equatable {
        let active: Bool
        let version: Int
    }

    var body: some View {
        // A ZStack (a real layout container) — NOT a `Group` — hosts the
        // debounce task. The task is what flips `revealed` to true, so it MUST
        // run while the dots are still hidden. A `Group` distributes its
        // modifiers to its child views, and the only child here is the
        // `if revealed { … }` block: while `revealed` is false there are zero
        // children, so a `.task` on the Group attaches to nothing and never
        // fires — a deadlock where the reveal task only exists once revealed.
        // Pinning the task to an always-present zero-size anchor inside a real
        // container guarantees it is scheduled regardless of `revealed`.
        ZStack(alignment: .leading) {
            Color.clear
                .frame(width: 0, height: 0)
                .task(id: SettleKey(active: active, version: version)) { await settle() }
            if revealed {
                HStack(spacing: 4) {
                    ForEach(0 ..< 3, id: \.self) { i in
                        Circle()
                            .fill(Theme.accent)
                            .frame(width: 5, height: 5)
                            .opacity(animating ? 1.0 : 0.3)
                            .offset(y: animating ? -2 : 0)
                            .animation(
                                .easeInOut(duration: 0.6)
                                    .repeatForever(autoreverses: true)
                                    .delay(Double(i) * 0.18),
                                value: animating
                            )
                    }
                }
                .padding(.vertical, 2)
                .transition(.opacity)
                // Reset on removal so the next reveal re-fires the bounce: the
                // `.animation(value: animating)` transition only re-triggers on
                // a false→true edge, so without this reset a second reveal in
                // the same indicator's lifetime would render frozen at the
                // peak pose instead of bouncing.
                .onAppear { animating = true }
                .onDisappear { animating = false }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Working")
            }
        }
    }

    private func settle() async {
        // A finished / self-animating tail hides the dots outright.
        if !active {
            withAnimation(.easeOut(duration: 0.2)) { revealed = false }
            return
        }
        // Fresh activity (or first mount): hide and re-arm the quiet timer. A
        // streaming turn restarts this task on every token, so the dots never
        // reveal mid-stream; a real gap leaves the timer to run out.
        if revealed { revealed = false }
        try? await Task.sleep(nanoseconds: agentWorkingRevealDelayNs)
        if Task.isCancelled { return }
        withAnimation(.easeIn(duration: 0.2)) { revealed = true }
    }
}

/// Font used to render assistant prose. Inter is bundled as a single
/// variable TTF (`Resources/Fonts/InterVariable.ttf`) and registered in
/// each target's `Info.plist` under `UIAppFonts`. The PostScript name
/// for the variable file is `InterVariable`; older iOS versions and
/// edge cases sometimes resolve only the family name, hence the small
/// fallback chain. `UIFont.fontNames(forFamilyName:)` confirms which
/// name actually resolved; if `Font.custom` can't find any of them
/// SwiftUI falls back to the system font automatically.
@available(iOS 17.0, *)
private func assistantBodyFont(size: CGFloat) -> Font {
    let candidates = ["InterVariable", "Inter Variable", "Inter"]
    for name in candidates {
        if !UIFont.fontNames(forFamilyName: name).isEmpty || UIFont(name: name, size: size) != nil {
            return .custom(name, size: size)
        }
    }
    return .system(size: size)
}

@available(iOS 17.0, *)
struct AgentPartView: View {
    let part: AgentPart
    /// Citation-pill coalescing context for this slot, computed by the
    /// bubble. `nil` for every non-annotate slot and for tail slots of
    /// a multi-call run (those render nothing for the pill); `lead`
    /// slots carry the count to display.
    var pillRun: AgentCitationPillRun?
    /// True when this slot is a `thinking` part that is the live trailing
    /// part of an in-flight turn. Drives the thinking indicator's
    /// self-dismissing lifecycle; ignored for every other part kind.
    var thinkingActive: Bool = false
    /// Freezes ephemeral tool cards for static previews and historical/debug
    /// renders so they do not roll in or dismiss themselves.
    var freeze: Bool = false
    /// True once the parent assistant turn has ended (`stopReason != nil`).
    /// Keys off the same done-signal the thinking block uses; inline researcher
    /// progress rows fold away when the turn completes.
    var turnDone: Bool = false

    var body: some View {
        switch part {
        case .text(let raw):
            // Assistant prose renders in Inter (bundled via Resources/
            // Fonts and registered in Info.plist's `UIAppFonts`) — a
            // humanist sans that contrasts with the system SF Pro used
            // for the user's own message bubble. The fixed-axis fallback
            // chain is for older devices where the variable font name
            // resolves differently.
            MarkdownView(text: raw, bodyFont: assistantBodyFont(size: 15))
        case .thinking(let raw):
            AgentThinkingBlock(text: raw, active: thinkingActive)
        case .tool(let call):
            // Panel-only / silent tools never surface in the conversation
            // flow. `annotate` feeds the citations card; `plan` feeds the
            // pinned TODO panel above the composer. The read-only
            // trigger tools (`triggers_list`, `trigger_get`,
            // `trigger_firings`) are background data fetches the agent
            // uses while answering — not user-visible actions, so they
            // join the silent list too. The coordinator already drops
            // these parts upstream — the render-time guard is a safety
            // net for replayed history or future tools that skip the
            // upstream filter.
            //
            // `annotate` is special: while the model is streaming the
            // annotate tool_use args (verbatim quote, up to 1024 chars)
            // no text deltas can arrive, so the transcript visibly
            // pauses for ~0.5–2s per call. Render a small "citing…"
            // pill at the annotate part's slot so the pause reads as
            // intentional ("agent is annotating its answer") instead of
            // as a hang. The pill disappears the moment the annotate
            // resolves; the citation itself surfaces in the drawer +
            // count chip.
            if call.tool == "annotate" {
                if call.result == nil, let run = pillRun, run.lead {
                    AgentCitingPill(count: run.count)
                }
            } else if call.tool == "annotate_many" {
                // `annotate_many` is silent like `annotate` — the Citations
                // drawer + Timeline own the visible payload. While the batch
                // is pending, show one pill sized to the batch; once the
                // result lands, nothing inline (citations persist in the
                // drawer). Mirrors the portal's annotate_many CitingPill.
                if call.result == nil {
                    AgentCitingPill(count: agentAnnotateManyPillCount(call))
                }
            } else if call.tool == "cite_record"
                || call.tool == "plan"
                || call.tool == "watches_list"
                || call.tool == "watch_get"
                || call.tool == "triggers_list"
                || call.tool == "trigger_get"
                || call.tool == "trigger_firings" {
                // `cite_record` is silent inline like the panel-only
                // tools — the directly-cited row surfaces in the Citations
                // drawer's Timeline and bumps the bubble's citation chip,
                // never as an inline card. Reading a watch is silent for the
                // same reason: it is the agent looking something up while it
                // answers, not an action the user took. The retired automation
                // reads stay listed so a stored transcript renders unchanged.
                EmptyView()
            } else if agentAutomationCardHandles(call.tool) {
                // Automation writes surface a lightning card so the
                // user immediately sees the change.
                AgentWatchCard(call: call)
            } else if agentEphemeralCardHandles(call) {
                // Search / Open Document / Run SQL / Find people render
                // as ephemeral glance cards that stream their content in
                // and then dismiss themselves — not as persistent
                // expandable logs. The fallback `AgentToolCallView`
                // chrome is reserved for tools where the result is a
                // steady piece of information the user may want to keep
                // around or a failure mode (tool error) the user needs
                // to inspect.
                switch call.tool {
                case "search_documents":
                    AgentEphemeralSearchCard(call: call, freeze: freeze)
                case "fetch_document":
                    AgentEphemeralDocumentCard(call: call, freeze: freeze)
                case "search_many", "fetch_many":
                    // A batch retrieval tool: project one live per-child
                    // ephemeral card, reusing the singular search / document
                    // card the child wraps. Live-only, like the singular
                    // ephemeral cards (dropped from resumed history).
                    AgentBatchToolCards(call: call, freeze: freeze)
                case "run_sql":
                    AgentEphemeralSqlCard(call: call, freeze: freeze)
                case "trace_connections":
                    AgentEphemeralTrailCard(call: call, freeze: freeze)
                case "lookup_people":
                    AgentEphemeralPeopleCard(call: call, freeze: freeze)
                case "lookup_document_by_url":
                    AgentEphemeralUrlLookupCard(call: call, freeze: freeze)
                case "search_loops":
                    AgentEphemeralLoopSearchCard(call: call, freeze: freeze)
                case "fetch_loop":
                    AgentEphemeralLoopFetchCard(call: call, freeze: freeze)
                default:
                    // Every remaining member of the ephemeral set — the
                    // background and memory actions, and any future
                    // enrolment without a bespoke card — gets the generic
                    // action card. Never AgentToolCallView here: it would
                    // strand the causality gate (no flushEphemeralTail).
                    AgentEphemeralActionCard(call: call, freeze: freeze)
                }
            } else {
                AgentToolCallView(call: call)
            }
        case .subagent(let card):
            // A sub-agent the parent spawned — a compact live row with
            // the researcher's title, status, usage, and reached sources.
            //
            // The card is a live in-flight marker. Once the parent turn ends,
            // fold it away; Timeline annotations retain the evidence. On
            // reload the card is already absent because AgentTurnBuilder does
            // not rebuild `.subagent` parts.
            if !turnDone {
                AgentSubAgentCard(card: card)
            }
        case .unknown(let label, let kind):
            // Forward-compat: an assistant- or user-side part kind the
            // gateway introduced after this build shipped. Demo builds
            // surface it as a one-line muted notice so walkthrough
            // screenshots stay honest; production hides it so an older
            // client never shows seams.
            if AppBuild.isDemo {
                AgentUnknownPartNotice(label: label, kind: kind)
            }
        }
    }
}

// MARK: - Batch retrieval cards

/// Projects a batch retrieval tool part (`search_many` / `fetch_many`) into N
/// per-child ephemeral cards, one per fanned-out child, reusing the singular
/// search / document card the child wraps. The pseudo-children come from
/// `agentBatchChildCalls(for:)`, which derives them from the best available
/// data (streamed children → settled `*.batch` result → pending `args`) so the
/// cards render on EVERY backend, not just the one that streams live child
/// progress. Each carries the SINGULAR tool name and is keyed `toolCallId#index`
/// so SwiftUI identity is stable across the pending→settled transition. Mirrors
/// the portal's projection in `parts.js`. Live-only overall: on reload the
/// batch parent is dropped from history (it is in `agentEphemeralTools`), so
/// this never renders after-the-fact.
@available(iOS 17.0, *)
struct AgentBatchToolCards: View {
    let call: AgentToolCall
    var freeze: Bool = false

    var body: some View {
        ForEach(agentBatchChildCalls(for: call)) { childCall in
            switch childCall.tool {
            case "fetch_document":
                AgentEphemeralDocumentCard(call: childCall, freeze: freeze)
            default:
                AgentEphemeralSearchCard(call: childCall, freeze: freeze)
            }
        }
    }
}

/// Pill count for a pending `annotate_many`: the length of its `annotations`
/// arg when known, else the count of child-progress rows, else one. Mirrors
/// the portal's annotate_many pill sizing.
@available(iOS 17.0, *)
func agentAnnotateManyPillCount(_ call: AgentToolCall) -> Int {
    if let dict = call.args.value as? [String: Any],
       let anns = dict["annotations"] as? [Any], !anns.isEmpty {
        return anns.count
    }
    if !call.children.isEmpty { return call.children.count }
    return 1
}

// MARK: - Tool call chip + result

/// Standard tool-call chrome used by the non-ephemeral tools — any tool
/// that surfaces a persistent piece of information the user might want to
/// consult after the answer arrives. Search / Open Document / Run SQL /
/// Trace connections bypass this entirely
/// (see `AgentEphemeral*Card`); error results land here too so the
/// failure detail stays readable.
@available(iOS 17.0, *)
struct AgentToolCallView: View {
    let call: AgentToolCall

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            header
            if let result = call.result {
                AgentToolResultView(result: result)
            } else {
                HStack(spacing: 6) {
                    ProgressView().scaleEffect(0.65).tint(Theme.accent)
                    Text(pendingLabel)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.textMuted)
                }
            }
        }
        .padding(10)
        .background(Theme.bgTertiary.opacity(0.5))
        .overlay(
            RoundedRectangle(cornerRadius: Theme.Radius.medium)
                .stroke(Theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
    }

    /// Phase label under the spinner. While args are still streaming
    /// (input_start has fired but tool.start hasn't) we say "Building
    /// query…"; once args are in but the tool is running we switch to
    /// "Running…".
    private var pendingLabel: String {
        call.argsKnown ? "Running…" : "Building query…"
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: toolSymbol(call.tool))
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Theme.accent)
            Text(prettyToolName(call.tool))
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.accent)
            if !call.argsSummary.isEmpty {
                Text(call.argsSummary)
                    .font(Theme.monospace(size: 11))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(2)
                    .truncationMode(.tail)
            }
            Spacer()
            if let ms = call.durationMs {
                Text("\(Int(ms))ms")
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.textMuted)
            }
        }
    }
}

private func prettyToolName(_ tool: String) -> String {
    switch tool {
    case "search_documents": "Search"
    case "fetch_document": "Open document"
    case "trace_connections": "Trace connections"
    case "run_sql": "Run SQL"
    case "search_loops": "Search loops"
    case "fetch_loop": "Open loop"
    case "list_loops": "List loops"
    case "entity_context": "Gather context"
    default: tool
    }
}

private func toolSymbol(_ tool: String) -> String {
    switch tool {
    case "search_documents": "magnifyingglass"
    case "fetch_document": "doc.text"
    case "trace_connections": "point.3.connected.trianglepath.dotted"
    case "run_sql": "tablecells"
    case "search_loops", "fetch_loop", "list_loops": "arrow.triangle.2.circlepath"
    case "entity_context": "point.3.connected.trianglepath.dotted"
    default: "wrench.and.screwdriver"
    }
}

// MARK: - Previews

#if DEBUG
@available(iOS 17.0, *)
#Preview("AgentTurnBubble — user") {
    ScrollView {
        AgentTurnBubble(turn: .user(id: "u-0", text: "How has my heart rate been compared to last month?"))
            .padding()
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentTurnBubble — user with link") {
    ScrollView {
        AgentTurnBubble(turn: .user(
            id: "u-1",
            text: "A colleague just shared this with me — what's in it? "
                + "https://drive.google.com/file/d/1q7Kp3vR9mB2nF8xLZ4wYcJ6tH0sD5aGe/view"
        ))
        .padding()
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentTurnBubble — assistant text + table") {
    ScrollView {
        AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnWithTable)
            .padding()
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentTurnBubble — assistant with tool call running") {
    ScrollView {
        AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnRunning)
            .padding()
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentTurnBubble — assistant provider failure") {
    ScrollView {
        AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnProviderFailure)
            .padding()
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentTurnBubble — assistant failure, code only") {
    ScrollView {
        AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnFailureCodeOnly)
            .padding()
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentTurnBubble — assistant provider failure (light)") {
    ScrollView {
        AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnProviderFailure)
            .padding()
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.light)
}

@available(iOS 17.0, *)
#Preview("AgentTurnBubble — assistant reopened stopped") {
    ScrollView {
        AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnReopenedStopped)
            .padding()
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentTurnBubble — assistant reopened stopped (light)") {
    ScrollView {
        AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnReopenedStopped)
            .padding()
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.light)
}

@available(iOS 17.0, *)
#Preview("AgentCitingPill — solo") {
    ScrollView {
        VStack(alignment: .leading, spacing: 8) {
            AgentCitingPill(count: 1)
            AgentCitingPill(count: 3)
            AgentCitingPill(count: 6)
        }
        .padding()
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentTurnBubble — assistant mid-citation") {
    ScrollView {
        AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnMidCite)
            .padding()
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentBatchToolCards — search_many (3 children)") {
    ScrollView {
        // `freeze` renders the per-child cards statically for the snapshot —
        // two resolved children show their result, one is still running.
        AgentPartView(part: .tool(PreviewMocks.agentToolCallSearchManyRunning), freeze: true)
            .padding()
    }
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentBatchToolCards — search_many settled (no children)") {
    ScrollView {
        // Non-streaming backend: empty `children`, a `.searchBatch` result with
        // three items → three settled per-child cards projected off the result.
        AgentPartView(part: .tool(PreviewMocks.agentToolCallSearchManySettled), freeze: true)
            .padding()
    }
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentBatchToolCards — search_many pending (no children)") {
    ScrollView {
        // Non-streaming backend, tool still running: empty `children`, no
        // result, three queries in `args` → three pending spinner cards.
        AgentPartView(part: .tool(PreviewMocks.agentToolCallSearchManyPending), freeze: true)
            .padding()
    }
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentPartView — annotate_many pill") {
    ScrollView {
        AgentPartView(part: .tool(PreviewMocks.agentToolCallAnnotateManyPending))
            .padding()
    }
    .background(Theme.bgPrimary)
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentWorkingIndicator — revealed") {
    ScrollView {
        // `initiallyRevealed` shows the dots without waiting out the debounce
        // (the reveal is otherwise driven by a `.task`).
        AgentWorkingIndicator(active: true, version: 0, initiallyRevealed: true)
            .padding()
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("AgentWorkingIndicator — below in-flight text") {
    ScrollView {
        VStack(alignment: .leading, spacing: 10) {
            AgentTurnBubble(turn: PreviewMocks.agentAssistantTurnInFlightText)
            AgentWorkingIndicator(active: true, version: 0, initiallyRevealed: true)
        }
        .padding()
    }
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}
#endif
#endif
