// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

/// Authenticated metadata is not death proof; the fixed native repair rechecks the kernel incarnation.
public struct DesktopBackgroundOriginStatus: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case verified, pending, unavailable }
    public struct Client: Codable, Equatable, Sendable {
        public let pid: Int32
        public let birth: DesktopBackgroundRebind.Birth
        public init(pid: Int32, birth: DesktopBackgroundRebind.Birth) {
            self.pid = pid
            self.birth = birth
        }

        public func isGone() -> Bool {
            if let current = try? DesktopBackgroundProcessIdentity.read(pid) {
                return birth.seconds != String(current.startedSeconds) || birth.microseconds != String(current.startedMicroseconds)
            }
            errno = 0
            return Darwin.kill(pid, 0) != 0 && errno == ESRCH
        }
    }

    public let state: State
    public let client: Client?
    public init(state: State, client: Client? = nil) {
        self.state = state
        self.client = client
    }

    static func validate(_ value: Any?) throws {
        guard let value = value as? [String: Any], let state = value["state"] as? String,
              let selected = State(rawValue: state),
              Set(value.keys) == (selected == .pending ? ["state", "client"] : ["state"])
        else { throw DesktopBackgroundLaunchProtocol.Failure.invalidFrame }
        if selected == .pending {
            guard let client = value["client"] as? [String: Any], Set(client.keys) == ["pid", "birth"],
                  let pid = client["pid"] as? Int, pid > 1, pid <= Int(Int32.max),
                  let birth = client["birth"] as? [String: Any], Set(birth.keys) == ["seconds", "microseconds"],
                  let seconds = birth["seconds"] as? String, UInt64(seconds).map({ String($0) == seconds }) == true,
                  let micros = birth["microseconds"] as? String, let number = UInt64(micros), number < 1_000_000,
                  String(number) == micros else { throw DesktopBackgroundLaunchProtocol.Failure.invalidFrame }
        }
    }
}
