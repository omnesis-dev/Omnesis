// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

// MARK: - Shake detection

extension UIDevice {
    /// Posted when the device is shaken. A single `UIWindow.motionEnded`
    /// override fans the hardware event out to any SwiftUI view listening via
    /// `.onShake`.
    static let deviceDidShakeNotification = Notification.Name("dev.omnesis.deviceDidShake")
}

extension UIWindow {
    override open func motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        super.motionEnded(motion, with: event)
        if motion == .motionShake {
            NotificationCenter.default.post(name: UIDevice.deviceDidShakeNotification, object: nil)
        }
    }
}

private struct DeviceShakeModifier: ViewModifier {
    let action: () -> Void

    func body(content: Content) -> some View {
        content.onReceive(
            NotificationCenter.default.publisher(for: UIDevice.deviceDidShakeNotification)
        ) { _ in action() }
    }
}

extension View {
    /// Run `action` when the device is shaken.
    func onShake(perform action: @escaping () -> Void) -> some View {
        modifier(DeviceShakeModifier(action: action))
    }
}

// MARK: - Publishing the current entity

private struct DevTargetModifier: ViewModifier {
    @Environment(AppStore.self) private var store
    @State private var id = UUID()
    let target: DevAnnotationTarget

    func body(content: Content) -> some View {
        content
            .onAppear { store.pushDevTarget(id, target) }
            .onDisappear { store.removeDevTarget(id) }
    }
}

extension View {
    /// Publish the entity this view is showing so shake-to-annotate can attach
    /// a developer annotation to it. A no-op cost in production; only read in
    /// developer mode.
    func devTarget(_ target: DevAnnotationTarget) -> some View {
        modifier(DevTargetModifier(target: target))
    }
}

/// Publishes the open agent conversation as the shake target. Unlike the
/// per-entity detail views (recreated per entity, so `onAppear` alone suffices),
/// the agent view persists while the conversation id changes underneath it — so
/// this re-publishes on change, and publishes nothing while there is no session
/// (the hero / not-yet-created state), letting shake fall back to a free-form
/// note.
private struct ConversationDevTargetModifier: ViewModifier {
    @Environment(AppStore.self) private var store
    @State private var id = UUID()
    let conversationId: String?
    let title: String

    private var target: DevAnnotationTarget? {
        guard let cid = conversationId, !cid.isEmpty else { return nil }
        return .conversation(cid, label: title.isEmpty ? nil : title)
    }

    func body(content: Content) -> some View {
        content
            .onAppear { publish() }
            .onDisappear { store.removeDevTarget(id) }
            .onChange(of: conversationId) { _, _ in publish() }
            .onChange(of: title) { _, _ in publish() }
    }

    private func publish() {
        if let target { store.pushDevTarget(id, target) } else { store.removeDevTarget(id) }
    }
}

extension View {
    /// Publish the open agent conversation as the shake target (see
    /// `ConversationDevTargetModifier`). Pass a nil/empty id in the hero state.
    func devConversationTarget(_ conversationId: String?, title: String) -> some View {
        modifier(ConversationDevTargetModifier(conversationId: conversationId, title: title))
    }
}

// MARK: - Shake-to-annotate entry point

private struct DeveloperAnnotationCaptureModifier: ViewModifier {
    @Environment(AppStore.self) private var store

    func body(content: Content) -> some View {
        content.onShake {
            guard store.developerEnabled else { return }
            DevAnnotationOverlay.present(
                target: store.currentDevTarget ?? .route("iOS app"),
                store: store
            )
        }
    }
}

/// Presents the composer in a dedicated overlay `UIWindow` above everything —
/// including a detail sheet already on screen. Presenting the composer as a
/// SwiftUI `.sheet` from the app root fails whenever a detail screen is itself
/// sheet-presented (UIKit can't present a second sheet from an ancestor), so
/// shake-to-annotate over a loop / brief / calendar sheet would no-op. A
/// dedicated window sidesteps the presentation hierarchy entirely.
@MainActor
enum DevAnnotationOverlay {
    private static var window: UIWindow?

