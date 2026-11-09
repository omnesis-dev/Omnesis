// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Why a device-socket connection attempt ended, reduced to what decides the
/// next retry and what the user is told.
enum DeviceSocketAttemptFailure: Equatable, Sendable {
    /// The gateway could not be reached, or an open socket dropped.
    case network(detail: String)
    /// The upgrade reached something that answered with this HTTP status.
    case server(status: Int)
    case rateLimited
    /// The connection was refused because the gateway failed TLS verification.
    case trust(detail: String)
    /// The gateway refused this device's credentials.
    case authentication(detail: String)
    /// The gateway refused the hello for a reason a retry cannot change.
    case incompatible(detail: String)

    /// A refusal carried by the hello response rather than by the transport.
    struct HelloRejection: Error, Equatable {
        let code: String
        let message: String
    }

    /// `userInfo` key under which `URLError` carries the Secure Transport status.
    private static let streamErrorKey = "_kCFStreamErrorCodeKey"
    /// errSSLClosedGraceful, errSSLClosedAbort and errSSLClosedNoNotify: the peer
    /// went away during the handshake, which is what a network flap or a gateway
    /// restart looks like, not a certificate that failed verification.
    private static let connectionClosedDuringHandshake: Set<Int> = [-9805, -9806, -9816]

    /// Classifies a failed attempt.
    ///
    /// `URLError.cancelled` before any HTTP response means trust: the socket
    /// recognizes its own cancellations before calling this, so the remaining
    /// source is a session delegate answering the server-trust challenge with
    /// `.cancelAuthenticationChallenge`, which `PinnedSession` and the rejecting
    /// session both do when a certificate fails verification.
    static func classify(_ error: Error, handshakeStatus: Int?, helloCompleted: Bool) -> Self {
        if helloCompleted { return .network(detail: error.localizedDescription) }
        if let rejection = error as? HelloRejection { return classify(rejection) }
        if let handshakeStatus, handshakeStatus != 101 { return classify(status: handshakeStatus) }
        if let urlError = error as? URLError, isTrustFailure(urlError, handshakeStatus: handshakeStatus) {
            return .trust(detail: urlError.localizedDescription)
        }
        return .network(detail: error.localizedDescription)
    }

    private static func classify(_ rejection: HelloRejection) -> Self {
        switch rejection.code {
        case "invalid_token", "device_not_found": .authentication(detail: rejection.message)
        case "rate_limited": .rateLimited
        default: .incompatible(detail: rejection.message)
        }
    }

    private static func classify(status: Int) -> Self {
        switch status {
        case 401, 403: .authentication(detail: "The gateway answered with status \(status).")
        case 429: .rateLimited
        default: .server(status: status)
        }
    }

    private static func isTrustFailure(_ error: URLError, handshakeStatus: Int?) -> Bool {
        switch error.code {
        case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid,
             .serverCertificateHasUnknownRoot, .clientCertificateRejected, .clientCertificateRequired:
            return true
        case .secureConnectionFailed:
            let status = (error as NSError).userInfo[streamErrorKey] as? Int
            return status.map(connectionClosedDuringHandshake.contains) != true
        case .cancelled:
            return handshakeStatus == nil
        default:
            return false
        }
    }
}

/// Decides when the device socket may try to connect again. Pure state and
/// arithmetic: the socket supplies the time and the randomness, so every
/// schedule here is deterministic under test.
///
/// Two independent limits apply:
///
/// - **Backoff** is the delay a failed attempt earns: 1s, 2s, 4s, 8s, 16s, then
///   30s, plus up to 25% jitter. Restored connectivity restarts the ladder,
///   because the failures so far say nothing about the new network, and a
///   gateway that stays unreachable climbs it again.
/// - **The attempt budget** caps every attempt, however it was triggered, so
///   network flapping or repeated foregrounding cannot become a retry storm. A
///   burst of 5 refilling every 20s allows at most 8 attempts in any minute and
///   185 in any hour, below the gateway's upgrade limit of 10 per minute and 200
///   per hour for one client address.
struct DeviceSocketReconnectPolicy: Sendable {
    struct Limits: Sendable {
        var baseDelay: Duration = .seconds(1)
        var maxDelay: Duration = .seconds(30)
        var jitterFraction = 0.25
        /// Long enough for the gateway's one-minute limiter window to pass.
        var rateLimitedDelay: Duration = .seconds(60)
        /// A credential or protocol refusal can only change on the gateway's
        /// side, so it is checked rarely rather than abandoned.
        var refusedDelay: Duration = .seconds(300)
        var attemptBurst = 5
        var attemptRefillInterval: Duration = .seconds(20)
        /// How long a connection has to complete its hello.
        var helloTimeout: Duration = .seconds(30)
        /// How long an open socket has to answer a ping after a wake signal.
        var probeTimeout: Duration = .seconds(5)
        /// An attempt in flight this long started on a network state that may
        /// be gone, so a wake signal replaces it instead of waiting it out.
        var supersedeInFlightAfter: Duration = .seconds(2)
    }

    /// What is asking for an early attempt.
    enum WakeSignal: Equatable, Sendable {
        /// The network path changed to one that may work.
        case connectivityRestored
        /// The user returned to the app.
        case foreground
    }

    let limits: Limits
    private(set) var lastFailure: DeviceSocketAttemptFailure?
    private var consecutiveFailures = 0
    /// Theoretical arrival time of the next attempt, the one value the generic
    /// cell rate algorithm needs to enforce the budget.
    private var nextAttemptArrival: Duration = .zero

    init(limits: Limits = Limits()) {
        self.limits = limits
    }

    /// Whether a signal should shorten the current wait. A network change cannot
    /// fix a refused credential, and a retry inside the limiter's window is only
    /// refused again, so those signals leave the schedule alone. Returning to
    /// the app does re-check a refusal, because the user may have fixed it on
    /// the gateway.
    func accepts(_ signal: WakeSignal) -> Bool {
        switch lastFailure {
        case .rateLimited:
            false
        case .authentication, .incompatible:
            signal == .foreground
        case .network, .server, .trust, nil:
            true
        }
    }

    mutating func connectivityRestored() {
        consecutiveFailures = 0
    }

    mutating func recordConnected() {
        consecutiveFailures = 0
        lastFailure = nil
    }

    mutating func recordFailure(_ failure: DeviceSocketAttemptFailure) {
        lastFailure = failure
        consecutiveFailures += 1
    }

    /// The wait the most recent failure earned. `jitter` is in `0...1`.
    func retryDelay(jitter: Double) -> Duration {
        let backoff = jitteredBackoff(jitter: jitter)
        return switch lastFailure {
        case .authentication, .incompatible:
            limits.refusedDelay
        case .rateLimited:
            max(backoff, limits.rateLimitedDelay)
        case .network, .server, .trust, nil:
            backoff
        }
    }

    /// How long until the budget allows another attempt.
    func budgetDelay(at now: Duration) -> Duration {
        let allowance = limits.attemptRefillInterval * (limits.attemptBurst - 1)
        return max(.zero, nextAttemptArrival - allowance - now)
    }

    mutating func recordAttemptStarted(at now: Duration) {
        nextAttemptArrival = max(now, nextAttemptArrival) + limits.attemptRefillInterval
    }

    private func jitteredBackoff(jitter: Double) -> Duration {
        let exponent = min(max(consecutiveFailures - 1, 0), 5)
        let base = min(limits.baseDelay * (1 << exponent), limits.maxDelay)
        return base + (base / 1000) * Int((limits.jitterFraction * jitter * 1000).rounded())
    }
}
