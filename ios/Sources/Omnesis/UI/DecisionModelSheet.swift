// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// The screens pushed inside the Decision model sheet.
enum DecisionRoute: Hashable {
    case providers
    case form(DecisionModelSetup.Choice)
}

/// Sets up the Decision model, mirroring the portal's Decision card: the
/// current model with a Verify check, its calibration onto Jev's scale, and
/// "Change provider", which walks one decision per screen through the
/// provider list and that provider's form. Saving is one `PATCH
/// /admin/config` (TypeSafe's key goes to its credential route first), after
/// which the new model is verified and its result shown as the gateway wrote it.
@available(iOS 17.0, *)
struct DecisionModelSheet: View {
    let overview: ModelsOverview
    /// Reload the overview after the config changed.
    var onChanged: () async -> Void = {}

    @Environment(AppStore.self) private var store: AppStore?
    @Environment(\.dismiss) private var dismiss

    @State private var path: [DecisionRoute] = []
    @State private var verifying = false
    @State private var verifyResult: DecisionVerifyResult?
    /// The model the shown verify result was asked about.
    @State private var verifiedModel: String?
    @State private var verifyError: String?
    @State private var calibration: DecisionCalibrationStatus?
    @State private var calibrationError: String?
    @State private var calibrationBusy = false
    @State private var confirmCalibration = false

    /// Fixed calls for previews; nil uses the paired gateway.
    private let previewActions: DecisionModelActions?

    init(overview: ModelsOverview, onChanged: @escaping () async -> Void = {}) {
        self.overview = overview
        self.onChanged = onChanged
        previewActions = nil
    }

    #if DEBUG
    /// Preview/snapshot seam: a verify outcome and calibration job already on
    /// screen, and no gateway calls.
    init(
        overview: ModelsOverview,
        previewVerify: DecisionVerifyResult? = nil,
        previewCalibration: DecisionCalibrationStatus? = nil
    ) {
        self.overview = overview
        _verifyResult = State(initialValue: previewVerify)
        _verifiedModel = State(initialValue: DecisionModelSetup.currentVerifyTarget(overview)?.model)
        _calibration = State(initialValue: previewCalibration)
        previewActions = .unavailable
    }
    #endif

    private var actions: DecisionModelActions {
        previewActions ?? .live(store?.admin)
    }

    private var current: ResolvedAssignment? {
        overview.inference.assignments[DecisionModelSetup.role]
    }

    /// The calibration job's status when it concerns the current model.
    private var currentCalibration: DecisionCalibrationStatus? {
        DecisionModelSetup.relevantCalibration(calibration, in: overview)
    }

