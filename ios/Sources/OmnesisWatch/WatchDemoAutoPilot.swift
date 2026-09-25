// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && os(watchOS)
import Foundation
import SwiftUI

/// Drives one scripted ask so a screen recorder can capture the whole wrist
/// flow unattended.
///
/// Siri cannot be invoked in a simulator, so the question that would normally
/// arrive from `AskOmnesisIntent` is injected here instead. Everything
/// downstream is the real thing: the same `WatchAskRouter.submit`, the same
/// relay, the same status line, the same spoken read-along.
///
/// The recorder handshake mirrors the iPhone's `DemoAutoPilot`. `simctl
/// recordVideo` needs a beat to start capturing frames, so the ask waits for
/// `/tmp/demo-recording-ready` before it fires and writes
/// `/tmp/demo-recording-done` once the answer has been read out — which
/// brackets the clip on exactly the interesting span. Both waits are bounded,
/// so a manual launch with no recorder attached still runs start to finish.
struct WatchDemoAutoPilot: ViewModifier {
    @State private var started = false

    /// The question to ask. Absent means this whole modifier is inert, which
    /// is the case for every launch that isn't a recording.
    private static let question = ProcessInfo.processInfo.environment["DEMO_WATCH_ASK"]?
        .trimmingCharacters(in: .whitespacesAndNewlines)

    /// How long to dwell on the idle hint before asking, so the clip opens on
    /// "Ask Omnesis" rather than mid-spinner. Tunable from the environment
    /// because pacing is judged by eye on the finished video, and a rebuild to
    /// change a hold would be a slow way to iterate.
    private static let leadIn = seconds("DEMO_WATCH_LEAD_IN", default: 1.8)

    /// How long to hold on the finished answer before cutting, so the last
    /// sentence is readable after the highlight completes.
    private static let tailHold = seconds("DEMO_WATCH_TAIL_HOLD", default: 2.0)

    private static let readyMarker = "/tmp/demo-recording-ready"
    private static let doneMarker = "/tmp/demo-recording-done"

    func body(content: Content) -> some View {
        content.task {
            if let state = WatchStateStaging.requested {
                // The marker is the capture's go-signal, and it is written only
                // for a state this build actually staged: an unrecognised name
                // leaves the screenshot lane to time out and say so, rather
                // than photographing whatever happened to be on screen.
                guard WatchStateStaging.stage(state) else { return }
                // The idle screens reveal their dictate button after a short
                // hint delay; outwait it so the capture shows the settled
                // screen.
                try? await Task.sleep(for: WatchStateStaging.settle)
                FileManager.default.createFile(atPath: WatchStateStaging.readyMarker, contents: nil)
                return
            }
            guard let question = Self.question, !question.isEmpty, !started else { return }
            started = true

            // A prior note flow could have left the presenter elsewhere; the
            // ask screen is the only one whose `.task` performs the relay.
            WatchPresenter.shared.screen = .ask

            await Self.waitForFile(Self.readyMarker, pollsOf: .milliseconds(100), upTo: 150)
            try? await Task.sleep(for: .seconds(Self.leadIn))

            WatchAskRouter.shared.submit(question: question)

            // The relay's own ceiling is 70s, so outwait it rather than
            // cutting the clip while the wrist is still spinning.
            await Self.poll(every: .milliseconds(200), upTo: 400) {
                if case .answered = WatchAskRouter.shared.state { return true }
                return false
            }

            // Speech starts a moment after the answer lands. Wait for it to
            // begin, then for it to finish, so the cut happens after the
            // read-along highlight has swept the whole answer. Both bounded:
            // a simulator with no audio route never speaks, and the clip must
            // still end.
            await Self.poll(every: .milliseconds(100), upTo: 30) { WatchSpeaker.shared.isSpeaking }
            await Self.poll(every: .milliseconds(200), upTo: 200) { !WatchSpeaker.shared.isSpeaking }

            try? await Task.sleep(for: .seconds(Self.tailHold))
            FileManager.default.createFile(atPath: Self.doneMarker, contents: nil)
        }
    }

    // MARK: - Helpers

    /// Suspend until `condition` holds or the poll budget runs out. Returns
    /// either way — every caller has a sensible next step for the timeout.
    /// Main-actor isolated because every condition reads observable state
    /// that lives there.
    @MainActor
    private static func poll(
        every interval: Duration,
        upTo attempts: Int,
        until condition: () -> Bool
    ) async {
        for _ in 0 ..< attempts {
            if condition() { return }
            try? await Task.sleep(for: interval)
        }
    }

