// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

// MARK: - Test doubles

/// Time that moves only when a test says so, recording every sleep requested.
final class ManualClock: DeviceSocketClock, @unchecked Sendable {
    private struct Sleeper {
        let id: UUID
        let duration: Duration
        let deadline: Duration
        let continuation: CheckedContinuation<Void, Error>
    }

    private let lock = NSLock()
    private var current: Duration = .seconds(1000)
    private var sleepers: [Sleeper] = []
    private var requests: [Duration] = []

    /// A sleep of this length is the hello deadline every attempt arms, which
    /// the counts below leave out so they read as backoffs and probes.
    let helloTimeout: Duration = .seconds(45)

    var now: Duration {
        lock.withLock { current }
    }

    var requestedSleeps: [Duration] {
        lock.withLock { requests.filter { $0 != helloTimeout } }
    }

    var pendingSleeps: Int {
        lock.withLock { sleepers.filter { $0.duration != helloTimeout }.count }
    }

    func sleep(for duration: Duration) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                lock.withLock {
                    requests.append(duration)
                    sleepers.append(Sleeper(
                        id: id,
                        duration: duration,
                        deadline: current + duration,
                        continuation: continuation
                    ))
                }
            }
        } onCancel: {
            let cancelled = lock.withLock { () -> Sleeper? in
                guard let index = sleepers.firstIndex(where: { $0.id == id }) else { return nil }
                return sleepers.remove(at: index)
            }
            cancelled?.continuation.resume(throwing: CancellationError())
        }
    }

    func advance(by duration: Duration) {
        let due = lock.withLock { () -> [Sleeper] in
            current += duration
            let due = sleepers.filter { $0.deadline <= current }
            sleepers.removeAll { $0.deadline <= current }
            return due
        }
        for sleeper in due {
            sleeper.continuation.resume()
        }
    }
}

/// A scripted connection the test answers by hand.
final class FakeConnection: DeviceSocketConnection, @unchecked Sendable {
    private let lock = NSLock()
    private var pendingReceive: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
    private var queued: [Result<URLSessionWebSocketTask.Message, Error>] = []
    private var pongHandlers: [@Sendable (Error?) -> Void] = []
    private var sentFrames: [String] = []
    private var cancelled = false
    private var status: Int?

    /// When set, `cancel()` does not end a pending receive; the test delivers
    /// the late answer itself, as a slow network callback would.
    var holdsReceiveAcrossCancel = false

    var sent: [String] {
        lock.withLock { sentFrames }
    }

    var isCancelled: Bool {
        lock.withLock { cancelled }
    }

    var pings: Int {
        lock.withLock { pongHandlers.count }
    }

    var handshakeStatus: Int? {
        lock.withLock { status }
    }

    func setHandshakeStatus(_ value: Int?) {
        lock.withLock { status = value }
    }

    func send(_ text: String) async throws {
        lock.withLock { sentFrames.append(text) }
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { continuation in
            let next: Result<URLSessionWebSocketTask.Message, Error>? = lock.withLock {
                if !queued.isEmpty { return queued.removeFirst() }
                pendingReceive = continuation
                return nil
            }
            if let next { continuation.resume(with: next) }
        }
    }

    func sendPing(_ completion: @escaping @Sendable (Error?) -> Void) {
        lock.withLock { pongHandlers.append(completion) }
    }

    func answerPing(at index: Int = 0, error: Error? = nil) {
        let handler = lock.withLock { pongHandlers[index] }
        handler(error)
    }

    func cancel() {
        let pending = lock.withLock { () -> CheckedContinuation<URLSessionWebSocketTask.Message, Error>? in
            cancelled = true
            guard !holdsReceiveAcrossCancel else { return nil }
            defer { pendingReceive = nil }
            return pendingReceive
        }
        pending?.resume(throwing: URLError(.cancelled))
    }

    func deliver(_ result: Result<URLSessionWebSocketTask.Message, Error>) {
        let pending = lock.withLock { () -> CheckedContinuation<URLSessionWebSocketTask.Message, Error>? in
            guard let pending = pendingReceive else {
                queued.append(result)
                return nil
            }
            pendingReceive = nil
            return pending
        }
        pending?.resume(with: result)
    }

    func fail(_ error: Error) {
        deliver(.failure(error))
    }

    /// Answers the hello this connection sent.
    func acceptHello() throws {
        try deliver(.success(.string(helloResponse(ok: true))))
    }

    func rejectHello(code: String, message: String) throws {
        try deliver(.success(.string(helloResponse(ok: false, code: code, message: message))))
    }

    private func helloResponse(ok: Bool, code: String = "", message: String = "") throws -> String {
        let frame = try XCTUnwrap(sent.first)
        let hello = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(frame.utf8)) as? [String: Any])
        let id = try XCTUnwrap(hello["id"] as? String)
        if ok {
            return #"{"kind":"response","correlationId":"\#(id)","ok":true,"#
                + #""result":{"deviceId":"dev-1","deviceName":"Test Phone","scopes":["read"]}}"#
        }
        return #"{"kind":"response","correlationId":"\#(id)","ok":false,"#
            + #""error":{"code":"\#(code)","message":"\#(message)"}}"#
    }
}

