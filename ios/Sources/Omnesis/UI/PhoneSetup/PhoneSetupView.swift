// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
import UIKit

/// Phone setup, full screen: Connected, Choose, one page per selected step,
/// then Finish. Everything it shows comes from the coordinator and the steps it
/// holds, so the same view runs over the live app and over preview hosts.
struct PhoneSetupView: View {
    let coordinator: PhoneSetupCoordinator

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.phoneSetupMotion) private var motion
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            PhoneSetupBackdrop(tint: tint)
                .animation(animates ? .easeInOut(duration: 0.6) : nil, value: tint)
            page
                .id(pageKey)
                .transition(.opacity)
        }
        .animation(animates ? .easeInOut(duration: 0.25) : nil, value: pageKey)
        .onChange(of: scenePhase) { _, phase in
            // Permission state can change while the app is in the background,
            // most often in iOS Settings, so it is re-read on every return.
            guard phase == .active else { return }
            Task { await coordinator.refreshLiveState() }
        }
        // Background App Refresh and Low Power Mode can change while the app
        // stays in the foreground.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.backgroundRefreshStatusDidChangeNotification)) { _ in
            coordinator.hostStateDidChange()
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSProcessInfoPowerStateDidChange)) { _ in
            // Posted on an arbitrary thread.
            Task { @MainActor in coordinator.hostStateDidChange() }
        }
    }

    private var animates: Bool {
        motion && !reduceMotion
    }

    private var tint: PhoneSetupTint {
        guard case .step = coordinator.flow.screen, let step = coordinator.currentStep else { return .brand }
        return PhoneSetupTint(hex: step.copy.tint)
    }

    private var pageKey: String {
        switch coordinator.flow.screen {
        case .connected: "connected"
        case .choose: "choose"
        case .step(let index): "step-\(index)"
        case .finish: "finish"
        }
    }

    @ViewBuilder
    private var page: some View {
        switch coordinator.flow.screen {
        case .connected:
            PhoneSetupConnectedPage(coordinator: coordinator)
        case .choose:
            PhoneSetupChoosePage(coordinator: coordinator)
        case .step:
            if let step = coordinator.currentStep {
                PhoneSetupStepPage(coordinator: coordinator, step: step)
            }
        case .finish:
            PhoneSetupFinishPage(coordinator: coordinator)
        }
    }
}

extension View {
    /// Presents a run opened from Settings full screen while `coordinator`
    /// presents one of `presentations`, reports when the cover is on screen,
    /// and releases the presentation gate once it has finished dismissing.
    func phoneSetupCover(
        _ coordinator: PhoneSetupCoordinator,
        presentations: Set<PhoneSetupCoordinator.Presentation>
    )
        -> some View {
        fullScreenCover(
            isPresented: Binding(
                get: { coordinator.presentation.map(presentations.contains) == true },
                set: { _ in }
            ),
            onDismiss: { coordinator.presentationDidEnd() },
            content: {
                PhoneSetupView(coordinator: coordinator)
                    .onAppear { coordinator.presentationDidAppear() }
                    .omnesisColorScheme()
            }
        )
    }
}

// MARK: - Connected

struct PhoneSetupConnectedPage: View {
    let coordinator: PhoneSetupCoordinator

    var body: some View {
        PhoneSetupPageLayout {
            VStack(alignment: .leading, spacing: 0) {
                PhoneSetupBrandMark()
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                Text("You're connected")
                    .phoneSetupTitle()
                    .padding(.top, 28)
                Text("This iPhone is now paired with your gateway. Nothing has been sent yet. "
                    + "Next, choose what it adds to your index.")
                    .phoneSetupBody()
                    .padding(.top, 10)
                PhoneSetupConnectionDiagram()
                    .padding(.top, 36)
                verifiedCard
                    .padding(.top, 28)
            }
        } actions: {
            VStack(spacing: 12) {
                Button("Choose what to add") { coordinator.continueFromConnected() }
                    .buttonStyle(PhoneSetupPrimaryButtonStyle())
                    .accessibilityIdentifier("phoneSetup.choose")
                Text("Everything here is also in Settings")
                    .phoneSetupFinePrint()
            }
        }
    }

