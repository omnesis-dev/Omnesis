// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// How a device came to join, under its name on the Devices screen. It only says so: a
/// device that joined with the Omnesis account has the same actions as any other, in its menu.
@available(iOS 17.0, *)
struct DeviceJoinRow: View {
    let enrollment: DeviceEnrollmentInfo

    var body: some View {
        if let label = DeviceJoinPresentation.joinLabel(enrollment) {
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 22 + Theme.Spacing.sm)
                .accessibilityIdentifier("devices.join.label")
        }
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("Device join row") {
    VStack(alignment: .leading, spacing: Theme.Spacing.md) {
        DeviceJoinRow(enrollment: DeviceEnrollmentInfo(method: "automatic", signIn: "google"))
        DeviceJoinRow(enrollment: DeviceEnrollmentInfo(method: "automatic", signIn: "passkey"))
        DeviceJoinRow(enrollment: DeviceEnrollmentInfo(method: "approved", signIn: "passkey"))
    }
    .padding(Theme.Spacing.lg)
    .background(Theme.bgPrimary)
}
#endif
#endif
