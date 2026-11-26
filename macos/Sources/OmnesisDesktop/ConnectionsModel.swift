// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import DesktopCore
import Foundation
import Observation
import Omnesis

struct DesktopAccessEnvelope: Decodable {
    let overview: AccessOverview
    let oauth: OAuth?
    struct OAuth: Decodable {
        let resource: String
        let resources: [Resource]?
        struct Resource: Decodable { let resource: String
            let certificatePending: Bool?
            let publiclyTrusted: Bool?
        }
    }

    private enum CodingKeys: String, CodingKey { case oauth }
    init(from decoder: Decoder) throws {
        overview = try AccessOverview(from: decoder)
        oauth = try decoder.container(keyedBy: CodingKeys.self).decodeIfPresent(OAuth.self, forKey: .oauth)
    }
}

@MainActor @Observable
final class DesktopConnections {
    var mcpURL: URL?
    var gatewayOrigin: URL?
    var overview: AccessOverview?
    var failure: String?
    var loading = false

    func load(api: DesktopAPI) async {
        guard !loading else { return }
        loading = true
        failure = nil
        defer { loading = false }
        do {
            async let cloudRequest = api.admin.cloudRelayStatus()
            async let accessRequest: DesktopAccessEnvelope = api.request("GET", "admin/access")
            let (cloud, access) = try await (cloudRequest, accessRequest)
            overview = access.overview
            let resources = access.oauth?.resources?.map(\.resource) ?? access.oauth.map { [$0.resource] } ?? []
            let url = try DesktopRelayAddress.mcp(
                enabled: cloud.enabled,
                ready: cloud.publicMcp?.ready == true,
                advertised: cloud.publicMcp?.url,
                authorizedResources: resources
            )
            mcpURL = url
            gatewayOrigin = try DesktopRelayAddress.gatewayOrigin(mcp: url)
        } catch {
            mcpURL = nil
            gatewayOrigin = nil
            failure = error.localizedDescription
        }
    }
}

@MainActor @Observable
final class DesktopPhonePairing {
    var kind = "ios"
    var pending: PendingPairing?
    var payload: String?
    private(set) var observedPhones: [DesktopDevice] = []
    var failure: String?
    var working = false
    var needsBrowserConfirmation = false
    private var generation = UUID()
    private var observation: Task<Void, Never>?
    private var issuedCode: String?

    func start(api: DesktopAPI, gatewayOrigin: URL) async {
        let attempt = UUID()
        generation = attempt
        observation?.cancel()
        payload = nil
        pending = nil
        observedPhones = []
        failure = nil
        needsBrowserConfirmation = false
        working = true
        defer { if generation == attempt { working = false } }
        var minted: PendingPairing?
        do {
            await refreshPhones(api: api)
            guard generation == attempt, !Task.isCancelled else { return }
            let code = try await api.admin.createPairing(kind: kind)
            minted = code
            guard generation == attempt else {
                try? await revoke(code.pairingCode, api: api)
                return
            }
            issuedCode = code.pairingCode
            let plan = try await api.admin.pairAddresses(pairingCode: code.pairingCode)
            guard let address = plan.addresses.first(where: {
                $0.kind == "relay" && $0.usable && $0.systemTrust == true
                    && DesktopRelayAddress.matchesPhoneAddress($0.gatewayUrl, gatewayOrigin: gatewayOrigin)
            }) else { throw DesktopRelayAddress.Failure.notAvailable }
            let qr = try await api.admin.buildPairQr(pairingCode: code.pairingCode, gatewayUrl: address.gatewayUrl)
            guard generation == attempt else {
                try? await revoke(code.pairingCode, api: api)
                return
            }
            pending = code
            payload = qr
            observation = Task { [weak self] in
                while !Task.isCancelled {
                    do {
                        try await Task.sleep(for: .seconds(2))
                        guard let self, self.generation == attempt else { return }
                        if Date().timeIntervalSince1970 * 1000 >= Double(code.expiresAt) {
                            self.payload = nil
                            self.failure = "This code expired. Create a new code and try again."
                            return
                        }
                        await self.refreshPhones(api: api)
                    } catch is CancellationError { return }
                    catch {
                        if !Task.isCancelled { self?.failure = "Waiting for your phone. Check your connection, then try again." }
                        return
                    }
                }
            }
        } catch {
            if let minted { try? await revoke(minted.pairingCode, api: api) }
            if generation == attempt {
                if StepUpRefusal(error) == .required {
                    needsBrowserConfirmation = true
                    failure = "Your passkey is needed to connect a new phone. Continue on your library’s secure page to confirm it’s you."
                } else if StepUpRefusal(error) == .unavailable {
                    failure = "Your library’s security lock is on. Connect this phone from the Mac that keeps your library."
                } else { failure = error.localizedDescription }
                issuedCode = nil
            }
        }
    }