final class FakeConnector: DeviceSocketConnector, @unchecked Sendable {
    private let lock = NSLock()
    private var opened: [FakeConnection] = []
    private var requests: [URLRequest] = []
    /// Applied to each new connection before the socket sees it.
    var configure: @Sendable (FakeConnection) -> Void = { _ in }

    var connections: [FakeConnection] {
        lock.withLock { opened }
    }

    var openedRequests: [URLRequest] {
        lock.withLock { requests }
    }

    func open(_ request: URLRequest) -> any DeviceSocketConnection {
        let connection = FakeConnection()
        configure(connection)
        lock.withLock {
            opened.append(connection)
            requests.append(request)
        }
        return connection
    }
}

final class FakePathObserver: NetworkPathObserving, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: AsyncStream<NetworkPathSnapshot>.Continuation?

    func paths() -> AsyncStream<NetworkPathSnapshot> {
        AsyncStream { continuation in
            self.lock.withLock { self.continuation = continuation }
        }
    }

    var isObserved: Bool {
        lock.withLock { continuation != nil }
    }

    func send(_ snapshot: NetworkPathSnapshot) {
        lock.withLock { continuation }?.yield(snapshot)
    }
}

let wifi = NetworkPathSnapshot(isUsable: true, interfaces: [.wifi])
let cellular = NetworkPathSnapshot(isUsable: true, interfaces: [.cellular])
let noNetwork = NetworkPathSnapshot(isUsable: false, interfaces: [])
let refused = URLError(.cannotConnectToHost)

// MARK: - Harness

@available(iOS 17.0, macOS 14.0, *)
class DeviceSocketLifecycleTestCase: XCTestCase {
    var clock: ManualClock!
    var connector: FakeConnector!
    var pathObserver: FakePathObserver!
    var socket: DeviceSocket!

    override func setUp() async throws {
        clock = ManualClock()
        connector = FakeConnector()
        pathObserver = FakePathObserver()
        socket = try DeviceSocket(
            gatewayUrl: XCTUnwrap(URL(string: "https://gateway.example.com:7600")),
            token: "omn_test",
            connector: connector,
            pathObserver: pathObserver,
            clock: clock,
            limits: {
                var limits = DeviceSocketReconnectPolicy.Limits()
                limits.helloTimeout = clock.helloTimeout
                return limits
            }(),
            randomUnit: { 0 }
        )
    }

    override func tearDown() async throws {
        await socket.stop()
    }

    // MARK: Helpers

    func eventually(
        _ what: String,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: () async -> Bool
    ) async {
        let deadline = ContinuousClock.now + .seconds(5)
        while ContinuousClock.now < deadline {
            if await condition() { return }
            try? await Task.sleep(for: .milliseconds(2))
        }
        XCTFail("timed out waiting for \(what)", file: file, line: line)
    }

    /// Lets anything already scheduled run, for asserting that nothing happens.
    func settle() async {
        for _ in 0 ..< 10 {
            _ = await socket.state()
            try? await Task.sleep(for: .milliseconds(2))
        }
    }

    func startObservingPath(_ initial: NetworkPathSnapshot) async {
        await socket.start()
        await eventually("the path observer to attach") { pathObserver.isObserved }
        await send(initial)
    }

    /// Sends a path update and waits for the socket to have taken it in.
    func send(_ path: NetworkPathSnapshot) async {
        pathObserver.send(path)
        await eventually("the socket to take in the path") {
            await socket.currentPathForTesting() == path
        }
    }

    func attempt(_ index: Int) async -> FakeConnection {
        await eventually("attempt \(index + 1) to open") { connector.connections.count > index }
        return connector.connections[index]
    }

    func waitForHelloSent(on connection: FakeConnection) async {
        await eventually("the hello to go out") { !connection.sent.isEmpty }
    }

    /// Waits until the socket is parked on a backoff timer and returns its length.
    func waitForBackoff(_ count: Int) async -> Duration {
        await eventually("backoff \(count) to be armed") { clock.requestedSleeps.count >= count }
        return clock.requestedSleeps[count - 1]
    }

    func connectFirstAttempt() async throws -> FakeConnection {
        let connection = await attempt(0)
        await waitForHelloSent(on: connection)
        try connection.acceptHello()
        await eventually("the socket to connect") { await isConnected() }
        return connection
    }

    func isConnected() async -> Bool {
        if case .connected = await socket.state() { return true }
        return false
    }

    /// Fails the newest attempt and waits for its backoff to be armed.
    func failAttempt(_ index: Int, sleepNumber: Int, error: Error = refused) async -> Duration {
        let connection = await attempt(index)
        await waitForHelloSent(on: connection)
        connection.fail(error)
        return await waitForBackoff(sleepNumber)
    }

    /// Runs the backoff ladder to its cap with the budget out of the way, and
    /// returns how many attempts and sleeps that took.
    func climbToCappedBackoff() async -> (attempts: Int, sleeps: Int) {
        let ladder: [Duration] = [.seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(16), .seconds(30)]
        for (index, expected) in ladder.enumerated() {
            let delay = await failAttempt(index, sleepNumber: index + 1)
            // The budget may stretch a rung but never shorten it.
            XCTAssertGreaterThanOrEqual(delay, expected, "rung \(index)")
            clock.advance(by: delay)
        }
        let delay = await failAttempt(ladder.count, sleepNumber: ladder.count + 1)
        XCTAssertEqual(delay, .seconds(30))
        return (ladder.count + 1, ladder.count + 1)
    }
}
