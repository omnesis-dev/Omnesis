// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit) && canImport(HealthKit)
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Developer-mode screen listing the newest HealthKit samples of every
/// catalog type by `uuid`, type and end date, with a "Copy all" report so
/// the probe of one phone can be compared against another's. Reached from
/// Settings → Gateway when the paired gateway runs in developer mode.
///
/// The screen stands on its own: it reads HealthKit directly, over the whole
/// catalog, and carries its own read-authorization action. Nothing here
/// depends on this device hosting the Apple Health source — the question the
/// probe answers is whether it *could*, and a device the gateway has refused
/// as a host is exactly the device the comparison needs a report from.
@available(iOS 17.0, *)
struct HealthSampleProbeView: View {
    @Environment(AppStore.self) private var store

    @State private var rows: [HealthSampleProbe.Row] = []
    @State private var loading = true
    @State private var requesting = false
    @State private var copied = false

    /// Preview-only flag: when true, `.task` never touches HealthKit, so a
    /// seeded snapshot renders deterministically. Always false in production.
    private let isPreview: Bool

    /// How the screen asks for read access, built on tap rather than held, so
    /// nothing touches `HKHealthStore` until the operator acts. Typed as the
    /// narrow `HealthReadAuthorizing` so the authorization path has no
    /// reach beyond the request itself.
    private let makeAuthorizer: @Sendable () -> any HealthReadAuthorizing

    init() {
        self.isPreview = false
        self.makeAuthorizer = { HealthKitClient() }
    }

    #if DEBUG
    init(
        previewRows: [HealthSampleProbe.Row],
        previewLoading: Bool = false,
        previewRequesting: Bool = false,
        authorizer: (any HealthReadAuthorizing)? = nil
    ) {
        self._rows = State(initialValue: previewRows)
        self._loading = State(initialValue: previewLoading)
        self._requesting = State(initialValue: previewRequesting)
        self.isPreview = true
        self.makeAuthorizer = { authorizer ?? HealthKitClient() }
    }
    #endif

