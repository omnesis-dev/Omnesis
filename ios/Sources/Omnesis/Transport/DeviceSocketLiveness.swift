// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

@available(iOS 17.0, *)
extension DeviceSocket {
    public struct Liveness: Sendable {
        let helloTimeout: Duration
        let pingInterval: Duration
        let pongTimeout: Duration
        // Internal adapters expose legitimate late SDK/timer callbacks to tests.
        // Production always uses the platform clock and the real WebSocket ping.
        var wait: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
        var ping: @Sendable (URLSessionWebSocketTask, @escaping @Sendable (Error?) -> Void) -> Void = { task, completion in
            task.sendPing(pongReceiveHandler: completion)
        }

        public init(helloTimeout: Duration = .seconds(30), pingInterval: Duration = .seconds(20), pongTimeout: Duration = .seconds(5)) {
            self.helloTimeout = helloTimeout
            self.pingInterval = pingInterval
            self.pongTimeout = pongTimeout
        }
    }
}

@available(iOS 17.0, *)
struct GatewaySocketLivenessClock: DeviceSocketClock {
    let liveness: DeviceSocket.Liveness
    private let base = ContinuousDeviceSocketClock()
    var now: Duration {
        base.now
    }

    func sleep(for duration: Duration) async throws {
        try await liveness.wait(duration)
    }
}
