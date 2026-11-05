// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation
import Security

public enum CloudPairingError: Error, Equatable {
    case configuration, response, refused, expired, codeMismatch, confirmationRequired, cancelled
    case httpStatus(Int)
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

    public func verificationCode(fingerprint: String) throws -> String {
        guard fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw CloudPairingError.configuration }
        let digest = try SHA256.hash(data: cloudTranscript(["omnesis-pairing-sas-v2", fingerprint, requestId, secretHash]))
        let hexadecimal = digest.map { String(format: "%02x", $0) }.joined()
        let hash = hexadecimal.prefix(20).uppercased()
        let groups = stride(from: 0, to: hash.count, by: 4).map { offset in
            let start = hash.index(hash.startIndex, offsetBy: offset)
            return String(hash[start ..< hash.index(start, offsetBy: 4)])
        }
        return groups.joined(separator: "-")
    }

    private var secretHash: String {
        SHA256.hash(data: Data(secret.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

public struct CloudPairingProgress: Codable, Sendable, Equatable {
    public let status: String
    public let verificationCode: String
    public let expiresAt: Double
    public let pairingCode: String?
}

/// Approval and local code comparison are independent gates. A forged remote approval cannot skip either.
public struct CloudPairingConfirmation: Sendable {
    public let challenge: CloudPairingChallenge
    public let origin: URL
    public let fingerprint: String
    public let spkiFingerprint: String
    public let verificationCode: String
    public private(set) var approved = false
    public private(set) var compared = false
    private var pairingCode: String?
    private var expiresAt: TimeInterval

    public init(
        challenge: CloudPairingChallenge,
        candidate: GoogleGatewayBinding,
        now: TimeInterval = Date().timeIntervalSince1970
    ) throws {
        self.challenge = challenge
        origin = try candidate.candidateOrigin()
        fingerprint = try candidate.candidateFingerprint(now: now)
        spkiFingerprint = try candidate.candidateSPKIFingerprint(now: now)
        verificationCode = try challenge.verificationCode(fingerprint: fingerprint)
        expiresAt = now + 600
    }

    public mutating func receive(_ progress: CloudPairingProgress, now: TimeInterval = Date().timeIntervalSince1970) throws {
        guard now < expiresAt, progress.expiresAt.isFinite, progress.expiresAt / 1000 > now else { throw CloudPairingError.expired }
        guard progress.verificationCode == verificationCode else { throw CloudPairingError.codeMismatch }
        guard ["pending", "approved"].contains(progress.status) else { throw CloudPairingError.refused }
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

    public func pairingPayload(now: TimeInterval = Date().timeIntervalSince1970) throws -> String {
        guard now < expiresAt else { throw CloudPairingError.expired }
        guard compared, approved, let pairingCode else { throw CloudPairingError.confirmationRequired }
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
        guard compared, approved, let pairing, let generation = pairing.pairingGeneration,
              !generation.isEmpty, generation != previousGeneration else { return false }
        return pairing.tlsMode == .pinnedKeyStrict && pairing.spkiFingerprint == spkiFingerprint && pairing.url == origin
    }
}

/// Direct Google endpoints use platform trust and reject redirects; gateway requests use a provisional strict pin.
public protocol CloudPairingTransport: Sendable {
    func requestData(url: URL, method: String, body: Data?, bearer: String?, form: Bool) async throws -> Data
    func close()
}

public final class CloudPairingHTTP: NSObject, URLSessionDataDelegate, CloudPairingTransport, @unchecked Sendable {
    private struct Pending {
        let url: URL
        let continuation: CheckedContinuation<Data, Error>
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
    func begin(_ request: URLRequest, continuation: CheckedContinuation<Data, Error>) throws -> URLSessionDataTask {
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
        pending[task.taskIdentifier] = Pending(url: request.url!, continuation: continuation)
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
        guard state.data.count + data.count <= 65536 else {
            pending.removeValue(forKey: dataTask.taskIdentifier)
            sessionLock.unlock()
            dataTask.cancel()
            state.continuation.resume(throwing: CloudPairingError.response)
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
        if let error {
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
                    let task = try begin(request, continuation: continuation)
                    cancellation.install(task)
                    task.resume()
                } catch { continuation.resume(throwing: error) }
            }
        } onCancel: { cancellation.cancel() }
    }
}

/// ECMAScript WhiteSpace and LineTerminator, matching the gateway's String.trim exactly.
private let cloudNameWhitespace = CharacterSet(charactersIn:
    "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}"
        + "\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"
)
