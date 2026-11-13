// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if DEBUG && OMNESIS_REALTIME_VOICE && targetEnvironment(simulator)
import Foundation
import Observation
import SwiftUI

/// Bounded simulator-only scenes for XCUI. Release and the normal app do not compile these scripted ports.
@available(iOS 17.0, *)
@MainActor
struct CloudPairingDemoSurface: View {
    enum Scenario: String {
        case google, googleFailure = "google-failure", googleCancel = "google-cancel"
        case approval, approvalRetry = "approval-retry", approvalExpired = "approval-expired", approvalCompleted = "approval-completed"
        case devicesAdmin = "devices-admin", devicesReadOnly = "devices-read-only"
        case status, settings, qr, qrDisabled = "qr-disabled"
    }

    let scenario: Scenario
    @State private var receipt: CloudPairingDemoReceipt
    @State private var approvals: CloudPairingDemoApprovals
    @State private var settingsPath = GatewayConnectionPath.local
    @State private var google: CloudPairingDemoGoogle?
    @State private var unavailable = false
    private let configuration = GoogleCloudPairingConfiguration(
        clientId: "fixture-ios.apps.googleusercontent.com",
        relayOrigin: URL(string: "https://relay.example.test")!
    )

    init(scenario: Scenario) {
        self.scenario = scenario
        let receipt = CloudPairingDemoReceipt()
        _receipt = State(initialValue: receipt)
        _approvals = State(initialValue: CloudPairingDemoApprovals(
            receipt: receipt,
            failFirstRead: scenario == .approvalRetry,
            expired: scenario == .approvalExpired,
            completed: scenario == .approvalCompleted
        ))
    }

    var body: some View {
        Group {
            switch scenario {
            case .google, .googleFailure, .googleCancel:
                if let google {
                    GoogleCloudPairingView(configuration: configuration, model: google.model)
                        .environment(google.store)
                } else if unavailable {
                    Text("Fixture unavailable").accessibilityIdentifier("cloud.fixture.unavailable")
                } else { ProgressView() }
            case .approval, .approvalRetry, .approvalExpired, .approvalCompleted:
                GatewayPairingApprovalView(client: approvals)
                    .environment(AppStore.preview())
            case .devicesAdmin, .devicesReadOnly:
                NavigationStack {
                    GatewayPairingRequestsButton(scopes: scenario == .devicesAdmin ? ["read", "admin"] : ["read"], client: approvals)
                        .navigationTitle("Device access")
                }.environment(AppStore.preview())
            case .status:
                ScrollView {
                    VStack {
                        ForEach([GatewayConnectionPath.local, .relay, .reconnecting], id: \.rawValue) { GatewayConnectionPill(path: $0) }
                        DeviceCard(device: row("Relay row", path: "relay"), tokens: [])
                        DeviceCard(device: row("Revoked row", path: "relay", revoked: true), tokens: [])
                        DeviceCard(device: row("Unknown row", path: "unrecognized"), isThis: true, tokens: [])
                        DeviceCard(device: row("Missing row", path: nil), isThis: true, tokens: [])
                    }.padding()
                }.environment(AppStore.preview())
            case .settings:
                VStack {
                    HStack {
                        Button("Show local") { settingsPath = .local }
                        Button("Show relay") { settingsPath = .relay }
                        Button("Show reconnecting") { settingsPath = .reconnecting }
                    }
                    SettingsView(initialDestination: .root, previewData: true)
                        .environment(AppStore.preview(
                            pairedDeviceId: "fixture-phone",
                            wsState: settingsPath == .reconnecting ? .connecting : .connected(
                                deviceId: "fixture-phone",
                                deviceName: "Test phone",
                                scopes: ["read"]
                            ),
                            connectionPath: settingsPath
                        ))
                        .id(settingsPath.rawValue)
                }
            case .qr, .qrDisabled:
                PairingView(googleConfiguration: scenario == .qr ? configuration : nil).environment(AppStore.preview())
            }
        }
        .safeAreaInset(edge: .bottom) {
            VStack {
                Text(receipt.value).font(.caption).accessibilityIdentifier("cloud.fixture.receipt")
                Text("Approval reads: \(receipt.reads)").font(.caption).accessibilityIdentifier("cloud.fixture.reads")
            }
        }
        .task {
            if [.google, .googleFailure, .googleCancel].contains(scenario) {
                do {
                    google = try CloudPairingDemoGoogle(scenario: scenario, receipt: receipt)
                } catch {
                    unavailable = true
                }
            }
        }
    }

