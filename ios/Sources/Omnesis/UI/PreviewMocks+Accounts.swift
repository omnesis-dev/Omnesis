// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

extension PreviewMocks {
    static let accountGatewayChoices = [
        AccountGatewayChoice(
            gatewayId: "00000000-0000-4000-8000-000000000001",
            publicOrigin: "https://home.example.test",
            displayName: "Fictional home"
        ),
        AccountGatewayChoice(
            gatewayId: "00000000-0000-4000-8000-000000000002",
            publicOrigin: "https://studio.example.test",
            displayName: "Fictional studio gateway with a long display name"
        ),
        AccountGatewayChoice(
            gatewayId: "00000000-0000-4000-8000-000000000003",
            publicOrigin: "https://g-00000000000040008000000000000003.relay.example.test",
            displayName: nil
        ),
    ]
    static let accountCloudPairingConfiguration = AccountCloudPairingConfiguration(
        relayOrigin: googleCloudPairingConfiguration.relayOrigin,
        google: googleCloudPairingConfiguration,
        passkeysEnabled: true
    )
    private static func joinedMillisAgo(_ seconds: TimeInterval) -> Int64 {
        Int64((Date().timeIntervalSince1970 - seconds) * 1000)
    }

    static let deviceJoinedWithGoogle = DeviceRecord(
        id: "dev-ios-3",
        name: "Maya's iPad",
        kind: "ios",
        pairedAt: joinedMillisAgo(3600),
        lastSeenAt: joinedMillisAgo(60),
        online: true,
        enrollment: DeviceEnrollmentInfo(method: "automatic", signIn: "google", joinedAt: joinedMillisAgo(3600))
    )
    static let deviceJoinedWithPasskey = DeviceRecord(
        id: "dev-ios-4",
        name: "Studio iPhone",
        kind: "ios",
        pairedAt: joinedMillisAgo(86400 * 6),
        lastSeenAt: joinedMillisAgo(300),
        online: true,
        enrollment: DeviceEnrollmentInfo(method: "automatic", signIn: "passkey", joinedAt: joinedMillisAgo(86400 * 6))
    )
    static let deviceApprovedAfterSignIn = DeviceRecord(
        id: "dev-ios-5",
        name: "Jamie's iPhone with a long device name",
        kind: "ios",
        pairedAt: joinedMillisAgo(86400 * 12),
        lastSeenAt: joinedMillisAgo(900),
        online: true,
        enrollment: DeviceEnrollmentInfo(method: "approved", signIn: "google", joinedAt: joinedMillisAgo(86400 * 12))
    )
    static let devicesWithSignInJoins = [deviceJoinedWithGoogle, deviceJoinedWithPasskey, deviceApprovedAfterSignIn] + devices
    static let pairingRequestsWithTrust = PreviewPairingRequests(rows: [
        GatewayPairingApprovalRequest(
            requestId: "00000000-0000-4000-8000-000000000951",
            kind: "ios",
            name: "Maya's new iPad",
            status: "pending",
            verificationCode: "465 774",
            expiresAt: (Date().timeIntervalSince1970 + 86400) * 1000,
            signIn: "google",
            canTrustSignIn: true,
            signInEmail: "maya@example.com",
            rememberByDefault: true
        ),
    ])

    static let pairingRequestsSeveral = PreviewPairingRequests(rows: pairingRequestsWithTrust.rows + [
        GatewayPairingApprovalRequest(
            requestId: "00000000-0000-4000-8000-000000000952",
            kind: "android",
            name: "Jamie's Pixel",
            status: "pending",
            verificationCode: "081 434",
            expiresAt: (Date().timeIntervalSince1970 + 86400) * 1000,
            signIn: "passkey",
            canTrustSignIn: false
        ),
    ])

    /// A laptop the owner removed before, back and asking again.
    static let pairingRequestRevoked = PreviewPairingRequests(rows: [
        GatewayPairingApprovalRequest(
            requestId: "00000000-0000-4000-8000-000000000953",
            kind: "portal",
            name: "Studio MacBook",
            status: "pending",
            verificationCode: "208 517",
            expiresAt: (Date().timeIntervalSince1970 + 86400) * 1000,
            signIn: "google",
            canTrustSignIn: false,
            revokedDevice: true
        ),
    ])

    struct PreviewPairingRequests: GatewayPairingApproving {
        let rows: [GatewayPairingApprovalRequest]
        /// The body of the gateway's 428 to an approval; nil approves.
        var stepUpBody: String?
        func pairingApprovalRequests() async throws -> [GatewayPairingApprovalRequest] {
            rows
        }

        func decidePairingApproval(requestId: String, approve: Bool) async throws {
            if approve, let stepUpBody { throw GatewayClient.Error.serverError(status: 428, body: stepUpBody) }
        }

        func approvalPage(requestId: String) -> URL? {
            URL(string: "https://g-1.relay.example.test/portal/approve#\(requestId)")
        }
    }

    /// An administrator's client that can also make every new device ask first.
    struct PreviewPairingPolicy: GatewayPairingApproving, CloudRelayManaging {
        func pairingApprovalRequests() async throws -> [GatewayPairingApprovalRequest] {
            []
        }

        func decidePairingApproval(requestId: String, approve: Bool) async throws {}

        func cloudRelayStatus() async throws -> CloudRelayStatus {
            PreviewMocks.cloudRelayConnected
        }

        func cloudRelay(_: CloudRelayOperation) async throws -> CloudRelayStatus {
            PreviewMocks.cloudRelayConnected
        }
    }

    /// The gateway asks this phone to confirm it's the owner before it approves.
    static let pairingRequestsNeedingStepUp = PreviewPairingRequests(
        rows: pairingRequestsWithTrust.rows,
        stepUpBody: #"{"error":"Confirm this action first.","code":"STEP_UP_REQUIRED"}"#
    )

    static func accountPairingPanel(
        _ phase: AccountCloudPairingCoordinator.Phase,
        approved: Bool = false,
        error: AccountPairingError? = nil,
        approvalPage: Bool = false,
        continues: Bool = true,
        approvedHeld: Bool = false
    )
        -> AccountCloudPairingPanel {
        AccountCloudPairingPanel(
            phase: phase,
            gateways: accountGatewayChoices,
            verificationCode: phase == .comparing || phase == .pairing || approvedHeld ? "003 579" : nil,
            gatewayHost: phase == .comparing || phase == .pairing ? "home.example.test" : nil,
            approved: approved || phase == .pairing,
            error: error ?? (phase == .failed ? AccountPairingError.noGateways : nil),
            googleAvailable: true,
            passkeysAvailable: true,
            onGoogle: {},
            onPasskey: {},
            onChoose: { _ in },
            onPair: {},
            onScan: {},
            onManual: {},
            approvalPageAvailable: approvalPage,
            expiresAt: Date().addingTimeInterval(272),
            continuesOnApproval: continues
        )
    }

    /// The held screen alone, four and a half minutes before the gateway stops waiting.
    static func accountPairingWaiting(
        approved: Bool = false,
        approvalPage: Bool = false,
        continues: Bool = true
    )
        -> AccountPairingWaitingView {
        AccountPairingWaitingView(
            code: "465 774",
            approved: approved,
            pairing: false,
            expiresAt: Date().addingTimeInterval(272),
            continuesOnApproval: continues,
            approvalPageAvailable: approvalPage,
            onApprovalPage: {},
            onPair: {},
            onCancel: {}
        )
    }
}
#endif
