// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(AuthenticationServices)
import AuthenticationServices
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

@MainActor
protocol GoogleBrowserAuthenticationSession: AnyObject {
    func start() -> Bool
    func cancel()
}

extension ASWebAuthenticationSession: GoogleBrowserAuthenticationSession {}

/// Owns exactly one system-browser continuation. Late callbacks cannot finish a newer sign-in.
@MainActor
final class GoogleSystemBrowser: NSObject, GooglePairingBrowser, ASWebAuthenticationPresentationContextProviding {
    typealias Completion = @Sendable (URL?, Error?) -> Void
    typealias SessionFactory = @MainActor (
        GoogleNativeAuthorization,
        @escaping Completion,
        any ASWebAuthenticationPresentationContextProviding
    )
        -> any GoogleBrowserAuthenticationSession

    let anchorProvider: @MainActor () -> ASPresentationAnchor?
    let sessionFactory: SessionFactory
    private var active: (any GoogleBrowserAuthenticationSession)?
    private var window: ASPresentationAnchor?
    private var continuation: CheckedContinuation<URL, Error>?
    private var generation: UUID?

    init(
        anchorProvider: @escaping @MainActor () -> ASPresentationAnchor? = GoogleSystemBrowser.defaultAnchor,
        sessionFactory: @escaping SessionFactory = GoogleSystemBrowser.systemSession
    ) {
        self.anchorProvider = anchorProvider
        self.sessionFactory = sessionFactory
        super.init()
    }

    static func defaultAnchor() -> ASPresentationAnchor? {
        #if canImport(UIKit)
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first(where: \.isKeyWindow)
        #elseif canImport(AppKit)
        return NSApplication.shared.keyWindow
        #endif
    }

    static func systemSession(
        authorization: GoogleNativeAuthorization,
        completion: @escaping Completion,
        presentationProvider: any ASWebAuthenticationPresentationContextProviding
    )
        -> any GoogleBrowserAuthenticationSession {
        let session = ASWebAuthenticationSession(
            url: authorization.url,
            callbackURLScheme: authorization.callbackScheme,
            completionHandler: completion
        )
        session.presentationContextProvider = presentationProvider
        session.prefersEphemeralWebBrowserSession = true
        return session
    }

    func presentationAnchor(for _: ASWebAuthenticationSession) -> ASPresentationAnchor {
        window ?? ASPresentationAnchor()
    }

    func signIn(_ authorization: GoogleNativeAuthorization) async throws -> URL {
        cancel()
        guard !Task.isCancelled else { throw CloudPairingError.cancelled }
        guard let anchor = anchorProvider() else { throw CloudPairingError.configuration }
        window = anchor
        let operation = UUID()
        generation = operation
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                guard !Task.isCancelled else {
                    finish(operation, result: .failure(CloudPairingError.cancelled), cancelSession: true)
                    return
                }
                let session = sessionFactory(
                    authorization,
                    { [weak self] url, error in
                        Task { @MainActor in
                            guard let self else { return }
                            if error == nil, let url {
                                self.finish(operation, result: .success(url), cancelSession: false)
                            } else {
                                self.finish(operation, result: .failure(CloudPairingError.cancelled), cancelSession: false)
                            }
                        }
                    },
                    self
                )
                active = session
                if !session.start() {
                    finish(operation, result: .failure(CloudPairingError.configuration), cancelSession: true)
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.finish(operation, result: .failure(CloudPairingError.cancelled), cancelSession: true)
            }
        }
    }

    private func finish(_ operation: UUID, result: Result<URL, Error>, cancelSession: Bool) {
        guard generation == operation, let continuation else { return }
        let session = active
        active = nil
        self.continuation = nil
        generation = nil
        window = nil
        if cancelSession { session?.cancel() }
        continuation.resume(with: result)
    }

    func cancel() {
        if let generation {
            finish(generation, result: .failure(CloudPairingError.cancelled), cancelSession: true)
        } else {
            window = nil
        }
    }
}

extension GoogleCloudPairingCoordinator {
    static func systemBrowser() -> any GooglePairingBrowser {
        GoogleSystemBrowser()
    }
}

#if canImport(UIKit)
extension GoogleCloudPairingCoordinator {
    convenience init() {
        self.init(
            browser: Self.systemBrowser(),
            makeChallenge: GooglePairingProductionDefaults.challenge,
            makeTransport: GooglePairingProductionDefaults.transport,
            makeClient: GooglePairingProductionDefaults.client,
            sleep: GooglePairingProductionDefaults.wait,
            now: GooglePairingProductionDefaults.now
        )
    }
}

@MainActor
enum GooglePairingProductionDefaults {
    typealias ClientFactory = (GoogleCloudPairingConfiguration, any CloudPairingTransport) throws -> any GooglePairingSession

    static let challenge: () throws -> CloudPairingChallenge = {
        try CloudPairingChallenge(name: UIDevice.current.name)
    }

    static let transport: () -> any CloudPairingTransport = {
        CloudPairingHTTP()
    }

    static let client: ClientFactory = { configuration, transport in
        try GoogleCloudPairingClient(
            relayOrigin: configuration.relayOrigin,
            clientId: configuration.clientId,
            direct: transport
        )
    }

    static let wait: () async throws -> Void = {
        try await Task.sleep(for: .seconds(2))
    }

    static let now: () -> TimeInterval = {
        Date().timeIntervalSince1970
    }
}

#endif
#endif
