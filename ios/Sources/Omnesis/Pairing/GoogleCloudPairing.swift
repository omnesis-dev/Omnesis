// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation
import Security

public enum CloudPairingError: Error, Equatable {
    case configuration, response, refused, expired, codeMismatch, confirmationRequired, cancelled
    case httpStatus(Int)
}

/// A 403 with the short body the server sent, for a caller that asked to see it. A refusal
/// whose body is longer than `bodyLimit` stays `CloudPairingError.httpStatus(403)`.
public struct CloudPairingRefusal: Error, Equatable {
    public static let bodyLimit = 256
    public let body: Data

    public init(body: Data) {
        self.body = body
    }

    /// The `error` the refusal names in its JSON object, such as `no-account`.
    public var reason: String? {
        guard body.count <= Self.bodyLimit, let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
        return object["error"] as? String
    }
}

public struct CloudPairingChallenge: Encodable, Sendable, Equatable {
    public let requestId: String
    public let kind: String
    public let name: String
    public let secret: String

    public init(name: String, requestId: String = UUID().uuidString.lowercased(), secret: String? = nil) throws {
        let name = name.trimmingCharacters(in: cloudNameWhitespace)
        guard !name.isEmpty, name.utf16.count <= 80, UUID(uuidString: requestId) != nil else { throw CloudPairingError.configuration }
        let value = try secret ?? cloudSecureRandomBytes().map { String(format: "%02x", $0) }.joined()
        guard value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw CloudPairingError.configuration }
        self.requestId = requestId
        kind = "ios"
        self.name = name
        self.secret = value
    }

    public var nonce: String {
        get throws {
            try cloudDigestURL(cloudTranscript(["omnesis-device-pairing-v2", requestId, kind, name, secretHash]))
        }
    }

    /// The code this device and the approving device compare, once the gateway has revealed
    /// `codeNonce`. `fingerprint` is the certificate this device connected to.
    public func comparisonCode(fingerprint: String, codeNonce: String) throws -> String {
        guard fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              PairingComparisonCode.opaque(codeNonce) else { throw CloudPairingError.configuration }
        let digest = try SHA256.hash(data: cloudTranscript(["omnesis-pairing-code-v3", fingerprint, requestId, secretHash, codeNonce]))
        return PairingComparisonCode.code(digest: Array(digest))
    }

    private var secretHash: String {
        SHA256.hash(data: Data(secret.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// Swift half of the comparison code in `packages/cloud-relay/src/device-enrollment.ts`.
///
/// Six digits are enough only because neither side picks its part after seeing the other's:
/// the gateway commits to a random nonce (the challenge) before this device sends its secret.
public enum PairingComparisonCode {
    /// `pairingCodeCommitment`: what the gateway's challenge must equal once the nonce is revealed.
    public static func commitment(codeNonce: String) throws -> String {
        guard opaque(codeNonce) else { throw CloudPairingError.response }
        return try cloudDigestURL(cloudTranscript(["omnesis-pairing-code-commitment-v1", codeNonce]))
    }

    /// The first six digest bytes as a big-endian integer, modulo one million, as `123 456`.
    static func code(digest: [UInt8]) -> String {
        let value = digest.prefix(6).reduce(UInt64(0)) { $0 << 8 | UInt64($1) } % 1_000_000
        let digits = String(repeating: "0", count: 6 - String(value).count) + String(value)
        return "\(digits.prefix(3)) \(digits.suffix(3))"
    }

    /// `formatPairingCode`: typed or stored digits become `123 456`; anything else is not a code.
    public static func format(_ input: String) -> String? {
        let digits = input.filter { !$0.isWhitespace && $0 != "-" }
        guard digits.range(of: "^[0-9]{6}$", options: .regularExpression) != nil else { return nil }
        return "\(digits.prefix(3)) \(digits.suffix(3))"
    }

    /// A code exactly as it is sent, shown and compared.
    public static func canonical(_ value: String) -> Bool {
        value.range(of: "^[0-9]{3} [0-9]{3}$", options: .regularExpression) != nil
    }

    /// A 32-byte value in unpadded base64url, the shape of a challenge and of a nonce.
    static func opaque(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    }
}

public struct CloudPairingProgress: Codable, Sendable, Equatable {
    public let status: String
    public let verificationCode: String
    /// The gateway's part of the code, revealed only after it received this device's secret.
    public let codeNonce: String
    public let expiresAt: Double
    public let pairingCode: String?
}

/// Approval and local code comparison are independent gates. A forged remote approval cannot skip either.
/// The one exception is `acceptAutomaticJoin`: a gateway this device pinned, and whose certificate passed
/// the public checks, answered a signed sign-in request by joining the device.
public struct CloudPairingConfirmation: Sendable {
    public let challenge: CloudPairingChallenge
    public let origin: URL
    public let fingerprint: String
    public let spkiFingerprint: String
    /// The code to show, computed here. Nil until a reply proved the gateway's nonce is the one
    /// it committed to and that the gateway computed the same code; never taken from a reply.
    public private(set) var verificationCode: String?
    public private(set) var approved = false
    public private(set) var compared = false
    public private(set) var joinedAutomatically = false
    private var pairingCode: String?
    private var expiresAt: TimeInterval
    private var committed: String?
    private var codeNonce: String?

    public init(
        challenge: CloudPairingChallenge,
        candidate: GoogleGatewayBinding,
        now: TimeInterval = Date().timeIntervalSince1970
    ) throws {
        self.challenge = challenge
        origin = try candidate.candidateOrigin()
        fingerprint = try candidate.candidateFingerprint(now: now)
        spkiFingerprint = try candidate.candidateSPKIFingerprint(now: now)
        expiresAt = now + 600
    }

    /// Record the challenge the gateway issued, before this device's secret is sent to it.
    /// It is the gateway's commitment to its nonce, and one request answers exactly one.
    public mutating func commit(to gatewayChallenge: String) throws {
        guard committed == nil, PairingComparisonCode.opaque(gatewayChallenge) else { throw CloudPairingError.response }
        committed = gatewayChallenge
    }

    public mutating func receive(_ progress: CloudPairingProgress, now: TimeInterval = Date().timeIntervalSince1970) throws {
        guard now < expiresAt, progress.expiresAt.isFinite, progress.expiresAt / 1000 > now else { throw CloudPairingError.expired }
        // The nonce must be the one committed to before the secret was sent, must never change,
        // and must give the gateway the code computed here. Otherwise no code is shown at all.
        guard let committed, PairingComparisonCode.opaque(progress.codeNonce),
              try PairingComparisonCode.commitment(codeNonce: progress.codeNonce) == committed,
              codeNonce == nil || codeNonce == progress.codeNonce else { throw CloudPairingError.codeMismatch }
        let local = try challenge.comparisonCode(fingerprint: fingerprint, codeNonce: progress.codeNonce)
        guard progress.verificationCode == local else { throw CloudPairingError.codeMismatch }
        guard ["pending", "approved"].contains(progress.status) else { throw CloudPairingError.refused }
        codeNonce = progress.codeNonce
        verificationCode = local
        expiresAt = min(expiresAt, progress.expiresAt / 1000)
        if progress.status == "approved" {
            guard let code = progress.pairingCode, !code.isEmpty, code.utf8.count <= 256 else { throw CloudPairingError.response }
            approved = true
            pairingCode = code
        }
    }

    /// Call only for an explicit human confirmation after comparing on an independently trusted device.
    public mutating func confirmComparison() {
        compared = true
    }

    /// Call only for the immediate answer to a signed enrollment request whose certificate
    /// passed the public checks. A later approval goes through `confirmComparison`.
    mutating func acceptAutomaticJoin() {
        joinedAutomatically = approved
    }

    public func pairingPayload(now: TimeInterval = Date().timeIntervalSince1970) throws -> String {
        guard now < expiresAt else { throw CloudPairingError.expired }
        guard compared || joinedAutomatically, approved, let pairingCode else { throw CloudPairingError.confirmationRequired }
        let object: [String: Any] = [
            "v": 4,
            "gatewayUrl": origin.absoluteString,
            "pairingCode": pairingCode,
            "tls": ["mode": "pinned-key-strict", "spkiFingerprint": spkiFingerprint],
        ]
        let encoded = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        // JSONSerialization's output is guaranteed UTF-8 JSON text.
        return String(bytes: encoded, encoding: .utf8)!
    }

    /// An exchange failure must not mistake a previously paired device for this successful pairing.
    public func acceptsCompletedPairing(_ pairing: Pairing?, previousGeneration: String?) -> Bool {
        guard compared || joinedAutomatically, approved, let pairing, let generation = pairing.pairingGeneration,
              !generation.isEmpty, generation != previousGeneration else { return false }
        return pairing.tlsMode == .pinnedKeyStrict && pairing.spkiFingerprint == spkiFingerprint && pairing.url == origin
    }
}

/// Direct Google endpoints use platform trust and reject redirects; gateway requests use a provisional strict pin.
public protocol CloudPairingTransport: Sendable {
    func requestData(url: URL, method: String, body: Data?, bearer: String?, form: Bool) async throws -> Data
    /// A JSON POST whose 403 is thrown as `CloudPairingRefusal`, carrying its body. Everything else matches `requestData`.
    func postReportingRefusal(url: URL, body: Data) async throws -> Data
    func close()
}

extension CloudPairingTransport {
    public func postReportingRefusal(url: URL, body: Data) async throws -> Data {
        try await requestData(url: url, method: "POST", body: body, bearer: nil, form: false)
    }
}

public final class CloudPairingHTTP: NSObject, URLSessionDataDelegate, CloudPairingTransport, @unchecked Sendable {
    private struct Pending {
        let url: URL
        let continuation: CheckedContinuation<Data, Error>
        var reportsRefusal = false
        var refused = false
        var responseAccepted = false
        var data = Data()
    }

    final class Cancellation: @unchecked Sendable {
        private let lock = NSLock()
        private var task: URLSessionTask?
        private var cancelled = false
        func install(_ task: URLSessionTask) {
            lock.lock()
            self.task = task
            let cancel = cancelled
            lock.unlock()
            if cancel { task.cancel() }
        }

        func cancel() {
            lock.lock()
            cancelled = true
            let task = task
            lock.unlock()
            task?.cancel()
        }
    }

    private let pinned: PinnedSession?
    private let configuration: URLSessionConfiguration
    private let requestTimeout: TimeInterval
    private let sessionLock = NSLock()
    private var session: URLSession?
    private var pending: [Int: Pending] = [:]
    private var closed = false
    private var servedTrust: SecTrust?

    public init(
        fingerprint: String? = nil,
        spkiFingerprint: String? = nil,
        canonicalHost: String? = nil,
        configuration: URLSessionConfiguration = .ephemeral,
        verificationDate: Date? = nil
    ) {
        if let spkiFingerprint {
            pinned = PinnedSession(spkiFingerprint: spkiFingerprint, host: canonicalHost, verificationDate: verificationDate)
        } else {
            pinned = fingerprint.map { value in
                PinnedSession(
                    fingerprintHex: value,
                    requireCertificateValidity: true,
                    verificationDate: verificationDate
                )
            }
        }
        self.configuration = configuration
        requestTimeout = min(15, max(0.1, configuration.timeoutIntervalForRequest))
        super.init()
    }

    /// Task creation shares the close lock: an SDK task can never be created
    /// after its session was invalidated, including during cancellation races.
    func begin(
        _ request: URLRequest,
        reportsRefusal: Bool = false,
        continuation: CheckedContinuation<Data, Error>
    ) throws
        -> URLSessionDataTask {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        guard !closed else { throw CloudPairingError.cancelled }
        let current: URLSession
        if let session { current = session } else {
            configuration.timeoutIntervalForRequest = min(15, max(0.1, configuration.timeoutIntervalForRequest))
            configuration.timeoutIntervalForResource = min(15, max(0.1, configuration.timeoutIntervalForResource))
            configuration.httpShouldSetCookies = false
            current = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
            session = current
        }
        let task = current.dataTask(with: request)
        pending[task.taskIdentifier] = Pending(url: request.url!, continuation: continuation, reportsRefusal: reportsRefusal)
        return task
    }

    public func close() {
        sessionLock.lock()
        closed = true
        let previous = session
        session = nil
        let waiting = Array(pending.values)
        pending.removeAll()
        sessionLock.unlock()
        waiting.forEach { $0.continuation.resume(throwing: CloudPairingError.cancelled) }
        previous?.invalidateAndCancel()
    }

    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    public func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        sessionLock.lock()
        let unavailable = closed
        if let trust = challenge.protectionSpace.serverTrust { servedTrust = trust }
        sessionLock.unlock()
        if unavailable { completionHandler(.cancelAuthenticationChallenge, nil) } else if let pinned { pinned.urlSession(
            session,
            didReceive: challenge,
            completionHandler: completionHandler
        ) } else { completionHandler(.performDefaultHandling, nil) }
    }

    public func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        sessionLock.lock()
        guard var state = pending[dataTask.taskIdentifier] else {
            sessionLock.unlock()
            completionHandler(.cancel)
            return
        }
        // Only a caller that asked for refusals reads a 403's body, and only a short one.
        if state.reportsRefusal, let http = response as? HTTPURLResponse, http.statusCode == 403, http.url == state.url,
           http.expectedContentLength <= Int64(CloudPairingRefusal.bodyLimit) {
            state.refused = true
            pending[dataTask.taskIdentifier] = state
            sessionLock.unlock()
            completionHandler(.allow)
            return
        }
        let failure: Error? = if let http = response as? HTTPURLResponse {
            if !(200 ... 299).contains(http.statusCode) {
                CloudPairingError.httpStatus(http.statusCode)
            } else if http.url != state.url || http.expectedContentLength > 65536 {
                CloudPairingError.response
            } else {
                nil
            }
        } else { CloudPairingError.response }
        if let failure {
            pending.removeValue(forKey: dataTask.taskIdentifier)
            sessionLock.unlock()
            state.continuation.resume(throwing: failure)
            completionHandler(.cancel)
        } else {
            state.responseAccepted = true
            pending[dataTask.taskIdentifier] = state
            sessionLock.unlock()
            completionHandler(.allow)
        }
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        sessionLock.lock()
        guard var state = pending[dataTask.taskIdentifier] else { sessionLock.unlock()
            return
        }
        guard state.data.count + data.count <= (state.refused ? CloudPairingRefusal.bodyLimit : 65536) else {
            pending.removeValue(forKey: dataTask.taskIdentifier)
            sessionLock.unlock()
            dataTask.cancel()
            state.continuation.resume(throwing: state.refused ? CloudPairingError.httpStatus(403) : CloudPairingError.response)
            return
        }
        state.data.append(data)
        pending[dataTask.taskIdentifier] = state
        sessionLock.unlock()
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        sessionLock.lock()
        let state = pending.removeValue(forKey: task.taskIdentifier)
        sessionLock.unlock()
        guard let state else { return }
        if state.refused {
            // A refusal whose body did not arrive whole is the plain status it always was.
            state.continuation.resume(throwing: error == nil ? CloudPairingRefusal(body: state.data) : CloudPairingError.httpStatus(403))
        } else if let error {
            state.continuation.resume(throwing: error)
        } else if state.responseAccepted {
            state.continuation.resume(returning: state.data)
        } else {
            state.continuation.resume(throwing: CloudPairingError.response)
        }
    }

    public func request<T: Decodable>(
        url: URL,
        method: String = "GET",
        body: Data? = nil,
        bearer: String? = nil,
        form: Bool = false
    ) async throws
        -> T {
        try await JSONDecoder().decode(T.self, from: requestData(url: url, method: method, body: body, bearer: bearer, form: form))
    }

    public func requestData(
        url: URL,
        method: String = "GET",
        body: Data? = nil,
        bearer: String? = nil,
        form: Bool = false
    ) async throws
        -> Data {
        try await send(url: url, method: method, body: body, bearer: bearer, form: form, reportsRefusal: false)
    }

    public func postReportingRefusal(url: URL, body: Data) async throws -> Data {
        try await send(url: url, method: "POST", body: body, bearer: nil, form: false, reportsRefusal: true)
    }

    // swiftlint:disable:next function_parameter_count
    private func send(url: URL, method: String, body: Data?, bearer: String?, form: Bool, reportsRefusal: Bool) async throws -> Data {
        guard url.scheme == "https", url.user == nil, url.password == nil else { throw CloudPairingError.configuration }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.httpShouldHandleCookies = false
        request.timeoutInterval = requestTimeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue(
            form ? "application/x-www-form-urlencoded" : "application/json",
            forHTTPHeaderField: "Content-Type"
        ) }
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        let cancellation = Cancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                do {
                    let task = try begin(request, reportsRefusal: reportsRefusal, continuation: continuation)
                    cancellation.install(task)
                    task.resume()
                } catch { continuation.resume(throwing: error) }
            }
        } onCancel: { cancellation.cancel() }
    }
}

extension CloudPairingHTTP: CloudPairingPublicCertificateReporting {
    /// Evaluated on request so transports nobody asks about never do this work.
    public func publicCertificateVerified(host: String) -> Bool {
        let trust = sessionLock.withLock { servedTrust }
        return trust.map { GatewayPublicCertificateCheck.passes(trust: $0, host: host) } ?? false
    }
}

/// ECMAScript WhiteSpace and LineTerminator, matching the gateway's String.trim exactly.
private let cloudNameWhitespace = CharacterSet(charactersIn:
    "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}"
        + "\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"
)