    private var verifiedCard: some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.shield.fill")
                .font(.system(size: 22))
                .foregroundStyle(PhoneSetupPalette.success)
            VStack(alignment: .leading, spacing: 2) {
                Text(coordinator.host?.pairedGatewayHost ?? "Your gateway")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PhoneSetupPalette.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text("Connection verified")
                    .font(.footnote)
                    .foregroundStyle(PhoneSetupPalette.textSecondary)
            }
            Spacer(minLength: 0)
        }
        .phoneSetupCard(padding: 14)
        .accessibilityElement(children: .combine)
    }
}

/// This iPhone and the gateway, joined by a line a dot travels along.
struct PhoneSetupConnectionDiagram: View {
    @Environment(\.phoneSetupMotion) private var motion
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let cycle: TimeInterval = 2.6
    private static let dotSize: CGFloat = 10

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            node(symbol: "iphone", label: "This iPhone", ink: PhoneSetupPalette.textPrimary)
            wire
                .frame(height: 56)
            node(symbol: "server.rack", label: "Your gateway", ink: PhoneSetupTint.brand.ink)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("This iPhone is connected to your gateway")
    }

    private func node(symbol: String, label: String, ink: Color) -> some View {
        VStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(PhoneSetupPalette.card)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(PhoneSetupPalette.cardBorder, lineWidth: 1)
                )
                .overlay(
                    Image(systemName: symbol)
                        .font(.system(size: 24))
                        .foregroundStyle(ink)
                )
                .frame(width: 56, height: 56)
            Text(label)
                .font(.footnote)
                .foregroundStyle(PhoneSetupPalette.textSecondary)
                .fixedSize()
        }
        .frame(minWidth: 88)
    }

    private var wire: some View {
        GeometryReader { proxy in
            let travel = max(0, proxy.size.width - Self.dotSize)
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [PhoneSetupPalette.cardBorder, LandingPalette.markMid, PhoneSetupPalette.cardBorder],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(height: 2)
                if motion, !reduceMotion {
                    TimelineView(.animation) { timeline in
                        let phase = timeline.date.timeIntervalSinceReferenceDate
                            .truncatingRemainder(dividingBy: Self.cycle) / Self.cycle
                        dot
                            .offset(x: travel * phase)
                            .opacity(min(1, min(phase, 1 - phase) * 6))
                    }
                } else {
                    dot.offset(x: travel / 2)
                }
            }
            .frame(maxHeight: .infinity)
        }
    }

    private var dot: some View {
        Circle()
            .fill(Color(hex: 0x9CD4FF))
            .frame(width: Self.dotSize, height: Self.dotSize)
            .shadow(color: LandingPalette.markGlow, radius: 6)
    }
}

// MARK: - Choose

struct PhoneSetupChoosePage: View {
    let coordinator: PhoneSetupCoordinator

    var body: some View {
        let selected = coordinator.flow.selection.count
        PhoneSetupPageLayout {
            VStack(alignment: .leading, spacing: 0) {
                Text("What should this iPhone add?")
                    .phoneSetupTitle()
                    .padding(.top, 32)
                Text("Turn on what you want. Each one gets its own page before iOS asks for access.")
                    .phoneSetupBody()
                    .padding(.top, 10)
                rows(for: .source)
                    .padding(.top, 24)
                PhoneSetupSectionLabel(text: "Also")
                    .padding(.top, 24)
                    .padding(.leading, 4)
                rows(for: .also)
                    .padding(.top, 10)
            }
        } actions: {
            VStack(spacing: 2) {
                Button(selected == 0 ? "Set up" : "Set up \(selected)") { coordinator.startSelectedSteps() }
                    .buttonStyle(PhoneSetupPrimaryButtonStyle())
                    .disabled(selected == 0)
                Button("Skip for now") { coordinator.complete() }
                    .buttonStyle(PhoneSetupTextButtonStyle())
                    .accessibilityIdentifier("phoneSetup.skip")
            }
        }
    }

