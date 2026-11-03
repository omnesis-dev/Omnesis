// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// A known inactive verdict never prevents saving a note.
@available(iOS 17.0, *)
struct NoteProcessingNotice: View {
    @Environment(AppStore.self) private var store
    @State private var showSettings = false
    var previewStatus: NoteAgentStatus?

    var body: some View {
        if let notice = (previewStatus ?? store.statusSnapshot?.noteAgent)?.notice {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text(notice)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Open Agent settings") { showSettings = true }
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.accent)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Spacing.md)
            .accessibilityIdentifier("noteProcessing.notice")
            .sheet(isPresented: $showSettings) {
                SettingsView(initialDestination: .models(initialRole: "agent"))
                    .omnesisColorScheme()
            }
        }
    }
}
#endif

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
@available(iOS 17.0, *)
#Preview("Note processing — missing Agent") {
    NoteProcessingNotice(previewStatus: PreviewMocks.noteProcessingMissingAgent)
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Note processing — off") {
    NoteProcessingNotice(previewStatus: PreviewMocks.noteProcessingOff)
        .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Capture — Agent unavailable") {
    CaptureView(speech: .preview(state: .unavailable))
        .environment(AppStore.preview(statusSnapshot: PreviewMocks.statusSnapshotMissingAgent))
}
#endif
