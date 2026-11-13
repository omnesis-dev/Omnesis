// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Observation

/// Shows a relay page to the person: the sign-in that connects a gateway, or account management.
@MainActor
public protocol OmnesisAccountBrowsing: AnyObject {
    func open(_ url: URL)
    func close()
}

/// Settings → Omnesis account: the gateway's account link and remote access.
///
/// One change runs at a time, and a change in flight discards any status read
/// that started before it, so a slow poll never puts an older state back on screen.
@MainActor
@Observable
public final class OmnesisAccountModel {
    public private(set) var status: CloudRelayStatus?
    /// The change in flight, which every action waits for.
    public private(set) var busy: CloudRelayOperation?
    /// Why the last change failed, in the portal's words.
    public private(set) var failure: String?
    /// Why there is no status to show. Stays nil while an earlier status is on screen.
    public private(set) var loadError: Error?

    private let enabled: Bool
    private let browser: (any OmnesisAccountBrowsing)?
    @ObservationIgnored private var generation = 0
    /// Whether this screen opened the connect sign-in, to close it again once the gateway has moved on.
    @ObservationIgnored private var signInOpened = false

    /// `enabled` is the cloud build flag: while it is off the model never asks the gateway anything.
    public init(
        enabled: Bool = CloudRelayFeature.enabled,
        browser: (any OmnesisAccountBrowsing)? = nil,
        status: CloudRelayStatus? = nil,
        failure: String? = nil,
        loadError: Error? = nil
    ) {
        self.enabled = enabled
        self.browser = browser
        self.status = status
        self.failure = failure
        self.loadError = loadError
    }

    /// Whether Settings lists the Omnesis account: the build has cloud connectivity
    /// and the gateway answered with a status this device may read.
    public var offered: Bool {
        enabled && status != nil
    }

    /// While a connect is under way the screen follows it closely; otherwise a slow poll is enough.
    public var pollInterval: Duration {
        status?.phase.inProgress == true ? .seconds(2) : .seconds(5)
    }

    /// A gateway without Omnesis accounts answers 404, and one this device may not
    /// administer answers 403 to reads and changes alike; both leave nothing to offer. Any other failure keeps
    /// what is on screen for the next poll to replace.
    public func load(client: (any CloudRelayManaging)?) async {
        guard enabled, busy == nil, let client else { return }
        let started = generation
        do {
            let fresh = try await client.cloudRelayStatus()
            guard started == generation else { return }
            adopt(fresh)
        } catch {
            guard started == generation else { return }
            switch error as? GatewayClient.Error {
            case .notFound, .forbidden, .serverError(status: 403, _):
                status = nil
                loadError = error
            default:
                if status == nil { loadError = error }
            }
        }
    }

    /// Starts the sign-in that connects this gateway, and opens it for the person.
    public func connect(_ intent: CloudRelayConnectIntent, client: any CloudRelayManaging) async {
        await perform(.connect(intent), client: client)
        guard failure == nil, status?.phase == .waiting else { return }
        openSignIn()
    }

    public func perform(_ operation: CloudRelayOperation, client: any CloudRelayManaging) async {
        guard busy == nil else { return }
        busy = operation
        failure = nil
        generation += 1
        defer {
            generation += 1
            busy = nil
        }
        do {
            try await adopt(client.cloudRelay(operation))
        } catch {
            failure = Self.failureText(for: error)
        }
    }

    /// Opens the sign-in of the connect under way; the person may have closed it.
    public func openSignIn() {
        guard status?.phase == .waiting, let url = CloudRelayPresentation.httpsURL(status?.connect?.authorizeUrl) else { return }
        signInOpened = true
        browser?.open(url)
    }

    /// Opens the relay's account page, which stays up until the person closes it.
    public func openAccountPage() {
        guard let url = CloudRelayPresentation.accountPageURL(relayUrl: status?.config?.relayUrl) else { return }
        signInOpened = false
        browser?.open(url)
    }

    private func adopt(_ fresh: CloudRelayStatus) {
        status = fresh
        loadError = nil
        // The sign-in ends on the relay's page; the gateway moving on is what closes it here.
        if signInOpened, fresh.phase != .waiting {
            signInOpened = false
            browser?.close()
        }
    }

    /// The gateway's own code decides the words; anything else is a connection problem.
    static func failureText(for error: Error) -> String {
        if let code = (error as? GatewayClient.Error)?.gatewayCode, CloudRelayPresentation.knowsError(code) {
            return CloudRelayPresentation.error(code)
        }
        return "Couldn't load or update your Omnesis account settings. Check the connection and try again."
    }
}