    private func rows(for group: PhoneSetupStepGroup) -> some View {
        // Row state reads operating-system permissions, which only change
        // behind the flow's back; `revision` re-renders rows after they are
        // re-read.
        _ = coordinator.revision
        let ids = coordinator.steps.filter { $0.group == group }.map(\.id)
        return VStack(spacing: 10) {
            ForEach(ids, id: \.self) { id in
                if let step = coordinator.step(id: id) {
                    PhoneSetupChooseRow(step: step, isSelected: coordinator.flow.isSelected(id)) {
                        coordinator.toggle(id)
                    }
                }
            }
        }
    }
}

struct PhoneSetupChooseRow: View {
    let step: any PhoneSetupStep
    let isSelected: Bool
    let onToggle: () -> Void

    var body: some View {
        let tint = PhoneSetupTint(hex: step.copy.tint)
        let state = step.rowState
        // An unavailable row dims its tile and title; its reason stays legible.
        let dimmed = isUnavailable(state) ? 0.5 : 1
        Button(action: onToggle) {
            HStack(spacing: 14) {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(tint.fill.opacity(0.18))
                    .frame(width: 40, height: 40)
                    .overlay(
                        Image(systemName: step.copy.symbol)
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(tint.ink)
                    )
                    .opacity(dimmed)
                VStack(alignment: .leading, spacing: 2) {
                    Text(step.copy.title)
                        .font(.headline)
                        .foregroundStyle(PhoneSetupPalette.textPrimary)
                        .opacity(dimmed)
                    Text(valueLine(state))
                        .font(.footnote)
                        .foregroundStyle(PhoneSetupPalette.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                trailing(state)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(isSelected ? tint.fill.opacity(0.09) : PhoneSetupPalette.card)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(isSelected ? tint.fill.opacity(0.6) : PhoneSetupPalette.cardBorder, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // A row that is already on keeps its full colour; it just takes no taps.
        .allowsHitTesting(state == .selectable)
        .disabled(isUnavailable(state))
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(state == .selectable ? .isToggle : [])
        .accessibilityValue(accessibilityValue(state))
    }

    private func accessibilityValue(_ state: PhoneSetupRowState) -> String {
        switch state {
        case .selectable: isSelected ? "On" : "Off"
        case .alreadyOn: "Already on"
        case .unavailable: ""
        }
    }

    private func valueLine(_ state: PhoneSetupRowState) -> String {
        if case .unavailable(let reason) = state { return reason }
        return step.copy.row
    }

    private func isUnavailable(_ state: PhoneSetupRowState) -> Bool {
        if case .unavailable = state { return true }
        return false
    }

    @ViewBuilder
    private func trailing(_ state: PhoneSetupRowState) -> some View {
        switch state {
        case .selectable:
            PhoneSetupSwitch(isOn: isSelected)
        case .alreadyOn:
            Label("On", systemImage: "checkmark.circle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(PhoneSetupPalette.success)
        case .unavailable:
            EmptyView()
        }
    }
}

// MARK: - Finish

struct PhoneSetupFinishPage: View {
    let coordinator: PhoneSetupCoordinator

    var body: some View {
        let contributed = coordinator.isContributing
        PhoneSetupPageLayout {
            VStack(alignment: .leading, spacing: 0) {
                PhoneSetupBrandTile(size: 56)
                    .padding(.top, 32)
                Text(contributed ? "This iPhone is contributing" : "You're all set")
                    .phoneSetupTitle()
                    .padding(.top, 24)
                Text(
                    contributed
                        ? "Your gateway is indexing what arrives. It keeps going in the background."
                        : "Nothing is coming from this iPhone yet. You can add sources from Settings any time."
                )
                .phoneSetupBody()
                .padding(.top, 10)
                VStack(spacing: 10) {
                    ForEach(rowIds, id: \.self) { id in
                        if let step = coordinator.step(id: id) {
                            row(for: step)
                        }
                    }
                }
                .padding(.top, 24)
            }
        } actions: {
            VStack(spacing: 12) {
                Button("Start asking") { coordinator.complete() }
                    .buttonStyle(PhoneSetupPrimaryButtonStyle())
                if let question = coordinator.suggestedQuestion {
                    Text("Try \u{201C}\(question)\u{201D}")
                        .phoneSetupFinePrint()
                }
            }
        }
    }

    /// Every source this iPhone can host, then the "Also" steps the user chose.
    private var rowIds: [String] {
        coordinator.steps.filter { step in
            switch step.group {
            case .source:
                if case .unavailable = step.rowState { return false }
                return true
            case .also:
                return coordinator.flow.isSelected(step.id)
            case .automatic:
                return false
            }
        }
        .map(\.id)
    }

    private func row(for step: any PhoneSetupStep) -> some View {
        let isOn = step.rowState == .alreadyOn
        let status: PhoneSetupLiveStatus? = if isOn {
            step.statusSourceId.flatMap { coordinator.host?.liveStatus(sourceId: $0) }
                ?? PhoneSetupLiveStatus(headline: "On", kind: .upToDate)
        } else {
            nil
        }
        let offLine = coordinator.flow.outcomes[step.id] == .skipped
            ? PhoneSetupStatusRow.sentByAnotherDevice
            : PhoneSetupStatusRow.notSetUp
        return PhoneSetupStatusRow(copy: step.copy, status: status, offLine: offLine)
    }
}

/// One source's contribution: its live status when on, or why it is not.
struct PhoneSetupStatusRow: View {
    static let notSetUp = "Not set up · Settings"
    static let sentByAnotherDevice = "Sent by another device"

    let copy: PhoneSetupCopy
    let status: PhoneSetupLiveStatus?
    /// What the row says while the source is off here.
    var offLine = notSetUp

    var body: some View {
        let tint = PhoneSetupTint(hex: copy.tint)
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(tint.fill.opacity(0.18))
                .frame(width: 34, height: 34)
                .overlay(
                    Image(systemName: copy.symbol)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(tint.ink)
                )
            VStack(alignment: .leading, spacing: 3) {
                Text(copy.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PhoneSetupPalette.textPrimary)
                Text(line)
                    .font(.footnote)
                    .foregroundStyle(PhoneSetupPalette.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let fraction = status?.fraction {
                    GeometryReader { proxy in
                        ZStack(alignment: .leading) {
                            Capsule().fill(PhoneSetupPalette.progressPending)
                            Capsule().fill(tint.fill).frame(width: proxy.size.width * fraction)
                        }
                    }
                    .frame(height: 3)
                    .padding(.top, 3)
                }
            }
            Spacer(minLength: 8)
            switch status?.kind {
            case .syncing:
                ProgressView()
                    .controlSize(.small)
            case .upToDate:
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(PhoneSetupPalette.success)
                    .accessibilityHidden(true)
            case .attention:
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(PhoneSetupPalette.warning)
                    .accessibilityHidden(true)
            case .notSynced, nil:
                EmptyView()
            }
        }
        .phoneSetupCard(padding: 12)
        .opacity(status == nil ? 0.62 : 1)
        .accessibilityElement(children: .combine)
    }

    private var line: String {
        status?.line ?? offLine
    }
}

#if DEBUG
#Preview("Phone setup — Connected") {
    PhoneSetupPreview.view(screen: .connected)
}

#Preview("Phone setup — Choose") {
    PhoneSetupPreview.view(
        screen: .choose,
        selection: [AppleHealthSetupStep.sourceId, PhotosSetupStep.sourceId, NotificationsSetupStep.stepId]
    )
}

#Preview("Phone setup — Finish, all set") {
    PhoneSetupPreview.view(
        screen: .finish,
        selection: [MovementSetupStep.sourceId],
        outcomes: [MovementSetupStep.sourceId: .notAllowed]
    )
}

#Preview("Phone setup — Finish contributing, light") {
    PhoneSetupPreview.view(
        screen: .finish,
        selection: [AppleHealthSetupStep.sourceId, PhotosSetupStep.sourceId],
        outcomes: [AppleHealthSetupStep.sourceId: .on, PhotosSetupStep.sourceId: .limited]
    )
    .preferredColorScheme(.light)
}
#endif
#endif