    /// The roster does not identify which one-time code a phone redeemed.
    /// Keep it informational; only closing the flow withdraws our unused code.
    func refreshPhones(api: DesktopAPI) async {
        let current = generation
        do {
            let roster = try await api.devices()
            guard generation == current, !Task.isCancelled else { return }
            observedPhones = roster.filter {
                ($0.kind == "ios" || $0.kind == "android") && $0.online == true && $0.revokedAt == nil
            }
        } catch {
            guard generation == current, !Task.isCancelled else { return }
            observedPhones = []
        }
    }

    func cancel(api: DesktopAPI) async {
        generation = UUID()
        observation?.cancel()
        observation = nil
        payload = nil
        pending = nil
        working = false
        if let code = issuedCode {
            issuedCode = nil
            do { try await revoke(code, api: api) }
            catch { failure = "The code could not be withdrawn. It will expire automatically." }
        }
    }

    private func revoke(_ code: String, api: DesktopAPI) async throws {
        try await api.mutate("DELETE", "admin/devices/pair", body: ["pairingCode": code])
    }
}

@MainActor @Observable
final class DesktopAgentAuthorization {
    var code = ""
    var request: AccessAuthorizationLookupEnvelope?
    var allowedSources: Set<String> = []
    var includeFutureSources = false
    var allowDirect = false
    var allowAnswers = true
    var reviewedAnswers = true
    var policyFamilyId = ""
    var personallyStarted = false
    var failure: String?
    var busy = false
    var completed = false

    func lookup(api: DesktopAPI, overview: AccessOverview, expectedResource: URL) async {
        guard !busy else { return }
        busy = true
        failure = nil
        completed = false
        defer { busy = false }
        do {
            let client = AccessClient(baseURL: api.connection.url, token: api.connection.token, session: api.session)
            let found = try await client.lookup(code: code.trimmingCharacters(in: .whitespacesAndNewlines))
            guard found.request.resource == expectedResource.absoluteString, found.request.status == "pending",
                  found.request.expiresAt > Int64(Date().timeIntervalSince1970 * 1000) else {
                throw DesktopAPIError
                    .message(
                        "This request does not match your current Omnesis address or has expired. Start again from your assistant using the address above."
                    )
            }
            request = found
            allowedSources = []
            policyFamilyId = overview.defaultPolicyFamilyId ?? overview.policyFamilies.first?.id ?? ""
            reviewedAnswers = !policyFamilyId.isEmpty
            allowAnswers = true
            allowDirect = false
            personallyStarted = false
        } catch { self.failure = error.localizedDescription }
    }

    func decide(approve: Bool, api: DesktopAPI, overview: AccessOverview) async {
        guard let request, !busy else { return }
        busy = true
        failure = nil
        defer { busy = false }
        do {
            let decision: AccessAuthorizationDecision
            if approve {
                guard personallyStarted, request.request.status == "pending",
                      request.request.expiresAt > Int64(Date().timeIntervalSince1970 * 1000) else {
                    throw DesktopAPIError.message("Only approve a current connection that you started yourself.")
                }
                let available = overview.availableSourceIds
                guard allowedSources.isSubset(of: available), !allowedSources.isEmpty else {
                    throw DesktopAPIError.message("Choose at least one connected source to share.")
                }
                guard allowAnswers || allowDirect, !request.request.requiresAnswer || allowAnswers else {
                    throw DesktopAPIError.message("This assistant needs permission to ask Omnesis questions.")
                }
                let boundary = AccessSourceBoundary(
                    mode: includeFutureSources ? .denylist : .allowlist,
                    sourceIds: (includeFutureSources ? available.subtracting(allowedSources) : allowedSources).sorted()
                )
                var rules: [AccessGrantRule] = []
                if allowAnswers {
                    if reviewedAnswers {
                        guard overview.policyFamilies.contains(where: { $0.id == policyFamilyId }) else {
                            throw DesktopAPIError.message("Choose a current privacy policy for answers.")
                        }
                    }
                    let release: AccessAnswerRelease = reviewedAnswers ? .reviewed(policyFamilyId: policyFamilyId) : .unreviewed
                    rules.append(.answer(sources: boundary, release: release))
                }
                if allowDirect { rules.append(.direct(sources: boundary)) }
                let label = request.connection?.defaultName ?? request.request.clientName
                let selection: AccessAuthorizationSelection = if let connection = request.connection {
                    .newConnection(name: label, level: .new(name: connection.defaultLevelName, rules: rules))
                } else { .connect(rules: rules, credentialLabel: label) }
                decision = .approve(selection)
            } else { decision = .deny }
            let client = AccessClient(baseURL: api.connection.url, token: api.connection.token, session: api.session)
            try await client.decide(approvalId: request.request.approvalId, decision: decision)
            completed = true
            self.request = nil
        } catch { self.failure = error.localizedDescription }
    }
}
