// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// One selected step: its value story and ledger with a single Continue, then
/// the outcome in place once the step has run.
struct PhoneSetupStepPage: View {
    let coordinator: PhoneSetupCoordinator
    let step: any PhoneSetupStep

    @Environment(\.phoneSetupPromptVisible) private var promptVisibleOverride
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let tint = PhoneSetupTint(hex: step.copy.tint)
        let outcome = displayedOutcome
        PhoneSetupPageLayout(centersContent: outcome != nil) {
            header(tint: tint)
        } content: {
            if let outcome {
                PhoneSetupOutcomeView(coordinator: coordinator, step: step, outcome: outcome, tint: tint)
            } else if step.introduction == .custom, let content = visuals?.introductionContent() {
                content
            } else {
                introduction(tint: tint)
            }
        } actions: {
            if let outcome {
                PhoneSetupOutcomeActions(coordinator: coordinator, step: step, outcome: outcome)
            } else {
                switch step.introduction {
                case .continueStep:
                    continueActions
                case .openSettings:
                    openSettingsActions
                case .custom:
                    visuals?.introductionActions(coordinator: coordinator)
                }
            }
        }
    }

    private var visuals: (any PhoneSetupStepVisuals)? {
        step as? any PhoneSetupStepVisuals
    }

    /// A skipped step moves straight on, so it never gets a page of its own.
    private var displayedOutcome: PhoneSetupOutcome? {
        // State a step reads from iOS, such as Background App Refresh, can
        // change while the page is up; reading revision renders the page again.
        _ = coordinator.revision
        guard let outcome = coordinator.flow.outcomes[step.id], outcome != .skipped else { return nil }
        return outcome
    }

    private var isBusy: Bool {
        coordinator.busyStepId == step.id
    }

    /// Whether an iOS permission prompt is actually on screen.
    private var promptVisible: Bool {
        promptVisibleOverride ?? SystemPromptActivity.shared.isPromptUp
    }

    private func header(tint: PhoneSetupTint) -> some View {
        HStack(spacing: 4) {
            Button {
                coordinator.back()
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 18, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .foregroundStyle(PhoneSetupPalette.textPrimary)
            .accessibilityLabel("Back")
            // A page opened for one source has no progress to show.
            if coordinator.flow.selection.count > 1 {
                PhoneSetupProgressBar(
                    count: coordinator.flow.selection.count,
                    current: coordinator.flow.currentStepIndex ?? 0,
                    tint: tint
                )
            } else {
                Spacer(minLength: 0)
            }
        }
        .padding(.leading, -14)
    }

    /// At accessibility text sizes the pinned actions would crowd out the
    /// page, so the fine print scrolls with the content instead.
    private var finePrintScrolls: Bool {
        dynamicTypeSize.isAccessibilitySize
    }

    private func introduction(tint: PhoneSetupTint) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            PhoneSetupGlyphTile(symbol: step.copy.symbol, tint: tint)
                .padding(.top, 20)
            Text(step.copy.title)
                .phoneSetupTitle()
                .padding(.top, 20)
            Text(coordinator.value(for: step))
                .phoneSetupBody()
                .padding(.top, 10)
            if let ask = step.copy.ask {
                PhoneSetupAskCard(question: ask)
                    .padding(.top, 22)
            }
            if let illustration = visuals?.illustration() {
                illustration
                    .padding(.top, 12)
            }
            if let ledger = step.copy.ledger {
                PhoneSetupLedgerView(ledger: ledger, extra: visuals?.extraLedgerSection())
                    .padding(.top, 12)
            }
            if !step.copy.highlights.isEmpty {
                PhoneSetupHighlightsView(highlights: step.copy.highlights, tint: tint)
                    .padding(.top, 24)
            }
            if finePrintScrolls, step.introduction == .continueStep, step.continueBlocker == nil {
                Text(step.copy.fine)
                    .phoneSetupFinePrint()
                    .frame(maxWidth: .infinity)
                    .padding(.top, 24)
            }
        }
    }

    /// A change made in iOS Settings: what to change there, Open Settings, and
    /// Not now to move on without it.
    private var openSettingsActions: some View {
        VStack(spacing: 10) {
            if let instruction = step.settingsInstruction(for: nil) {
                Text(instruction)
                    .phoneSetupFinePrint()
            }
            Button("Open Settings") {
                coordinator.didOpenSettings()
                PhoneSetupOutcomeActions.openAppSettings()
            }
            .buttonStyle(PhoneSetupPrimaryButtonStyle())
            Button("Not now") { coordinator.next() }
                .buttonStyle(PhoneSetupTextButtonStyle())
        }
    }

    private var continueActions: some View {
        VStack(spacing: 12) {
            Button {
                Task { await coordinator.runCurrentStep() }
            } label: {
                if isBusy {
                    PhoneSetupBusyLabel(text: promptVisible ? PhoneSetupBusyLabel.waitingForIOS : step.copy.turningOnLabel)
                } else {
                    Text("Continue")
                }
            }
            .buttonStyle(PhoneSetupPrimaryButtonStyle())
            .allowsHitTesting(coordinator.busyStepId == nil)
            .disabled(step.continueBlocker != nil)
            // Why Continue is off stays beside it at every text size.
            if let blocker = step.continueBlocker {
                Text(blocker)
                    .phoneSetupFinePrint()
            } else if !finePrintScrolls {
                Text(step.copy.fine)
                    .phoneSetupFinePrint()
            }
        }
    }
}

