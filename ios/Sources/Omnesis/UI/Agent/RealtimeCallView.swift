// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(UIKit)
import SwiftUI

/// A dedicated voice surface; audio stays scoped to its foreground presentation.
@available(iOS 17.0, *)
struct RealtimeCallView: View {
    let pairing: Pairing?
    var conversationID: String?
    var onEnd: ((String?) -> Void)?
    @State var session = RealtimeCallSession()
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
                Image(systemName: "waveform").foregroundStyle(Theme.accent)
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
                    VStack(spacing: 8) {
                        ForEach(session.tools) { tool in
                            HStack(spacing: 12) {
                                if tool.finished {
                                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.accent)
                                } else { ProgressView() }
                                Text(tool.name.replacingOccurrences(of: "_", with: " "))
                                    .font(.subheadline.weight(.medium)).lineLimit(2)
                                Spacer()
                                Text(tool.finished ? "Done" : "Working")
                                    .font(.caption).foregroundStyle(Theme.textSecondary)
                            }
                            .padding(12)
                            .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: 14))
                            .accessibilityElement(children: .combine)
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
        .task { await startCall() }
        .onDisappear { session.stop()
            onEnd?(session.conversationID)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { session.stop()
                dismiss()
            }
        }
    }

    private func startCall() async {
        guard let pairing else { return }
        await session.start(pairing: pairing, conversationID: session.conversationID ?? conversationID)
    }
}

#if DEBUG
#Preview("Voice · Listening") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeListening)
}

#Preview("Voice · Tool activity") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeTools)
        .preferredColorScheme(.dark)
}

#Preview("Voice · Accessible tool activity") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeTools)
        .dynamicTypeSize(.accessibility3)
}

#Preview("Voice · Error") {
    RealtimeCallView(pairing: nil, session: PreviewMocks.realtimeFailure)
}
#endif
#endif
