// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

/// Launch arguments only correlate the one live signed client; socket peer identity supplies authority.
public struct DesktopBackgroundOriginHandoff: Codable, Equatable, Sendable {
    public let version: Int
    public let clientPID: Int32
    public let birth: DesktopBackgroundRebind.Birth
    public let nonce: String
    public let scope: DesktopBackgroundDaemonAuthority.Scope
    public let epoch: String

    public static func current(scope: DesktopBackgroundDaemonAuthority.Scope, epoch: String) throws -> Self {
        let current = try DesktopBackgroundProcessIdentity.read(getpid())
        return .init(
            version: 1,
            clientPID: current.pid,
            birth: .init(seconds: String(current.startedSeconds), microseconds: String(current.startedMicroseconds)),
            nonce: UUID().uuidString.lowercased(),
            scope: scope,
            epoch: epoch
        )
    }

    public func encoded() throws -> String {
        let bytes = try JSONEncoder().encode(self)
        guard bytes.count <= 4096 else { throw DesktopBackgroundLaunchProtocol.Failure.invalidFrame }
        return Self.base64(bytes)
    }

    public static func decode(_ text: String) throws -> Self {
        guard text.count <= 8192, !text.contains("="),
              let bytes = Data(base64Encoded: text.replacingOccurrences(of: "-", with: "+")
                  .replacingOccurrences(of: "_", with: "/") + String(
                      repeating: "=",
                      count: (4 - text.count % 4) % 4
                  )),
              bytes.count <= 4096, base64(bytes) == text,
              let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              Set(value.keys) == ["version", "clientPID", "birth", "nonce", "scope", "epoch"],
              let birth = value["birth"] as? [String: Any], Set(birth.keys) == ["seconds", "microseconds"],
              let scope = value["scope"] as? [String: Any],
              Set(scope.keys) == ["format", "configDir", "instance", "secretService"]
        else { throw DesktopBackgroundLaunchProtocol.Failure.invalidFrame }
        let result = try JSONDecoder().decode(Self.self, from: bytes)
        guard result.version == 1, result.clientPID > 1, result.scope.format == 1,
              UUID(uuidString: result.nonce) != nil, result.nonce == result.nonce.lowercased(),
              decimal(result.birth.seconds), decimal(result.birth.microseconds),
              let micros = UInt64(result.birth.microseconds),
              micros < 1_000_000 else { throw DesktopBackgroundLaunchProtocol.Failure.invalidFrame }
        // The same fixed descriptor schema validates scope, epoch and forbidden extra purposes.
        let descriptor: [String: Any] = ["version": result.version, "scope": scope, "epoch": result.epoch]
        _ = try DesktopBackgroundDaemonAuthority.decode(base64(JSONSerialization.data(withJSONObject: descriptor)), requiresNonce: false)
        return result
    }

    public func matches(
        peer: DesktopBackgroundPeerTrust.Peer,
        nonce: String,
        scope: DesktopBackgroundDaemonAuthority.Scope,
        epoch: String
    )
        -> Bool {
        peer.kind == .client && peer.pid == clientPID && self.nonce == nonce && self.scope == scope && self.epoch == epoch &&
            birth.seconds == String(peer.identity.startedSeconds) && birth.microseconds == String(peer.identity.startedMicroseconds)
    }

    private static func decimal(_ value: String) -> Bool {
        UInt64(value).map { String($0) == value } == true
    }

    private static func base64(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(
                of: "/",
                with: "_"
            ).replacingOccurrences(of: "=", with: "")
    }
}