    static func present(target: DevAnnotationTarget, store: AppStore) {
        // Self-heal a window orphaned by a scene disconnect that bypassed
        // `dismiss()` — otherwise the stale reference would make every later
        // shake a silent no-op.
        if window?.windowScene == nil { window = nil }
        guard window == nil else { return }
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive })
            ?? scenes.first
        else { return }

        let host = UIHostingController(
            rootView: DevAnnotationOverlayRoot(target: target, store: store, onClose: dismiss)
        )
        host.view.backgroundColor = .clear

        let overlay = UIWindow(windowScene: scene)
        overlay.windowLevel = .alert
        overlay.rootViewController = host
        overlay.makeKeyAndVisible()
        window = overlay
    }

    static func dismiss() {
        window?.isHidden = true
        window = nil
    }
}

/// Hosts the composer sheet inside the overlay window. `onDismiss` (fired for
/// both programmatic and swipe dismissal) tears the window back down.
private struct DevAnnotationOverlayRoot: View {
    let target: DevAnnotationTarget
    let store: AppStore
    let onClose: () -> Void
    @State private var showing = true

    var body: some View {
        Color.clear
            .sheet(isPresented: $showing, onDismiss: onClose) {
                DevAnnotationComposer(target: target).environment(store)
            }
    }
}

extension View {
    /// Attach shake-to-annotate to the app root. Shaking the device in
    /// developer mode opens a composer targeting whatever entity the current
    /// screen published (via `.devTarget(_:)`), or a free-form note otherwise.
    func developerAnnotationCapture() -> some View {
        modifier(DeveloperAnnotationCaptureModifier())
    }
}

// MARK: - Composer

/// Sheet for filing one developer annotation. Reads the write client from the
/// `AppStore`; the target is fixed for the life of the sheet.
struct DevAnnotationComposer: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let target: DevAnnotationTarget

    @State private var note: String = ""
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                Text(target.label)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(Theme.textSecondary)
                    .lineLimit(3)

                ZStack(alignment: .topLeading) {
                    if note.isEmpty {
                        Text("What's wrong or inconsistent here?")
                            .foregroundStyle(Theme.textSecondary)
                            .padding(.top, 8)
                            .padding(.leading, 5)
                    }
                    TextEditor(text: $note)
                        .frame(minHeight: 140)
                        .scrollContentBackground(.hidden)
                }
                .padding(8)
                .background(Theme.bgSecondary)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(
                    RoundedRectangle(cornerRadius: 8).stroke(Theme.border, lineWidth: 1)
                )

                if let errorMessage {
                    Text(errorMessage).font(.footnote).foregroundStyle(.red)
                }

                Spacer()
            }
            .padding()
            .background(Theme.bgPrimary)
            .navigationTitle("Developer annotation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(busy ? "Filing…" : "File") { Task { await submit() } }
                        .disabled(busy || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }

    private func submit() async {
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let client = store.search else {
            errorMessage = "Not connected to the gateway."
            return
        }
        busy = true
        errorMessage = nil
        do {
            let versions = AppBuild.versionInfo
            try await client.createDevAnnotation(
                targetType: target.type,
                targetId: target.id,
                note: trimmed,
                contextLabel: target.label,
                appVersion: versions.version,
                appBuild: versions.build
            )
            dismiss()
        } catch {
            errorMessage = "Failed to file annotation: \(error.localizedDescription)"
            busy = false
        }
    }
}

#if DEBUG
#Preview("Composer — document target") {
    DevAnnotationComposer(target: .document("doc-1", label: "Re: Q4 budget review"))
        .environment(AppStore.preview())
}

#Preview("Composer — free-form route") {
    DevAnnotationComposer(target: .route("iOS app"))
        .environment(AppStore.preview())
}

#Preview("Composer — long label truncates") {
    DevAnnotationComposer(
        target: .temporalAnnotation(
            "t-1",
            label: "Dentist appointment moved to the second Tuesday of next month, "
                + "confirmed by the practice over the phone earlier this week"
        )
    )
    .environment(AppStore.preview())
}
#endif
#endif
