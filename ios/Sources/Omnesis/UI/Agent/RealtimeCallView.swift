// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
import SwiftUI

/// A dedicated voice surface; audio stays scoped to its foreground presentation.
@available(iOS 17.0, *)
struct RealtimeCallView: View {
    let pairing: Pairing?
    var freezeToolActivity = false
    var conversationID: String?
    @State var session = RealtimeCallSession()
    @State var citationsOpen = false
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Omnesis").font(.title2.weight(.semibold))
                    Text("Voice conversation · Experimental")
                        .font(.caption).foregroundStyle(Theme.textSecondary)
                }
                Spacer()
                Button {
                    withAnimation(CitationsDrawer.openCloseAnimation) { citationsOpen.toggle() }
                } label: {
                    Image(systemName: "quote.bubble").foregroundStyle(Theme.accent)
                        .frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("Open citations")
            }
            GeometryReader { viewport in
                RealtimeTranscriptScrollView(revision: conversationCaption) {
                    voiceHeader(size: min(164, max(64, (viewport.size.height - 140) * 0.55)))
                } content: {
                    VStack(spacing: 24) {
                        if let error = session.error {
                            GatewayErrorView(context: "start the voice conversation", error: error, onRetry: {
                                session.error = nil
                                Task { await startCall() }
                            })
                            .frame(minHeight: GatewayErrorView.minScrollHeight)
                        } else {
                            if session.connected, let failure = activityTurn?.failure { AgentTurnFailureView(failure: failure) }
                            Text(conversationCaption)
                                .font(.body)
                                .foregroundStyle(session.transcript.isEmpty ? Theme.textSecondary : Theme.textPrimary)
                                .multilineTextAlignment(session.transcript.isEmpty ? .center : .leading)
                                .lineSpacing(5)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        toolActivity
                    }
                }
            }
            HStack(spacing: 44) {
                Button { session.toggleMute() } label: {
                    Image(systemName: session.muted ? "mic.slash.fill" : "mic.fill")
                        .font(.title2)
                        .frame(width: 64, height: 64)
                        .background(Theme.bgTertiary, in: Circle())
                }
                .disabled(!session.connected)
                .accessibilityLabel(session.muted ? "Unmute microphone" : "Mute microphone")
                Button {
                    Task {
                        await session.end()
                        dismiss()
                    }
                } label: {
                    Image(systemName: "phone.down.fill")
                        .font(.title2)
                        .foregroundStyle(.white)
                        .frame(width: 64, height: 64)
                        .background(Theme.danger, in: Circle())
                }
                .disabled(session.ending)
                .accessibilityLabel("End voice conversation")
            }
            Text("Audio is sent through your gateway to OpenAI.")
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .background(Theme.bgPrimary)
        .foregroundStyle(Theme.textPrimary)
        .overlay {
            CitationsDrawer(
                trailAnnotations: store.agent.trailAnnotations,
                recordCitations: store.agent.recordCitations,
                isOpen: $citationsOpen
            )
        }
        .task { await startCall() }
        .onDisappear { session.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { session.stop()
                dismiss()
            }
        }
    }

    private func voiceHeader(size: CGFloat) -> some View {
        VStack(spacing: 8) {
            RealtimeVoiceHalo(activity: voiceActivity, muted: session.muted, size: size)
            Text(displayedStatus)
                .font(.title3.weight(.medium))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.updatesFrequently)
            if session.connected, !session.ending, session.error == nil, session.muted, session.status == "Speaking" {
                Text("Microphone muted").font(.caption).foregroundStyle(Theme.textSecondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 4)
        .padding(.bottom, 20)
        .background {
            LinearGradient(
                stops: [
                    .init(color: Theme.bgPrimary, location: 0),
                    .init(color: Theme.bgPrimary, location: 0.92),
                    .init(color: Theme.bgPrimary.opacity(0), location: 1),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        }
        .accessibilitySortPriority(1)
    }

    private var voiceActivity: RealtimeVoiceActivity {
        .resolve(
            active: session.connected && !session.ending && session.error == nil,
            muted: session.muted,
            userSpeaking: session.userSpeechActive,
            agentSpeaking: session.status == "Speaking"
        )
    }

    private var toolActivity: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let assistant = activityTurn {
                let pillRuns = computeCitationPillRuns(parts: assistant.parts)
                let lastText = agentLastAnswerTextIndex(in: assistant.parts)
                ForEach(Array(assistant.parts.enumerated()), id: \.offset) { index, part in
                    switch part {
                    case .tool, .subagent:
                        AgentPartView(
                            part: part,
                            pillRun: pillRuns[index],
                            freeze: freezeToolActivity,
                            turnDone: assistant.isComplete
                        )
                        .environment(\.agentAnswerTextFollows, index < (lastText ?? -1))
                    default: EmptyView()
                    }
                }
            }
        }
    }

    private var conversationCaption: String {
        if session.ending { return "Returning to your conversation…" }
        if let notice = session.playbackNotice { return notice }
        return session.transcript.isEmpty ? "Speak naturally. You can interrupt Omnesis at any time." : session.transcript
    }

    private var displayedStatus: String {
        guard session.connected, session.error == nil, !session.ending else { return session.status }
        if session.muted { return session.status == "Speaking" ? "Speaking" : "Microphone muted" }
        if session.userSpeechActive { return "Listening" }
        if session.status == "Listening", activityTurn?.failure != nil, !store.agent.busy { return "Reply interrupted" }
        if session.status == "Listening", store.agent.busy, !session.userSpeechActive { return "Working…" }
        return session.status
    }

    private func startCall() async {
        guard let pairing else { return }
        await session.start(pairing: pairing, conversationID: session.conversationID ?? conversationID) { id in
            try await RealtimeConversationHandoff.attach(id: id, to: store.agent)
        }
    }

    private var activityTurn: AgentAssistantTurn? {
        for turn in store.agent.turns.reversed() {
            if case .assistant(let assistant) = turn { return assistant }
        }
        return nil
    }
}

