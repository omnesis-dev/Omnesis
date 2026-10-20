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
        VStack(spacing: 24) {
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
                }
                .accessibilityLabel("Open citations")
            }
            ScrollView {
                VStack(spacing: 24) {
                    ZStack {
                        Circle().fill(Theme.accent.opacity(0.08)).frame(width: 210, height: 210)
                        Circle().fill(Theme.accent.opacity(0.14)).frame(width: 170, height: 170)
                        Circle()
                            .fill(LinearGradient(
                                colors: [Theme.accent, Theme.accent.opacity(0.45)],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ))
                            .frame(width: 126, height: 126)
                        Image(systemName: session.muted ? "mic.slash.fill" : "waveform")
                            .font(.system(size: 42, weight: .medium))
                            .foregroundStyle(.white)
                    }
                    .accessibilityHidden(true)
                    Text(session.muted ? "Microphone muted" : session.status)
                        .font(.title3.weight(.medium))
                        .accessibilityAddTraits(.updatesFrequently)
                    if let error = session.error {
                        GatewayErrorView(context: "start the voice conversation", error: error, onRetry: {
                            session.error = nil
                            Task { await startCall() }
                        })
                        .frame(minHeight: GatewayErrorView.minScrollHeight)
                    } else {
                        Text(session.transcript.isEmpty ? "Speak naturally. You can interrupt Omnesis at any time." : session.transcript)
                            .font(.body)
                            .foregroundStyle(session.transcript.isEmpty ? Theme.textSecondary : Theme.textPrimary)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                    }
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
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
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
                    session.stop()
                    dismiss()
                } label: {
                    Image(systemName: "phone.down.fill")
                        .font(.title2)
                        .foregroundStyle(.white)
                        .frame(width: 64, height: 64)
                        .background(Theme.danger, in: Circle())
                }
                .accessibilityLabel("End voice conversation")
            }
            Text("Audio is sent through your gateway to OpenAI.")
                .font(.caption)
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
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
#Preview("Voice · Starting microphone") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeMicrophoneStarting)
        .environment(AppStore.preview())
}

#Preview("Voice · Listening") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeListening)
        .environment(AppStore.preview())
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

#Preview("Voice · Error") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeFailure)
        .environment(AppStore.preview())
}
#endif
#endif