    private func row(_ name: String, path: String?, revoked: Bool = false) -> DeviceRecord {
        .init(id: name, name: name, kind: "ios", pairedAt: 1000, revokedAt: revoked ? 2000 : nil, online: true, connectionPath: path)
    }
}

@available(iOS 17.0, *)
@MainActor @Observable
final class CloudPairingDemoReceipt {
    var value = "No operation"
    var reads = 0
}

@available(iOS 17.0, *)
private actor CloudPairingDemoApprovals: GatewayPairingApproving {
    let receipt: CloudPairingDemoReceipt
    let failFirstRead: Bool
    let expired: Bool
    let completed: Bool
    private var reads = 0
    private var decided = false
    init(receipt: CloudPairingDemoReceipt, failFirstRead: Bool = false, expired: Bool = false, completed: Bool = false) {
        self.receipt = receipt
        self.failFirstRead = failFirstRead
        self.expired = expired
        self.completed = completed
    }

    func pairingApprovalRequests() async throws -> [GatewayPairingApprovalRequest] {
        reads += 1
        let count = reads
        await MainActor.run { receipt.reads = count }
        if failFirstRead, reads == 1 { throw URLError(.notConnectedToInternet) }
        if decided { return [] }
        return [.init(
            requestId: "00000000-0000-4000-8000-000000000941",
            kind: "ios",
            name: "Test new phone",
            status: completed ? "approved" : "pending",
            verificationCode: "465 774",
            expiresAt: Date().addingTimeInterval(expired ? -600 : 600).timeIntervalSince1970 * 1000
        )]
    }

    func decidePairingApproval(requestId: String, approve: Bool) async throws {
        guard requestId == "00000000-0000-4000-8000-000000000941", !decided else { throw CloudPairingError.response }
        decided = true
        await MainActor.run { receipt.value = approve ? "Device approved" : "Device rejected" }
    }
}

@available(iOS 17.0, *)
@MainActor
private final class CloudPairingDemoGoogle {
    let model: GoogleCloudPairingCoordinator
    let store: AppStore
    private let vault: InMemoryStore

    init(scenario: CloudPairingDemoSurface.Scenario, receipt: CloudPairingDemoReceipt) throws {
        let vault = InMemoryStore()
        self.vault = vault
        struct Fixture: Decodable { let clock: Double
            let gateway: GoogleGatewayBinding
        }
        guard let path = Bundle.main.url(forResource: "cloud-ui-gateway", withExtension: "json")
        else { throw CloudPairingError.configuration }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: path))
        let challenge = try CloudPairingChallenge(name: "Test new phone")
        // As the client returns it: the fixture gateway's challenge taken and its first reply checked.
        var pending = try CloudPairingConfirmation(challenge: challenge, candidate: fixture.gateway, now: fixture.clock)
        try pending.commit(to: PairingComparisonCode.commitment(codeNonce: CloudPairingDemoSession.codeNonce))
        try pending.receive(CloudPairingDemoSession.reply(pending, status: "pending", now: fixture.clock), now: fixture.clock)
        let confirmed = pending
        let exchange = CloudPairingDemoExchange(fail: scenario == .googleFailure, receipt: receipt)
        let service = PairingService(
            store: vault,
            exchange: exchange,
            keyPinnedExchangeBuilder: { _, _ in exchange },
            directDiscovery: CloudPairingDemoHints()
        )
        OmnesisURLSession._setStore(vault)
        store = AppStore(
            service: service,
            healthSettings: HealthSettings(defaults: DictionaryDefaults()),
            photosSettings: PhotosSettings(defaults: DictionaryDefaults()),
            foregroundConversationStore: ForegroundConversationStore(),
            phoneSetupProgress: PhoneSetupProgressStore(defaults: DictionaryDefaults()),
            localSourceActivator: LocalSourceActivator(defaults: DictionaryDefaults()),
            localSourceOwner: LocalSourceOwnerRecord(defaults: DictionaryDefaults()),
            notificationWarningDefaults: DictionaryDefaults(),
            loadPersistedPairing: false
        )
        model = GoogleCloudPairingCoordinator(
            browser: CloudPairingDemoBrowser(waitForCancel: scenario == .googleCancel, receipt: receipt),
            makeChallenge: { challenge },
            makeTransport: { CloudPairingDemoProvider() },
            makeClient: { _, _ in CloudPairingDemoSession(pending: confirmed, now: fixture.clock) },
            sleep: {},
            now: { fixture.clock }
        )
    }
}

