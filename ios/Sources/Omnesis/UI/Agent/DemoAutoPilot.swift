// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// References `AppStore` / `CitationsDrawer`, which are declared under
// `canImport(SwiftUI) && canImport(UIKit)` — so this view modifier must compile
// out on macOS too, keeping the SwiftPM `Omnesis` library buildable for the
// sim-less `swift test` logic lane (scripts/ios-logic.sh).
#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import Foundation
import SwiftUI

/// View modifier that drives the demo recording sequence entirely from
/// within the app. Activated by `DEMO_AUTO_SEND` in the environment.
///
/// Sequence: wait for transport bootstrap → new conversation → wait for the recorder
/// to be capturing (record-demos.sh) → hold 1s on the pre-filled prompt →
/// send → wait for response → pause 1s → open citations drawer (if timeline
/// content exists) → hold 4/3s → write done marker.
///
/// XCUITest becomes a thin launcher that polls for the done marker file.
@available(iOS 17.0, *)
struct DemoAutoPilot: ViewModifier {
    @Environment(AppStore.self) private var store
    @Binding var composerText: String
    @Binding var citationsOpen: Bool

    @State private var sent = false
    @State private var waitingForResponse = false
    @State private var postResponseTrigger = 0

    private static let enabled = ProcessInfo.processInfo.environment["DEMO_AUTO_SEND"] != nil
    /// The prompt to send, passed by the recording test so it skips slow
    /// keyboard interaction.
    private static let prompt = (ProcessInfo.processInfo.environment["DEMO_PROMPT"] ?? "")
        .trimmingCharacters(in: .whitespacesAndNewlines)

    func body(content: Content) -> some View {
        content
            .task {
                guard Self.enabled, !sent, !Self.prompt.isEmpty else { return }

                // Wait for the paired transport; blank conversations mint a session on send.
                for _ in 0 ..< 75 {
                    if store.agent.client != nil { break }
                    try? await Task.sleep(for: .milliseconds(200))
                }
                guard store.agent.client != nil else { return }

                // Await startup before choosing a conversation; a client can exist
                // while bootstrap is still preparing its default session.
                await store.agent.retry()
                guard store.agent.fatalError == nil else { return }

                // Fresh session so we don't resume a prior conversation
                // whose replay fixture is already exhausted. The session is
                // minted lazily by the send() below.
                store.agent.newConversation()
                citationsOpen = false
                // Shown in the composer for the viewer to read before it is sent.
                composerText = Self.prompt

                // When a screen recorder is driving us (record-demos.sh),
                // wait until it signals that simctl's recordVideo is actually
                // capturing frames before sending. recordVideo needs ~1-2s to
                // spin up; without this handshake the prompt + early response
                // play before the first frame is captured and the clip opens
                // mid-stream. A missing recorder leaves the scenario incomplete
                // so the capture fails. The recorder removes this marker
                // at the start of each scenario, so a stale one can't leak in.
                for _ in 0 ..< 900 {
                    if FileManager.default.fileExists(atPath: "/tmp/demo-recording-ready") { break }
                    try? await Task.sleep(for: .milliseconds(100))
                }

                guard FileManager.default.fileExists(atPath: "/tmp/demo-recording-ready") else { return }

                // Hold on the pre-filled prompt before sending. This runs
                // after the recorder-ready handshake above, so the whole dwell
                // is captured — it's what makes the clip open on the question
                // (the viewer reads it) rather than on the agent's reply.
                try? await Task.sleep(for: .seconds(1))

                sent = true
                waitingForResponse = true
                await store.agent.sendComposerDraft(Self.prompt)
            }
            .onChange(of: store.agent.busy) { _, isBusy in
                guard waitingForResponse, !isBusy else { return }
                waitingForResponse = false
                postResponseTrigger += 1
            }
            .task(id: postResponseTrigger) {
                guard postResponseTrigger > 0 else { return }

                // Pause so the viewer can read the response.
                try? await Task.sleep(for: .seconds(1))

                // Open the citations drawer if the response produced
                // any timeline content (annotations or cited records).
                let hasTimeline = !store.agent.trailAnnotations.byDoc.isEmpty
                    || !store.agent.recordCitations.isEmpty
                if hasTimeline {
                    withAnimation(CitationsDrawer.openCloseAnimation.speed(3)) {
                        citationsOpen = true
                    }
                    try? await Task.sleep(for: .seconds(4.0 / 3))
                }

                // Write marker file so the recording script stops.
                FileManager.default.createFile(
                    atPath: "/tmp/demo-recording-done",
                    contents: nil
                )
            }
    }
}

@available(iOS 17.0, *)
extension View {
    /// Attach the demo auto-pilot (debug builds only, activated by
    /// `DEMO_AUTO_SEND` env var). No-op in release builds.
    func demoAutoPilot(
        composerText: Binding<String>,
        citationsOpen: Binding<Bool>
    )
        -> some View {
        modifier(DemoAutoPilot(
            composerText: composerText,
            citationsOpen: citationsOpen
        ))
    }
}
#endif
