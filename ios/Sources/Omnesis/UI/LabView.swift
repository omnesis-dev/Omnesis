// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

@available(iOS 17.0, *)
struct LabView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.colorScheme) private var colorScheme
    @State private var snapshot: LabSnapshot?
    @State private var error: Error?
    @State private var saving: LabFeature.FeatureID?
    @State private var failedFeature: LabFeature.FeatureID?
    private let preview: Bool

    init(snapshot: LabSnapshot? = nil, error: Error? = nil, failedFeature: LabFeature.FeatureID? = nil, preview: Bool = false) {
        _snapshot = State(initialValue: snapshot)
        _error = State(initialValue: error)
        _failedFeature = State(initialValue: failedFeature)
        self.preview = preview
    }

    var body: some View {
        Group {
            if let snapshot, snapshot.experimental {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        Text("Try what’s next")
                            .font(.largeTitle.bold())
                        Text(
                            "Explore features still taking shape. Enable each one separately. Your choices are shared across your devices."
                        )
                        .foregroundStyle(Theme.textSecondary)
                        if let error, failedFeature == nil {
                            Label(GatewayErrorView.classify(error).title, systemImage: GatewayErrorView.classify(error).symbol)
                                .foregroundStyle(Theme.danger)
                            Button("Retry") { Task { await load() } }
                        }
                        ForEach(snapshot.features) { feature in
                            featureCard(feature)
                        }
                    }
                    .padding(20)
                }
            } else if let error {
                GatewayErrorView(context: "load Omnesis Lab", error: error, onRetry: { Task { await load() } })
            } else if snapshot != nil || (!preview && !store.labAvailable) {
                ContentUnavailableView(
                    "Omnesis Lab is unavailable",
                    systemImage: "flask",
                    description: Text("Start the gateway in experimental mode to explore Lab features.")
                )
            } else {
                ProgressView("Loading Omnesis Lab…")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bgPrimary)
        .navigationTitle("Omnesis Lab")
        .navigationBarTitleDisplayMode(.inline)
        .task { if !preview { await load() } }
    }

    private func featureCard(_ feature: LabFeature) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center) {
                if let svg = feature.iconSvg,
                   let image = ProviderSVGRenderer.render(Data(svg.utf8), colorScheme: colorScheme) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 44, height: 44)
                        .accessibilityHidden(true)
                }
                Spacer()
                Toggle(feature.name, isOn: Binding(
                    get: { feature.enabled },
                    set: { enabled in Task { await set(feature.id, enabled: enabled) } }
                ))
                .labelsHidden()
                .tint(Theme.accent)
                .disabled(saving != nil)
                .accessibilityIdentifier("lab-toggle-\(feature.id.rawValue)")
            }
            Text(feature.name).font(.title2.bold())
            Text(feature.description)
                .font(.body)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            if let error, failedFeature == feature.id {
                Label(
                    "Change wasn’t saved. " + GatewayErrorView.classify(error).title,
                    systemImage: GatewayErrorView.classify(error).symbol
                )
                .font(.callout)
                .foregroundStyle(Theme.danger)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: 20))
    }

    private func load() async {
        guard let admin = store.admin else { return }
        do {
            snapshot = try await admin.getLab()
            error = nil
            failedFeature = nil
        } catch { self.error = error }
    }

    private func set(_ id: LabFeature.FeatureID, enabled: Bool) async {
        guard !preview, let admin = store.admin, saving == nil else { return }
        saving = id
        error = nil
        failedFeature = nil
        defer { saving = nil }
        do {
            snapshot = try await admin.setLabFeature(id, enabled: enabled)
            error = nil
            await store.refreshGatewayStats()
        } catch {
            self.error = error
            failedFeature = id
        }
    }
}

#if DEBUG
#Preview("Omnesis Lab") {
    NavigationStack { LabView(snapshot: PreviewMocks.lab, preview: true) }
        .environment(AppStore.preview())
}

#Preview("Omnesis Lab · save failed") {
    NavigationStack {
        LabView(snapshot: PreviewMocks.lab, error: URLError(.notConnectedToInternet), failedFeature: .brain, preview: true)
    }.environment(AppStore.preview())
}

#Preview("Omnesis Lab · loading") {
    NavigationStack { LabView(preview: true) }.environment(AppStore.preview())
}

#Preview("Omnesis Lab · offline") {
    NavigationStack { LabView(error: URLError(.notConnectedToInternet), preview: true) }
        .environment(AppStore.preview())
}
#endif
#endif