@MainActor
private final class CloudPairingDemoBrowser: GooglePairingBrowser {
    let waitForCancel: Bool
    let receipt: CloudPairingDemoReceipt
    private var continuation: CheckedContinuation<URL, Error>?
    init(waitForCancel: Bool, receipt: CloudPairingDemoReceipt) {
        self.waitForCancel = waitForCancel
        self.receipt = receipt
    }

    func signIn(_ authorization: GoogleNativeAuthorization) async throws -> URL {
        receipt.value = "System browser started"
        if waitForCancel { return try await withCheckedThrowingContinuation { continuation = $0 } }
        guard let url = URL(string: "\(authorization.redirectURI)?state=\(authorization.state)&code=synthetic-ui-code")
        else { throw CloudPairingError.response }
        return url
    }

    func cancel() {
        guard let pending = continuation else { return }
        continuation = nil
        receipt.value = "System browser canceled"
        pending.resume(throwing: CancellationError())
    }
}

private final class CloudPairingDemoProvider: CloudPairingTransport, @unchecked Sendable {
    func requestData(url: URL, method: String, body: Data?, bearer: String?, form: Bool) async throws -> Data {
        guard url.absoluteString == "https://oauth2.googleapis.com/token", method == "POST", form else { throw CloudPairingError.response }
        return Data(#"{"id_token":"presentation-port-token","token_type":"Bearer"}"#.utf8)
    }

    func close() {}
}

private actor CloudPairingDemoSession: GooglePairingSession {
    let pending: CloudPairingConfirmation
    let now: TimeInterval
    init(pending: CloudPairingConfirmation, now: TimeInterval) {
        self.pending = pending
        self.now = now
    }

    func start(challenge: CloudPairingChallenge, idToken: String) async throws -> CloudPairingConfirmation {
        guard challenge.requestId == pending.challenge.requestId,
              idToken == "presentation-port-token" else { throw CloudPairingError.response }
        return pending
    }

    func poll() async throws -> CloudPairingProgress {
        try Self.reply(pending, status: "approved", now: now)
    }

    /// The fixture gateway's part of the comparison code.
    static let codeNonce = String(repeating: "n", count: 43)

    static func reply(_ pending: CloudPairingConfirmation, status: String, now: TimeInterval) throws -> CloudPairingProgress {
        try CloudPairingProgress(
            status: status,
            verificationCode: pending.challenge.comparisonCode(fingerprint: pending.fingerprint, codeNonce: codeNonce),
            codeNonce: codeNonce,
            expiresAt: (now + 300) * 1000,
            pairingCode: status == "approved" ? "TEST-UI-CODE" : nil
        )
    }

    func close() async {}
}

private actor CloudPairingDemoExchange: PairingExchangeHTTP {
    let fail: Bool
    let receipt: CloudPairingDemoReceipt
    init(fail: Bool, receipt: CloudPairingDemoReceipt) {
        self.fail = fail
        self.receipt = receipt
    }

    func exchange(gatewayUrl: URL, pairingCode: String, capabilities: PairingCapabilities) async throws -> DevicePairResponse {
        guard gatewayUrl.absoluteString == "https://gateway.localhost:9",
              pairingCode == "TEST-UI-CODE" else { throw CloudPairingError.response }
        if fail { await MainActor.run { receipt.value = "Pair exchange failed" }
            throw URLError(.notConnectedToInternet)
        }
        await MainActor.run { receipt.value = "Pair exchange completed" }
        return .init(
            device: .init(id: "test-new-phone", name: "Test phone", kind: "ios"),
            tokenId: "ui-issued-generation",
            token: "ui-test-device-token",
            scopes: ["read"]
        )
    }
}

private struct CloudPairingDemoHints: GatewayDirectDiscovering {
    func fetch(origin: URL, token: String, spkiFingerprint: String) async throws -> [GatewayDirectCandidate] {
        []
    }
}
#endif