/// The question a source makes answerable.
struct PhoneSetupAskCard: View {
    let question: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            PhoneSetupSectionLabel(text: "You'll be able to ask", symbol: "text.bubble.fill")
            Text("\u{201C}\(question)\u{201D}")
                .font(.callout.weight(.medium))
                .foregroundStyle(PhoneSetupPalette.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .phoneSetupCard(padding: 14)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Outcome

/// How a step ended, in place of its ledger: a mark, the outcome copy, the
/// source's live status when it is on, and whatever else the outcome needs.
struct PhoneSetupOutcomeView: View {
    let coordinator: PhoneSetupCoordinator
    let step: any PhoneSetupStep
    let outcome: PhoneSetupOutcome
    let tint: PhoneSetupTint

    var body: some View {
        let message = step.copy.outcomeBody(outcome)
        VStack(spacing: 0) {
            PhoneSetupOutcomeMark(outcome: outcome, tint: tint)
                // A new identity for every success, so the mark draws it in.
                .id(coordinator.successDraws[step.id, default: 0])
                .padding(.top, 20)
            Text(step.copy.outcomeTitle(outcome))
                .phoneSetupTitle()
                .multilineTextAlignment(.center)
                .padding(.top, 24)
            if !message.isEmpty {
                Text(message)
                    .phoneSetupBody()
                    .multilineTextAlignment(.center)
                    .padding(.top, 10)
            }
            if outcome.isContributing, let sourceId = step.statusSourceId {
                PhoneSetupStatusRow(
                    copy: step.copy,
                    status: coordinator.host?.liveStatus(sourceId: sourceId) ?? PhoneSetupLiveStatus(nil)
                )
                .padding(.top, 28)
            }
            if case .choiceRequired(let mode) = outcome {
                choices(for: mode)
                    .padding(.top, 28)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func choices(for mode: SourceMultiDeviceMode) -> some View {
        VStack(spacing: 10) {
            ForEach(step.choices(for: mode)) { option in
                Button {
                    Task { await coordinator.runCurrentStep(choice: option.choice) }
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: option.choice.symbol)
                            .font(.title3)
                            .foregroundStyle(tint.ink)
                            .frame(width: 28)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(option.title)
                                .font(.headline)
                                .foregroundStyle(PhoneSetupPalette.textPrimary)
                            Text(option.detail)
                                .font(.footnote)
                                .foregroundStyle(PhoneSetupPalette.textSecondary)
                                .multilineTextAlignment(.leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 0)
                    }
                    .phoneSetupCard(padding: 14)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(coordinator.busyStepId != nil)
            }
        }
    }
}

/// A ring around a glyph. A source that is on gets its tint, with the ring
/// drawn in whenever the outcome becomes a success, whether the page opened on
/// it or it changed in place; anything else stays neutral. Without motion the
/// ring is simply drawn.
struct PhoneSetupOutcomeMark: View {
    let outcome: PhoneSetupOutcome
    let tint: PhoneSetupTint

    @Environment(\.phoneSetupMotion) private var motion
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Whether the ring has been drawn in for the current success.
    @State private var drawn = false

    var body: some View {
        let progress: CGFloat = outcome.isContributing && canAnimate && !drawn ? 0 : 1
        ZStack {
            Circle()
                .stroke(ring.opacity(0.2), lineWidth: 6)
            Circle()
                .trim(from: 0, to: progress)
                .stroke(ring, style: StrokeStyle(lineWidth: 6, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Image(systemName: symbol)
                .font(.system(size: 34, weight: .bold))
                .foregroundStyle(glyph)
                .opacity(progress)
                .scaleEffect(0.6 + 0.4 * progress)
        }
        .frame(width: 92, height: 92)
        .onAppear(perform: drawIn)
        .accessibilityHidden(true)
    }

    private var canAnimate: Bool {
        motion && !reduceMotion
    }

    /// Draws a success in as the mark appears. The page gives the mark a new
    /// identity each time the step's outcome becomes a success, so a success
    /// reached in place appears, and draws in, like one the page opened on.
    private func drawIn() {
        guard outcome.isContributing, !drawn else { return }
        guard canAnimate else {
            drawn = true
            return
        }
        withAnimation(.easeOut(duration: 0.9)) { drawn = true }
    }

    private var ring: Color {
        switch outcome {
        case .on, .limited, .partial, .choiceRequired: tint.fill
        case .failed: PhoneSetupPalette.danger
        case .unavailable: PhoneSetupPalette.warning
        case .notAllowed, .skipped: PhoneSetupPalette.textMuted
        }
    }

    private var glyph: Color {
        switch outcome {
        case .on, .limited, .partial: PhoneSetupPalette.textPrimary
        case .choiceRequired: tint.ink
        case .failed, .notAllowed, .unavailable, .skipped: ring
        }
    }

    private var symbol: String {
        switch outcome {
        case .on, .limited, .partial, .skipped: "checkmark"
        case .notAllowed: "lock.fill"
        case .unavailable: "exclamationmark.triangle.fill"
        case .choiceRequired: "arrow.triangle.branch"
        case .failed: "exclamationmark"
        }
    }
}

/// An outcome's actions: at most one secondary action, then Next.
struct PhoneSetupOutcomeActions: View {
    let coordinator: PhoneSetupCoordinator
    let step: any PhoneSetupStep
    let outcome: PhoneSetupOutcome

    @Environment(\.phoneSetupPromptVisible) private var promptVisibleOverride
    /// The title of the secondary action running the step again, if one is.
    @State private var runningAction: String?

    var body: some View {
        VStack(spacing: 10) {
            if let instruction = settingsInstruction {
                Text(instruction)
                    .phoneSetupFinePrint()
            }
            if let action = secondaryAction {
                Button {
                    Task {
                        runningAction = action.title
                        await action.run()
                        runningAction = nil
                    }
                } label: {
                    if isBusy, runningAction == action.title, let busyTitle = action.busyTitle {
                        PhoneSetupBusyLabel(text: busyTitle, onPrimary: false)
                    } else {
                        Text(action.title)
                    }
                }
                .buttonStyle(PhoneSetupOutlineButtonStyle())
                .allowsHitTesting(coordinator.busyStepId == nil)
            }
            if isBusy, runningAction == nil {
                // The step is running again, as after coming back from Settings
                // or picking a choice.
                Button {} label: {
                    PhoneSetupBusyLabel(text: promptVisible ? PhoneSetupBusyLabel.waitingForIOS : step.copy.turningOnLabel)
                }
                .buttonStyle(PhoneSetupPrimaryButtonStyle())
                .allowsHitTesting(false)
            } else if !awaitsChoice {
                // A choice is answered by picking one of its options.
                Button(nextTitle) { coordinator.next() }
                    .buttonStyle(PhoneSetupPrimaryButtonStyle())
                    .disabled(coordinator.busyStepId != nil)
            }
        }
    }

    private var visuals: (any PhoneSetupStepVisuals)? {
        step as? any PhoneSetupStepVisuals
    }

    private var isBusy: Bool {
        coordinator.busyStepId == step.id
    }

    private var promptVisible: Bool {
        promptVisibleOverride ?? SystemPromptActivity.shared.isPromptUp
    }

    /// What to change in iOS Settings, shown only above Open Settings.
    private var settingsInstruction: String? {
        guard step.outcomeOffersSettings, visuals?.outcomeAction(for: outcome) == nil else { return nil }
        return step.settingsInstruction(for: outcome)
    }

    private var nextTitle: String {
        guard coordinator.flow.isOnLastStep else { return "Next" }
        return coordinator.presentation == .settingsStep ? "Done" : "Finish"
    }

    /// A choice with options to pick is answered by picking one; one this
    /// step offers no options for can only be moved past.
    private var awaitsChoice: Bool {
        guard case .choiceRequired(let mode) = outcome else { return false }
        return !step.choices(for: mode).isEmpty
    }

    private var secondaryAction: PhoneSetupOutcomeAction? {
        if let action = visuals?.outcomeAction(for: outcome) {
            return action
        }
        switch outcome {
        case .partial, .notAllowed:
            guard step.outcomeOffersSettings else { return nil }
            return PhoneSetupOutcomeAction(title: "Open Settings") {
                coordinator.didOpenSettings()
                Self.openAppSettings()
            }
        case .failed:
            return PhoneSetupOutcomeAction(title: "Try again", busyTitle: "Trying again…") {
                await coordinator.runCurrentStep()
            }
        case .on, .limited, .unavailable, .choiceRequired, .skipped:
            return nil
        }
    }

    static func openAppSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

/// A spinner with the words saying what it waits for; a busy button is never
/// a bare spinner.
struct PhoneSetupBusyLabel: View {
    static let waitingForIOS = "Waiting for iOS…"

    let text: String
    var onPrimary = true

    var body: some View {
        HStack(spacing: 10) {
            ProgressView()
                .tint(onPrimary ? .white : PhoneSetupPalette.textPrimary)
            Text(text)
        }
    }
}

#if DEBUG
#Preview("Phone setup — Photos step") {
    PhoneSetupPreview.view(screen: .step(index: 0), selection: [PhotosSetupStep.sourceId])
}

#Preview("Phone setup — Apple Health on") {
    PhoneSetupPreview.view(
        screen: .step(index: 0),
        selection: [AppleHealthSetupStep.sourceId],
        outcomes: [AppleHealthSetupStep.sourceId: .on]
    )
}

#Preview("Phone setup — waiting for iOS") {
    PhoneSetupView(
        coordinator: PhoneSetupPreview.coordinator(
            screen: .step(index: 0),
            selection: [PlacesSetupStep.sourceId],
            busyStepId: PlacesSetupStep.sourceId
        )
    )
    .environment(\.phoneSetupPromptVisible, true)
    .omnesisColorScheme()
}

#Preview("Phone setup — choice required") {
    PhoneSetupPreview.view(
        screen: .step(index: 0),
        selection: [PhotosSetupStep.sourceId],
        outcomes: [PhotosSetupStep.sourceId: .choiceRequired(.exclusive)]
    )
}

#Preview("Phone setup — background refresh") {
    let host = PhoneSetupPreviewHost()
    host.backgroundRefreshStatus = .denied
    host.isLowPowerModeEnabled = true
    return PhoneSetupPreview.view(
        host: host,
        screen: .step(index: 2),
        selection: [AppleHealthSetupStep.sourceId, PhotosSetupStep.sourceId, BackgroundRefreshSetupStep.stepId]
    )
}

#Preview("Phone setup — Settings instruction") {
    let host = PhoneSetupPreviewHost()
    host.photosAccess = .denied
    return PhoneSetupPreview.view(
        host: host,
        screen: .step(index: 0),
        selection: [PhotosSetupStep.sourceId],
        outcomes: [PhotosSetupStep.sourceId: .notAllowed]
    )
}

#Preview("Phone setup — continuing after Settings") {
    PhoneSetupView(
        coordinator: PhoneSetupPreview.coordinator(
            screen: .step(index: 0),
            selection: [PlacesSetupStep.sourceId],
            outcomes: [PlacesSetupStep.sourceId: .notAllowed],
            busyStepId: PlacesSetupStep.sourceId
        )
    )
    .environment(\.phoneSetupPromptVisible, false)
    .omnesisColorScheme()
}

#Preview("Phone setup — notifications turning on") {
    PhoneSetupView(
        coordinator: PhoneSetupPreview.coordinator(
            screen: .step(index: 0),
            selection: [NotificationsSetupStep.stepId],
            busyStepId: NotificationsSetupStep.stepId
        )
    )
    .environment(\.phoneSetupPromptVisible, false)
    .omnesisColorScheme()
}

#Preview("Notifications — step page") {
    PhoneSetupPreview.view(screen: .step(index: 0), selection: [NotificationsSetupStep.stepId])
}

#Preview("Phone setup — Places not allowed, light") {
    PhoneSetupPreview.view(
        screen: .step(index: 0),
        selection: [PlacesSetupStep.sourceId],
        outcomes: [PlacesSetupStep.sourceId: .notAllowed]
    )
    .preferredColorScheme(.light)
}
#endif
#endif