#if DEBUG
#Preview("Voice · You speaking") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeUserSpeaking)
        .environment(AppStore.preview())
}

#Preview("Voice · Agent speaking") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeAgentSpeaking)
        .environment(AppStore.preview())
}

#Preview("Voice · Long speech") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeLongSpeech)
        .environment(AppStore.preview())
}

#Preview("Voice · Reduced motion and large text") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeLongSpeech)
        .environment(AppStore.preview())
        .environment(\.voiceHaloMotion, false)
        .dynamicTypeSize(.accessibility3)
}

#Preview("Voice · Starting microphone") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeMicrophoneStarting)
        .environment(AppStore.preview())
}

#Preview("Voice · Listening") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeListening)
        .environment(AppStore.preview())
}

#Preview("Voice · Ending") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeEnding)
        .environment(AppStore.preview())
}

#Preview("Voice · Working") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeListening)
        .environment(PreviewMocks.realtimeWorkingStore)
}

#Preview("Voice · Reply interrupted") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimePlaybackLimited)
        .environment(AppStore.preview())
}

#Preview("Voice · Turn failed") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeListening)
        .environment(PreviewMocks.realtimeTurnFailureStore)
}

#Preview("Voice · Closed after a failed reply") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeFailure)
        .environment(PreviewMocks.realtimeTurnFailureStore)
}

#Preview("Voice · Ending after a failed reply") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeEnding)
        .environment(PreviewMocks.realtimeTurnFailureStore)
}

#Preview("Voice · Tool activity") {
    RealtimeCallView(pairing: nil, freezeToolActivity: true, session: PreviewMocks.realtimeTools)
        .environment(PreviewMocks.realtimeToolsStore)
        .preferredColorScheme(.dark)
}

#Preview("Voice · Accessible tool activity") {
    RealtimeCallView(pairing: nil, freezeToolActivity: true, session: PreviewMocks.realtimeTools)
        .environment(PreviewMocks.realtimeToolsStore)
        .dynamicTypeSize(.accessibility3)
}

#Preview("Voice · SQL results") {
    RealtimeCallView(pairing: nil, freezeToolActivity: true, session: PreviewMocks.realtimeTools)
        .environment(PreviewMocks.realtimeSQLStore)
}

#Preview("Voice · Batch tool activity") {
    RealtimeCallView(pairing: nil, freezeToolActivity: true, session: PreviewMocks.realtimeTools)
        .environment(PreviewMocks.realtimeBatchStore)
}

#Preview("Voice · Citations") {
    RealtimeCallView(pairing: nil, freezeToolActivity: true, session: PreviewMocks.realtimeTools, citationsOpen: true)
        .environment(PreviewMocks.realtimeCitationsStore)
}

/// Scripted caption updates exercise the actual call surface without audio or inference.
struct RealtimeScrollDemoSurface: View {
    @State private var session = PreviewMocks.realtimeLongSpeech
    @State private var streaming = false
    @State private var emitted = 0
    @State private var store = AppStore.preview()

    var body: some View {
        VStack(spacing: 0) {
            RealtimeCallView(pairing: nil, session: session)
                .environment(store)
                .environment(\.voiceHaloMotion, false)
            Button(streaming ? "Streaming fixture · \(emitted)" : "Stream fixture") { streaming = true }
                .frame(minHeight: 44)
                .disabled(streaming)
                .accessibilityIdentifier("realtime.fixture.stream")
                .accessibilityValue("\(emitted)")
        }
        .task(id: streaming) {
            guard streaming else { return }
            for index in 1 ... 40 {
                do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
                session.transcript += "\n\nWorkshop update \(index). Leave a clear aisle between the tables."
                emitted = index
            }
        }
    }
}

#Preview("Voice · Stream interaction") { RealtimeScrollDemoSurface() }

#Preview("Voice · Error") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeFailure)
        .environment(AppStore.preview())
}
#endif
#endif