    private var display: ModelDisplay? {
        overview.assignmentDisplays[DecisionModelSetup.role]
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    if let description = overview.capabilities.first(where: { $0.role == DecisionModelSetup.role })?.description {
                        Text(description)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.textSecondary)
                    }
                    currentModelCard
                    if let state = DecisionModelSetup.calibrationState(overview) {
                        calibrationCard(state)
                    }
                }
                .padding(Theme.Spacing.lg)
            }
            .background(Theme.bgPrimary.ignoresSafeArea())
            .navigationTitle("Decision model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
            }
            .navigationDestination(for: DecisionRoute.self) { route in
                destination(route)
            }
        }
        .task { await loadCalibration() }
        .task(id: currentCalibration?.isRunning == true) { await pollCalibration() }
        .confirmationDialog(
            "Calibrate \(current?.model ?? "this model")?",
            isPresented: $confirmCalibration,
            titleVisibility: .visible
        ) {
            Button("Calibrate") { startCalibration() }
        } message: {
            Text(DecisionModelSetup.calibrationExplanation(onHost: current?.onHost == true))
        }
    }

    @ViewBuilder
    private func destination(_ route: DecisionRoute) -> some View {
        switch route {
        case .providers:
            DecisionProviderList(overview: overview) { choice in
                path.append(.form(choice))
            }
        case .form(let choice):
            DecisionBackendForm(
                choice: choice,
                overview: overview,
                actions: actions,
                onSave: { draft in try await save(draft) },
                onRemove: { key in try await remove(key) }
            )
        }
    }

    // MARK: - Current model

    private var currentModelCard: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.md) {
            if let display, display.configured {
                HStack(spacing: Theme.Spacing.sm) {
                    ProviderIcon(providerId: display.providerId, size: 22)
                        .foregroundStyle(Theme.textPrimary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(display.providerLabel)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Theme.textPrimary)
                        Text(display.modelName)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 0)
                }
                if current?.available == false, let reason = current?.reason, !reason.isEmpty {
                    Text(reason)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let target = DecisionModelSetup.currentVerifyTarget(overview) {
                    verifyRow(target)
                }
                changeProviderLink(title: "Change provider")
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("No decision model yet")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Theme.textPrimary)
                    Text("Pick a decision server on your machine or a hosted decision API.")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textSecondary)
                }
                changeProviderLink(title: "Choose a provider")
            }
        }
        .decisionCard()
    }

    private func verifyRow(_ target: DecisionModelSetup.VerifyTarget) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            DecisionOutlineButton(title: verifying ? "Verifying…" : "Verify", busy: verifying) {
                Task { await runVerify(target) }
            }
            .disabled(verifying)
            if let verifyResult {
                DecisionResultLine(
                    ok: verifyResult.ok,
                    text: DecisionModelSetup.verifyText(verifyResult, model: verifiedModel)
                )
            } else if let verifyError {
                DecisionResultLine(ok: false, text: verifyError)
            }
        }
    }

    private func changeProviderLink(title: String) -> some View {
        NavigationLink(value: DecisionRoute.providers) {
            VStack(spacing: Theme.Spacing.md) {
                Rectangle()
                    .fill(Theme.border)
                    .frame(height: 1)
                HStack {
                    Text(title)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.accent)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.textMuted)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Calibration

    private func calibrationCard(_ state: DecisionModelSetup.CalibrationState) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text("Calibration")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
            if let status = currentCalibration, status.isRunning {
                ProgressView(value: Double(status.done), total: Double(max(status.total, 1)))
                    .tint(Theme.accent)
                Text(DecisionModelSetup.calibrationProgressText(status))
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textSecondary)
                DecisionOutlineButton(title: "Cancel", color: Theme.danger, busy: calibrationBusy) {
                    cancelCalibration()
                }
                .disabled(calibrationBusy)
            } else {
                switch state {
                case .uncalibrated:
                    Label {
                        Text(DecisionModelSetup.uncalibratedText)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.warning)
                    }
                case .calibrated(let stored):
                    Text(DecisionModelSetup.calibratedText(stored))
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let outcome = currentCalibration.flatMap(DecisionModelSetup.calibrationOutcomeText) {
                    DecisionResultLine(ok: false, text: outcome)
                }
                if let calibrationError {
                    DecisionResultLine(ok: false, text: calibrationError)
                }
                DecisionOutlineButton(
                    title: state == .uncalibrated ? "Calibrate" : "Recalibrate",
                    busy: calibrationBusy
                ) {
                    confirmCalibration = true
                }
                .disabled(calibrationBusy)
            }
        }
        .decisionCard()
    }

    // MARK: - Gateway calls

    private func save(_ draft: DecisionModelSetup.Draft) async throws {
        let plan = DecisionModelSetup.savePlan(draft, in: overview)
        try await actions.save(plan)
        verifyResult = nil
        verifyError = nil
        calibration = nil
        calibrationError = nil
        await onChanged()
        path.removeAll()
        await runVerify(plan.verifyTarget)
    }

    private func remove(_ key: String) async throws {
        try await actions.remove(DecisionModelSetup.removalPatch(key: key, in: overview))
        verifyResult = nil
        verifyError = nil
        await onChanged()
        path.removeAll()
    }

    private func runVerify(_ target: DecisionModelSetup.VerifyTarget) async {
        verifying = true
        verifiedModel = target.model
        defer { verifying = false }
        do {
            verifyResult = try await actions.verify(target)
            verifyError = nil
        } catch {
            verifyResult = nil
            verifyError = deviceGatewayMessage(error)
        }
    }

    private func loadCalibration() async {
        guard previewActions == nil, DecisionModelSetup.calibrationState(overview) != nil else { return }
        calibration = try? await actions.calibrationStatus()
    }

    /// Poll every two seconds while a run is going. A finished run reloads
    /// the overview first, so the card reads "Calibrated" as the progress goes.
    private func pollCalibration() async {
        guard previewActions == nil, currentCalibration?.isRunning == true else { return }
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let fresh = try? await actions.calibrationStatus() else { continue }
            if !fresh.isRunning {
                if fresh.state == "done", DecisionModelSetup.relevantCalibration(fresh, in: overview) != nil {
                    await onChanged()
                }
                calibration = fresh
                return
            }
            calibration = fresh
        }
    }

    private func startCalibration() {
        calibrationBusy = true
        calibrationError = nil
        Task {
            defer { calibrationBusy = false }
            do {
                calibration = try await actions.startCalibration()
            } catch GatewayClient.Error.serverError(status: 409, _) {
                // Already running (from another client): follow that run.
                calibration = try? await actions.calibrationStatus()
            } catch {
                calibrationError = deviceGatewayMessage(error)
            }
        }
    }

    private func cancelCalibration() {
        calibrationBusy = true
        Task {
            defer { calibrationBusy = false }
            do {
                calibration = try await actions.cancelCalibration()
            } catch {
                calibrationError = deviceGatewayMessage(error)
            }
        }
    }
}
#endif