    private static func waitForFile(_ path: String, pollsOf interval: Duration, upTo attempts: Int) async {
        for _ in 0 ..< attempts {
            if FileManager.default.fileExists(atPath: path) { return }
            try? await Task.sleep(for: interval)
        }
    }

    private static func seconds(_ key: String, default fallback: Double) -> Double {
        guard let raw = ProcessInfo.processInfo.environment[key],
              let value = Double(raw), value >= 0
        else {
            return fallback
        }
        return value
    }
}

extension View {
    /// Attach the watch demo auto-pilot (debug builds only, activated by the
    /// `DEMO_WATCH_ASK` or `DEMO_WATCH_STATE` env vars). Inert for every
    /// other launch.
    func watchDemoAutoPilot() -> some View {
        modifier(WatchDemoAutoPilot())
    }
}

/// Puts the ask screen into one named state and leaves it there, so a
/// screenshot can be taken of it.
///
/// The wrist has no equivalent of the iPhone's snapshot suite — watchOS
/// renders only in its own simulator — and reviewing this screen by eye is
/// the only way to hold its one-line rule: the status line must never wrap
/// or truncate, on the smallest watch as much as the largest. One launch
/// stages one state (`DEMO_WATCH_STATE=searching`) rather than a timed
/// sequence, and staging starts no relay, so what the screenshot catches
/// depends on neither when it fires nor whether a phone is in range.
///
/// `scripts/shot-watch-ask.sh` drives it.
enum WatchStateStaging {
    /// The question shown while a state is staged, and the long one that
    /// proves a question too tall for the screen can still be read. Invented,
    /// like every fixture: nothing from the operator's corpus reaches a
    /// screenshot.
    private static let question = "Did I book the ferry for the coast trip?"
    private static let noteText = "Pick up the bike on Saturday"
    private static let longQuestion =
        "What did the studio quote for the kitchen refit, including the appliances "
            + "and the delivery dates they promised for each of them?"

    /// Every state this harness knows how to stage. An unrecognised name is
    /// refused rather than quietly rendered as something else — a screenshot
    /// filed under the wrong name is worse than no screenshot.
    static let known = [
        "idle", "received", "thinking", "searching", "reading",
        "widest", "long-question", "answered", "working", "failed",
        "note-idle", "note-done",
    ]

    /// How long a staged state is given to settle before its capture.
    static let settle = Duration.seconds(1)

    /// Written once the state is on screen, so the capture waits for a fact
    /// rather than for a duration.
    static let readyMarker = "/tmp/omnesis-watch-state-ready"

    static var requested: String? {
        ProcessInfo.processInfo.environment["DEMO_WATCH_STATE"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    /// Stage `state`, or return false if this build does not know it.
    @MainActor
    static func stage(_ state: String) -> Bool {
        guard known.contains(state) else { return false }
        if state.hasPrefix("note-") {
            WatchPresenter.shared.screen = .note
            WatchNoteRouter.shared.reset()
            if state == "note-done" {
                WatchNoteRouter.shared.stage(text: noteText, outcome: .saved)
            }
            return true
        }
        WatchPresenter.shared.screen = .ask
        WatchAskRouter.shared.reset()
        switch state {
        case "idle":
            break
        case "answered":
            WatchAskRouter.shared.answered(
                outcome: .answered(
                    text: "Yes — the ferry is booked for Friday at 09:40, "
                        + "and the confirmation is in your inbox."
                )
            )
        case "working":
            WatchAskRouter.shared.answered(outcome: .stillWorking)
        case "failed":
            WatchAskRouter.shared.answered(outcome: .phoneUnreachable)
        case "long-question":
            WatchAskRouter.shared.stage(
                question: longQuestion,
                activity: SiriAskActivitySnapshot(label: "Reading…", detail: "3 read")
            )
        default:
            WatchAskRouter.shared.stage(question: question, activity: activity(for: state))
        }
        return true
    }

    /// The status snapshots worth looking at: the first thing the wrist
    /// learns, the two mid-turn shapes, and the widest line this build's own
    /// vocabulary can produce — its longest tool label carrying a three-digit
    /// count, which is what the one-line rule has to survive.
    private static func activity(for state: String) -> SiriAskActivitySnapshot {
        switch state {
        case "received": SiriAskActivitySnapshot(label: "Received")
        case "thinking": SiriAskActivitySnapshot(label: "Thinking…")
        case "reading": SiriAskActivitySnapshot(label: "Reading…", detail: "3 read")
        case "widest": SiriAskActivitySnapshot(label: "Checking reminders…", detail: "148 found")
        default: SiriAskActivitySnapshot(label: "Searching…", detail: "12 found")
        }
    }
}
#endif