    var body: some View {
        content
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Health samples")
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(true)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    SettingsBackButton()
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: copyReport) {
                        Label(copied ? "Copied" : "Copy all", systemImage: copied ? "checkmark" : "doc.on.doc")
                    }
                    .disabled(rows.isEmpty)
                }
            }
            .toolbarBackground(Theme.bgPrimary, for: .navigationBar)
            .task { await load() }
    }

    /// How long the copied report stays on the pasteboard, and how long the
    /// button acknowledges the copy.
    private static let reportLifetime: TimeInterval = 120
    private static let acknowledgementDelay: Duration = .seconds(2)

    /// The report names HealthKit sample uuids and their exact end dates —
    /// a debugging aid for comparing two phones, not something to share. It
    /// is written local-only (never handed to another device over Universal
    /// Clipboard) and expires, so it does not sit in the pasteboard for the
    /// rest of the day. The button acknowledges briefly and then returns to
    /// its usual label, so a later tap still reads as an action.
    private func copyReport() {
        UIPasteboard.general.setItems(
            [[UTType.utf8PlainText.identifier: HealthSampleProbe.report(rows)]],
            options: [
                .localOnly: true,
                .expirationDate: Date().addingTimeInterval(Self.reportLifetime),
            ]
        )
        copied = true
        Task { @MainActor in
            try? await Task.sleep(for: Self.acknowledgementDelay)
            copied = false
        }
    }

    @ViewBuilder
    private var content: some View {
        if loading {
            ProgressView("Reading HealthKit…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if rows.isEmpty {
            emptyState
        } else {
            List {
                Section {
                    Text(
                        "The \(HealthSampleProbe.samplesPerType) newest samples of each catalog type, as HealthKit "
                            + "identifies them. Copy all and compare with another device's probe to see which "
                            + "samples both phones read."
                    )
                    .font(.footnote)
                    .foregroundStyle(Theme.textSecondary)
                }
                .listRowBackground(Theme.bgSecondary)
                ForEach(HealthSampleProbe.group(rows)) { group in
                    Section {
                        ForEach(group.rows) { row in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.uuid)
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(Theme.textPrimary)
                                Text(HealthSampleProbe.format(row.endDate))
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(Theme.textMuted)
                            }
                            .textSelection(.enabled)
                        }
                    } header: {
                        Text(group.typeIdentifier)
                            .font(.system(size: 11, design: .monospaced))
                            .textCase(nil)
                    }
                    .listRowBackground(Theme.bgSecondary)
                }
                Section {
                    authorizeButton
                        .frame(maxWidth: .infinity, alignment: .center)
                } footer: {
                    Text(
                        "A type with no read grant lists nothing here, exactly like a type with no data — "
                            + "so a type missing above is not proof this device holds none of it."
                    )
                }
                .listRowBackground(Theme.bgSecondary)
            }
            .scrollContentBackground(.hidden)
        }
    }

    /// The empty read has two causes and the read itself cannot tell them
    /// apart: Apple reports a denied type as an empty result rather than an
    /// error, so a device holding no health data and a device that was never
    /// asked look identical from here. The copy names both and hands over the
    /// one action that separates them.
    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "waveform.path.ecg")
                .font(.system(size: 36))
                .foregroundStyle(Theme.textMuted)
            Text("No samples")
                .font(.headline)
                .foregroundStyle(Theme.textPrimary)
            Text(
                "HealthKit returned nothing for any type in the catalog. A device holding no health data "
                    + "reads this way, and so does one that has never granted read access — Apple reports a "
                    + "denied type as an empty result, not an error."
            )
            .font(.footnote)
            .multilineTextAlignment(.center)
            .foregroundStyle(Theme.textSecondary)
            authorizeButton
                .padding(.top, 2)
            Text(
                "Granting access lets this screen read HealthKit. It does not enable the Apple Health "
                    + "source or start any sync on this device."
            )
            .font(.caption)
            .multilineTextAlignment(.center)
            .foregroundStyle(Theme.textMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    private var authorizeButton: some View {
        Button {
            Task {
                await authorize()
                loading = true
                await load()
            }
        } label: {
            Text(requesting ? "Requesting…" : "Request read access")
        }
        .buttonStyle(.bordered)
        .disabled(requesting)
    }

    /// Ask HealthKit for read access to the probe's catalog. The caller reads
    /// again afterwards, because a partial grant still produces rows.
    ///
    /// This is the screen's whole authorization path, and it goes through the
    /// injected `HealthReadAuthorizing` — read-only, so it cannot
    /// install observer queries, enable background delivery, prompt for
    /// notification permission, or record that Apple Health has been set up
    /// here. A device running the probe may host no source at all, and none
    /// of that state applies to it.
    ///
    /// It takes its authorizer as a dependency and reads no environment
    /// value, so it runs the same whether a view is installed or not.
    /// Internal rather than private so a test drives exactly this path.
    func authorize() async {
        requesting = true
        await HealthSampleProbe.requestReadAuthorization(makeAuthorizer())
        requesting = false
    }

    private func load() async {
        if isPreview { return }
        defer { loading = false }
        // Developer mode is the screen's gate, and it can be turned off on the
        // gateway while this view is pushed: stop reading HealthKit the moment
        // it is, rather than on the next navigation.
        guard HealthKitClient.isAvailable, store.developerEnabled else {
            rows = []
            return
        }
        rows = await HealthSampleProbe.read(
            client: HealthKitClient(),
            catalog: HealthSampleProbe.catalog
        )
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Health samples — populated") {
    NavigationStack {
        HealthSampleProbeView(previewRows: PreviewMocks.healthSampleProbeRows)
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Health samples — empty") {
    NavigationStack {
        HealthSampleProbeView(previewRows: [])
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Health samples — requesting access") {
    NavigationStack {
        HealthSampleProbeView(previewRows: [], previewRequesting: true)
    }
    .environment(AppStore.preview())
}

@available(iOS 17.0, *)
#Preview("Health samples — loading") {
    NavigationStack {
        HealthSampleProbeView(previewRows: [], previewLoading: true)
    }
    .environment(AppStore.preview())
}
#endif
#endif
