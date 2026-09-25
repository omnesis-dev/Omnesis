// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit) && canImport(PhotosUI)
import Photos
import PhotosUI
import SwiftUI

extension PhotosSetupStep: PhoneSetupStepVisuals {
    func illustration() -> AnyView? {
        AnyView(PhotosSetupIllustration())
    }

    func outcomeAction(for outcome: PhoneSetupOutcome) -> PhoneSetupOutcomeAction? {
        guard outcome == .limited else { return nil }
        return PhoneSetupOutcomeAction(title: PhotosLimitedLibraryPicker.title) {
            await PhotosLimitedLibraryPicker.present()
        }
    }
}

/// A photo that stays behind a lock while only what was read from it crosses
/// to the gateway. The example is invented.
struct PhotosSetupIllustration: View {
    private let tint = PhoneSetupTint(hex: PhotosSetupStep.copy.tint)

    var body: some View {
        HStack(spacing: 12) {
            photo
            Image(systemName: "arrow.right")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(tint.ink)
            VStack(alignment: .leading, spacing: 5) {
                extracted("text", "Total 38.50")
                extracted("labels", "receipt, paper")
                extracted("taken", "14 Mar, 20:12")
                extracted("place", "Riverside")
            }
            Spacer(minLength: 0)
        }
        .phoneSetupCard(padding: 12)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("The photo stays on this iPhone. Only the text, labels, date and place found in it are sent.")
    }

    private var photo: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(
                LinearGradient(
                    colors: [Color(hex: 0x2B4C7A), Color(hex: 0x15253D)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
            .overlay(alignment: .topLeading) {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach([1.0, 0.7, 0.9, 0.5], id: \.self) { share in
                        Capsule()
                            .fill(.white.opacity(0.75))
                            .frame(width: 44 * share, height: 3)
                    }
                }
                .padding(12)
            }
            .overlay(alignment: .bottomTrailing) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Color(hex: 0xCFD9E4))
                    .frame(width: 18, height: 18)
                    .background(
                        RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Color(hex: 0x0B121D).opacity(0.8))
                    )
                    .padding(5)
            }
            .frame(width: 70, height: 84)
    }

    private func extracted(_ key: String, _ value: String) -> some View {
        HStack(spacing: 4) {
            Text("\(key):")
                .foregroundStyle(PhoneSetupPalette.textMuted)
            Text(value)
                .foregroundStyle(PhoneSetupPalette.chipText)
        }
        .font(.system(size: 11, design: .monospaced))
        .lineLimit(1)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous).fill(PhoneSetupPalette.chip)
        )
    }
}

/// Photos' note in Settings while the library is limited to a selection:
/// described, never flagged, with a way to add more photos.
struct PhotosLimitedAccessRow: View {
    /// The picker's lifetime is the row's: it is shown from a task the row
    /// owns, which ends with the row.
    @State private var isPicking = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(PhotosSetupStep.copy.limitedBody ?? "")
                .font(.footnote)
                .foregroundStyle(Theme.textSecondary)
            Button(PhotosLimitedLibraryPicker.title) { isPicking = true }
                .font(.footnote.weight(.semibold))
                .disabled(isPicking)
        }
        .task(id: isPicking) {
            guard isPicking else { return }
            await PhotosLimitedLibraryPicker.present()
            isPicking = false
        }
    }
}

/// iOS's picker for adding photos to a selected library. Omnesis suppresses
/// the automatic prompt iOS would otherwise show, so this is the one way in.
@MainActor
enum PhotosLimitedLibraryPicker {
    static let title = "Add more photos"

    /// Shows the picker over the frontmost screen and returns once it closes.
    static func present() async {
        guard let presenter = frontmostViewController() else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: presenter) { _ in
                continuation.resume()
            }
        }
    }

    private static func frontmostViewController() -> UIViewController? {
        var top = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }
}

#if DEBUG
#Preview("Photos — setup page") {
    PhoneSetupPreview.view(screen: .step(index: 0), selection: [PhotosSetupStep.sourceId])
}

#Preview("Photos — limited access in Settings") {
    Form {
        Section("Photos") {
            PhotosLimitedAccessRow()
        }
        .listRowBackground(Theme.bgSecondary)
    }
    .scrollContentBackground(.hidden)
    .background(Theme.bgPrimary)
    .omnesisColorScheme()
}
#endif
#endif
