// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// A short explanation under a control, where the portal uses a tooltip.
@available(iOS 17.0, *)
struct OmnesisAccountFootnote: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundStyle(Theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A secondary action of a section.
@available(iOS 17.0, *)
struct OmnesisAccountSecondaryButton: View {
    let title: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title).font(.subheadline.weight(.semibold))
        }
        .buttonStyle(.bordered)
        .tint(Theme.accent)
    }
}

/// What is wrong, in one box: a sentence per problem and the details to paste when asking for help.
/// `messages` may be empty when the headline already says what is wrong; the details are still offered.
@available(iOS 17.0, *)
struct OmnesisAccountProblems: View {
    let messages: [String]
    /// Built when copied, so the block carries the time of the tap.
    let details: () -> String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.sm) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Theme.warning)
                    .accessibilityHidden(true)
                Text(CloudRelayPresentation.problemsTitle(count: messages.count))
                    .font(.headline)
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
            }
            ForEach(messages, id: \.self) { message in
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            OmnesisAccountFootnote(text: CloudRelayPresentation.problemsHelp)
            OmnesisAccountSecondaryButton(title: copied ? "Copied" : "Copy details") {
                UIPasteboard.general.string = details()
                copied = true
            }
            .accessibilityIdentifier("omnesisAccount.copyDetails")
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.warning.opacity(0.12), in: RoundedRectangle(cornerRadius: Theme.Radius.large, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.large, style: .continuous).stroke(Theme.warning, lineWidth: 1))
        .accessibilityIdentifier("omnesisAccount.problems")
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }
}

/// Whether this gateway is on the person's Omnesis account, with the way to manage the account or leave it.
@available(iOS 17.0, *)
struct OmnesisAccountLinkSection: View {
    let status: CloudRelayStatus
    let busy: Bool
    var unlinking = false
    let onManage: () -> Void
    let confirm: (OmnesisAccountConfirmation) -> Void

    var body: some View {
        if CloudRelayPresentation.accountShown(status) {
            FlatSection("Account") {
                Text(CloudRelayPresentation.accountLine(status))
                    .font(.body)
                    .foregroundStyle(Theme.textPrimary)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(CloudRelayPresentation.accountHints(status), id: \.self) { OmnesisAccountFootnote(text: $0) }
                if CloudRelayPresentation.accountLinked(status) { actions }
            }
        }
    }

    @ViewBuilder
    private var actions: some View {
        let omnesis = CloudRelayPresentation.usesOmnesisAccount(status)
        if CloudRelayPresentation.accountPageURL(relayUrl: status.config?.relayUrl) != nil {
            OmnesisAccountSecondaryButton(title: CloudRelayPresentation.manageAccount, action: onManage)
                .accessibilityIdentifier("omnesisAccount.manage")
        }
        if omnesis ? status.account?.canUnlink == true : status.google?.canUnlink == true {
            Button(unlinking ? CloudRelayPresentation.unlinking : CloudRelayPresentation.unlink, role: .destructive) {
                confirm(omnesis ? .unlinkAccount : .unlinkGoogle)
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Theme.danger)
            .buttonStyle(.plain)
            .frame(minHeight: Theme.tapTarget)
            .disabled(busy)
            .accessibilityIdentifier("omnesisAccount.unlink")
        }
    }
}

/// The public address, whether it answers, and the switch that stops access from outside.
/// While remote access is off the headline's own button turns it back on.
@available(iOS 17.0, *)
struct OmnesisAccountRemoteAccessSection: View {
    let status: CloudRelayStatus
    let busy: CloudRelayOperation?
    let perform: (CloudRelayOperation) -> Void

    var body: some View {
        let address = status.publicMcp?.url
        if address != nil || status.enabled {
            FlatSection("Remote access") {
                if let address { addressRow(address) }
                if status.enabled {
                    OmnesisAccountSecondaryButton(title: busy == .disable ? "Turning off…" : "Turn off") { perform(.disable) }
                        .disabled(busy != nil || status.can?.disable != true)
                        .accessibilityIdentifier("omnesisAccount.turnOff")
                    OmnesisAccountFootnote(text: CloudRelayPresentation.turnOffFootnote)
                }
            }
        }
    }

    private func addressRow(_ address: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(alignment: .center, spacing: Theme.Spacing.sm) {
                Text(address)
                    .font(Theme.monospace(size: 14))
                    .foregroundStyle(Theme.textPrimary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                OmnesisAccountCopyButton(text: address, label: "Copy address")
            }
            if let state = CloudRelayPresentation.addressState(status) { OmnesisAccountFootnote(text: state) }
        }
    }
}

/// What happens when a new device signs in.
@available(iOS 17.0, *)
struct OmnesisAccountNewDevicesSection: View {
    let enrollment: CloudRelayStatus.DeviceEnrollment
    let busy: Bool
    let perform: (CloudRelayOperation) -> Void

    var body: some View {
        FlatSection("New devices") {
            OmnesisAccountFootnote(text: "What happens when a new device signs in to your Omnesis account.")
            ForEach(CloudRelayPresentation.policyChoices) { option($0) }
        }
    }

    private func option(_ choice: CloudRelayPresentation.PolicyChoice) -> some View {
        let selected = enrollment.policy == choice.id
        return Button {
            if !selected { perform(.setEnrollmentPolicy(choice.id)) }
        } label: {
            HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.body)
                    .foregroundStyle(selected ? Theme.accent : Theme.textMuted)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(choice.title)
                        .font(.body.weight(.medium))
                        .foregroundStyle(Theme.textPrimary)
                    Text(choice.text)
                        .font(.footnote)
                        .foregroundStyle(Theme.textSecondary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(Theme.Spacing.md)
            .background(Theme.bgSecondary, in: RoundedRectangle(cornerRadius: Theme.Radius.large, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.large, style: .continuous)
                    .stroke(selected ? Theme.accent : Theme.border, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("omnesisAccount.policy.\(choice.id)")
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Omnesis account — problems box") {
    ScrollView {
        VStack(spacing: Theme.Spacing.lg) {
            OmnesisAccountProblems(messages: CloudRelayPresentation.problems(PreviewMocks.cloudRelayProblems), details: { "" })
            OmnesisAccountProblems(messages: [], details: { "" })
        }
        .padding(Theme.Spacing.lg)
    }
    .background(Theme.bgPrimary.ignoresSafeArea())
}
#endif
#endif
