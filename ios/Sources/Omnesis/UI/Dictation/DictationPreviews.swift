// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit) && DEBUG
import SwiftUI

// Gateway dictation's states on every mic touchpoint, kept together so the
// wait and the fallback can be compared across surfaces.

private let composerDraft = "Summarize what the landlord said about the lease renewal"
private let captureDraft = "Remember to book the dentist for Thursday morning and move the team retro to two"
private let briefDraft = "Push the reminder to Friday and tell Maya I confirmed"

@available(iOS 17.0, *)
private func composer(_ speech: SpeechRecognizer, text: String) -> some View {
    AgentComposer(
        text: .constant(text),
        busy: false,
        disabled: false,
        speech: speech,
        onSend: { _, _ in },
        onCancel: {},
        focused: FocusState<Bool>().projectedValue
    )
    .padding(.top, 300)
    .background(Theme.bgPrimary)
}

@available(iOS 17.0, *)
#Preview("Composer — finishing (Send held)") {
    composer(SpeechRecognizer.preview(state: .finishing, transcript: composerDraft), text: composerDraft)
}

@available(iOS 17.0, *)
#Preview("Composer — transcribing on the gateway") {
    composer(SpeechRecognizer.preview(state: .refining, transcript: composerDraft), text: composerDraft)
}

@available(iOS 17.0, *)
#Preview("Composer — transcribing, no on-device draft") {
    composer(SpeechRecognizer.preview(state: .refining), text: "")
}

@available(iOS 17.0, *)
#Preview("Composer — gateway failed, on-device text kept") {
    composer(
        SpeechRecognizer.preview(state: .idle, transcript: composerDraft, usedOnDeviceFallback: true),
        text: composerDraft
    )
}

@available(iOS 17.0, *)
#Preview("Capture — transcribing on the gateway") {
    CaptureView(speech: .preview(state: .refining, transcript: captureDraft), previewText: captureDraft)
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Capture — gateway failed, on-device text kept") {
    CaptureView(
        speech: .preview(state: .idle, transcript: captureDraft, usedOnDeviceFallback: true),
        previewText: captureDraft
    )
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Briefs — row transcribing on the gateway") {
    NavigationStack {
        BriefsListContent(
            feed: BriefsFeedState(briefs: PreviewMocks.briefs),
            loading: false,
            loadError: nil,
            onOpen: { _ in },
            onQuickClear: { _ in },
            onAsk: { _ in },
            onDictate: { _ in },
            onMoreOptions: { _ in },
            speech: SpeechRecognizer.preview(state: .refining, transcript: briefDraft),
            dictatingBriefId: PreviewMocks.briefs.first?.id,
            onRetry: {},
            onRefresh: {}
        )
        .navigationTitle("Briefs")
        .navigationBarTitleDisplayMode(.inline)
    }
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("Briefs — detail transcribing on the gateway") {
    BriefDetailSheet(
        brief: PreviewMocks.briefInfo,
        store: AppStore.preview(sources: PreviewMocks.sources),
        speech: SpeechRecognizer.preview(state: .refining, transcript: briefDraft)
    )
    .environment(AppStore.preview(sources: PreviewMocks.sources))
}

@available(iOS 17.0, *)
#Preview("Briefs — detail, on-device text kept") {
    BriefDetailSheet(
        brief: PreviewMocks.briefInfo,
        store: AppStore.preview(sources: PreviewMocks.sources),
        speech: SpeechRecognizer.preview(state: .idle, transcript: briefDraft, usedOnDeviceFallback: true)
    )
    .environment(AppStore.preview(sources: PreviewMocks.sources))
}
#endif
