// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(AuthenticationServices)
import AuthenticationServices

@MainActor protocol AccountPasskeyProvider: AnyObject {
    func assertion(options: Data, rpId: String) async throws -> Data
    func cancel()
}

@MainActor protocol AccountPasskeySession: AnyObject {
    func start()
    func cancel()
}

/// The operating system selects a synced passkey; one continuation owns each assertion and cancellation.
@MainActor final class AccountPasskeyBrowser: NSObject, AccountPasskeyProvider, ASAuthorizationControllerPresentationContextProviding {
    typealias Completion = @MainActor (Result<AccountPasskeyAssertion, Error>) -> Void
    typealias Factory = @MainActor (String, Data, any ASAuthorizationControllerPresentationContextProviding, @escaping Completion)
        -> any AccountPasskeySession
    private let anchorProvider: @MainActor () -> ASPresentationAnchor?
    private let factory: Factory
    private var window: ASPresentationAnchor?
    private var session: (any AccountPasskeySession)?
    private var continuation: CheckedContinuation<Data, Error>?
    private var generation: UUID?

    init(
        anchorProvider: @escaping @MainActor () -> ASPresentationAnchor? = GoogleSystemBrowser.defaultAnchor,
        factory: @escaping Factory = AccountPasskeyBrowser.platformSession
    ) {
        self.anchorProvider = anchorProvider
        self.factory = factory
        super.init()
    }

    func assertion(options: Data, rpId: String) async throws -> Data {
        cancel()
        guard !Task.isCancelled, options.count <= 65536 else { throw AccountPairingError.cancelled }
        let challenge = try JSONDecoder().decode(AccountPasskeyChallenge.self, from: options).validated(expectedRpId: rpId)
        guard let window = anchorProvider() else { throw AccountPairingError.response }
        self.window = window
        let id = UUID()
        generation = id
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                guard !Task.isCancelled else { finish(id, result: .failure(AccountPairingError.cancelled))
                    return
                }
                let session = factory(rpId, challenge, self) { [weak self] result in self?.finish(id, result: result) }
                guard generation == id else {
                    session.cancel()
                    return
                }
                self.session = session
                session.start()
            }
        } onCancel: { Task { @MainActor [weak self] in self?.finish(id, result: .failure(AccountPairingError.cancelled)) } }
    }

    func presentationAnchor(for _: ASAuthorizationController) -> ASPresentationAnchor {
        window ?? ASPresentationAnchor()
    }

    func cancel() {
        guard let id = generation else { return }
        finish(id, result: .failure(AccountPairingError.cancelled))
    }

    private func finish(_ id: UUID, result: Result<AccountPasskeyAssertion, Error>) {
        guard generation == id else { return }
        let continuation = continuation, session = session
        self.continuation = nil
        self.session = nil
        self.window = nil
        generation = nil
        session?.cancel()
        continuation?.resume(with: result.flatMap { assertion in Result { try assertion.encoded() } })
    }

    private static func platformSession(
        rpId: String,
        challenge: Data,
        provider: any ASAuthorizationControllerPresentationContextProviding,
        completion: @escaping Completion
    )
        -> any AccountPasskeySession {
        PlatformAccountPasskeySession(rpId: rpId, challenge: challenge, provider: provider, completion: completion)
    }
}

/// Only passkeys already on this device are offered, so the system never shows its
/// sheet for scanning a code with another device.
@MainActor final class PlatformAccountPasskeySession: NSObject, AccountPasskeySession, ASAuthorizationControllerDelegate {
    typealias Perform = @MainActor (ASAuthorizationController, ASAuthorizationController.RequestOptions) -> Void
    private let controller: ASAuthorizationController
    private let perform: Perform
    private let completion: AccountPasskeyBrowser.Completion
    init(
        rpId: String,
        challenge: Data,
        provider: any ASAuthorizationControllerPresentationContextProviding,
        perform: @escaping Perform = { $0.performRequests(options: $1) },
        completion: @escaping AccountPasskeyBrowser.Completion
    ) {
        let request = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
            .createCredentialAssertionRequest(challenge: challenge)
        request.userVerificationPreference = .required
        controller = ASAuthorizationController(authorizationRequests: [request])
        self.perform = perform
        self.completion = completion
        super.init()
        controller.delegate = self
        controller.presentationContextProvider = provider
    }

    func start() {
        perform(controller, .preferImmediatelyAvailableCredentials)
    }

    func cancel() {
        controller.cancel()
    }

    func authorizationController(controller _: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion
        else { completion(.failure(AccountPairingError.response))
            return
        }
        completion(.success(AccountPasskeyAssertion(
            credentialId: credential.credentialID,
            clientData: credential.rawClientDataJSON,
            authenticatorData: credential.rawAuthenticatorData,
            signature: credential.signature,
            userId: credential.userID
        )))
    }

    func authorizationController(controller _: ASAuthorizationController, didCompleteWithError error: Error) {
        completion(.failure(Self.failure(for: error)))
    }

    /// With no passkey on this device the system shows nothing and reports the request as cancelled,
    /// exactly as it does when the person dismisses the prompt. It keeps the two apart on purpose.
    static func failure(for error: Error) -> AccountPairingError {
        guard let code = (error as? ASAuthorizationError)?.code else { return .cancelled }
        return code == .canceled || code == .notInteractive ? .noPasskey : .cancelled
    }
}
#endif
