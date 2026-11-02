// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation

public struct TaskWidgetCredential: Codable, Equatable, Sendable {
    public let url: URL
    public let token: String
    public let deviceId: String
    public let generation: String?
    public let tlsMode: String
    public let fingerprint: String?

    public init(
        url: URL,
        token: String,
        deviceId: String,
        generation: String? = nil,
        tlsMode: String,
        fingerprint: String? = nil
    ) {
        self.url = url
        self.token = token
        self.deviceId = deviceId
        self.generation = generation
        self.tlsMode = tlsMode
        self.fingerprint = fingerprint
    }

    /// Opaque authority carried by rendered actions. Neither the token nor any
    /// routing field is exposed to WidgetKit's intent parameter persistence.
    public var authorityID: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = (try? encoder.encode(self)) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public var isSecure: Bool {
        guard url.scheme?.lowercased() == "https", url.host != nil, !token.isEmpty else { return false }
        if tlsMode == "system" { return true }
        return tlsMode == "pinned-leaf" && fingerprint?.count == 64 && fingerprint?.allSatisfy(\.isHexDigit) == true
    }
}

/// Device-only Keychain storage shared exclusively by the app and its widgets.
/// Snapshot reads are fenced by the exact credential, including re-pair generation.
public enum TaskWidgetStorage {
    private static let credentialKey = "task-widget.credential.v1"
    private static let snapshotKey = "task-widget.snapshot.v1"
    private struct Cached: Codable {
        let credential: TaskWidgetCredential
        let snapshot: TaskWidgetSnapshot
    }

    public static func keychain() -> Keychain {
        Keychain(service: "dev.omnesis.ios.task-widgets", accessGroup: Bundle.main.object(
            forInfoDictionaryKey: "OmnesisTaskWidgetAccessGroup"
        ) as? String)
    }

    public static func credential(store: PairingStore = keychain()) throws -> TaskWidgetCredential? {
        guard let value: TaskWidgetCredential = try read(credentialKey, store: store), value.isSecure else { return nil }
        return value
    }

    public static func configure(_ value: TaskWidgetCredential?, store: PairingStore = keychain()) throws {
        guard let value, value.isSecure else {
            try clear(store: store)
            return
        }
        guard try credential(store: store) != value else { return }
        // Remove the old authority before exposing any new account routing.
        try store.delete(credentialKey)
        try store.delete(snapshotKey)
        try store.delete("task-widget.action-error")
        try write(value, key: credentialKey, store: store)
    }

    public static func snapshot(store: PairingStore = keychain()) throws -> TaskWidgetSnapshot? {
        guard let current = try credential(store: store),
              let cached: Cached = try read(snapshotKey, store: store), cached.credential == current else { return nil }
        return cached.snapshot
    }

    public static func save(
        snapshot: TaskWidgetSnapshot,
        credential expected: TaskWidgetCredential? = nil,
        store: PairingStore = keychain()
    ) throws {
        guard let current = try credential(store: store), expected == nil || expected == current else { return }
        if let cached: Cached = try read(snapshotKey, store: store), cached.credential == current,
           cached.snapshot.updatedAt > snapshot.updatedAt { return }
        try write(Cached(credential: current, snapshot: snapshot), key: snapshotKey, store: store)
    }

    public static func clear(store: PairingStore = keychain()) throws {
        try store.delete(credentialKey)
        try store.delete(snapshotKey)
        try store.delete("task-widget.action-error")
    }

    private static func read<T: Decodable>(_ key: String, store: PairingStore) throws -> T? {
        guard let raw = try store.get(key), let data = raw.data(using: .utf8) else { return nil }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private static func write(_ value: some Encodable, key: String, store: PairingStore) throws {
        let data = try JSONEncoder().encode(value)
        guard let raw = String(data: data, encoding: .utf8) else { throw Keychain.Error.unexpectedData }
        try store.set(raw, forKey: key)
    }
}
