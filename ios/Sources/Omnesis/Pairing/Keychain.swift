// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(Security)
import Security
#endif

/// Abstract storage used by pairing and the notification extension. Defaults
/// to Keychain in production; tests substitute an in-memory implementation.
public protocol PairingStore: Sendable {
    func set(_ value: String, forKey key: String) throws
    func get(_ key: String) throws -> String?
    func getLegacySynchronizable(_ key: String) throws -> String?
    func hasLegacySynchronizableValues() throws -> Bool
    func deleteLegacySynchronizableValues() throws
    func delete(_ key: String) throws
    func deleteAll() throws
}

/// Minimal Keychain wrapper focused on what OmnesisIos needs:
/// read/write/delete a small set of named strings (gateway URL, token,
/// accountId, gateway name).
///
/// Uses a `kSecClassGenericPassword` item scoped to our bundle. Entries are
/// stored device-only and never synced to iCloud Keychain, so the gateway
/// bearer token cannot leave this device via iCloud or a device-to-device
/// restore; moving to a new device is an explicit re-pair.
public struct Keychain: Sendable {
    public let service: String
    public let accessGroup: String?

    public init(
        service: String = "dev.omnesis.ios.pairing",
        accessGroup: String? = nil
    ) {
        self.service = service
        self.accessGroup = accessGroup
    }

    public enum Error: Swift.Error, Equatable {
        case unavailable
        case unexpectedStatus(Int32)
        case unexpectedData
    }

    /// Store a string under the given key, replacing any existing entry.
    ///
    /// Always delete-then-add rather than update-in-place: `SecItemUpdate`
    /// cannot change an item's accessibility or synchronizable class, so an
    /// install whose token was previously stored as syncable would keep those
    /// old attributes forever. Deleting first (matching both syncable and
    /// non-syncable rows) and re-adding guarantees every write lands with the
    /// current hardened, device-only attributes, self-healing older installs.
    public func set(_ value: String, forKey key: String) throws {
        #if canImport(Security)
        let data = Data(value.utf8)
        var matchQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        if let accessGroup { matchQuery[kSecAttrAccessGroup as String] = accessGroup }
        let deleteStatus = SecItemDelete(matchQuery as CFDictionary)
        if deleteStatus != errSecSuccess, deleteStatus != errSecItemNotFound {
            throw Error.unexpectedStatus(deleteStatus)
        }

        let addStatus = SecItemAdd(
            Self.addQuery(
                service: service,
                key: key,
                data: data,
                accessGroup: accessGroup
            ) as CFDictionary,
            nil
        )
        if addStatus != errSecSuccess {
            throw Error.unexpectedStatus(addStatus)
        }
        #else
        throw Error.unavailable
        #endif
    }

    #if canImport(Security)
    /// The `SecItemAdd` attributes for a stored value. Split out so tests can
    /// assert the security posture without a live Keychain.
    ///
    /// - Non-synchronizable: the value never rides iCloud Keychain to other devices.
    /// - `AfterFirstUnlockThisDeviceOnly`: readable after the first unlock
    ///   following a reboot (a background WebSocket reconnect needs it before
    ///   the user interactively unlocks), but bound to this device — excluded
    ///   from backups and device-to-device restores.
    static func addQuery(
        service: String,
        key: String,
        data: Data,
        accessGroup: String? = nil
    )
        -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    /// Query for a value written with the current device-only security
    /// posture. Deliberately excludes synchronizable and restorable rows:
    /// neither is valid evidence that this physical device was paired.
    static func deviceLocalReadQuery(
        service: String,
        key: String,
        accessGroup: String? = nil
    )
        -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecReturnData as String: kCFBooleanTrue as Any,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    /// Query for one value written by versions that synchronized the
    /// pairing bundle through iCloud Keychain.
    static func legacySynchronizableReadQuery(service: String, key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: kCFBooleanTrue as Any,
            kSecReturnData as String: kCFBooleanTrue as Any,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
    }

    /// Service-scoped cleanup for legacy iCloud rows. This must never use
    /// `kSecAttrSynchronizableAny`: a valid modern device-local pairing may
    /// coexist with a late-arriving legacy row and must survive cleanup.
    static func legacySynchronizableDeleteQuery(service: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: kCFBooleanTrue as Any,
        ]
    }
    #endif

    /// Fetch a string for the given key. Returns `nil` if not set.
    public func get(_ key: String) throws -> String? {
        #if canImport(Security)
        let query = Self.deviceLocalReadQuery(
            service: service,
            key: key,
            accessGroup: accessGroup
        )
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        if status != errSecSuccess {
            throw Error.unexpectedStatus(status)
        }
        guard let data = result as? Data, let str = String(data: data, encoding: .utf8) else {
            throw Error.unexpectedData
        }
        return str
        #else
        throw Error.unavailable
        #endif
    }

    /// Fetch a legacy iCloud-synchronizable value without ever treating it
    /// as a valid local credential.
    public func getLegacySynchronizable(_ key: String) throws -> String? {
        #if canImport(Security)
        let query = Self.legacySynchronizableReadQuery(service: service, key: key)
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        if status != errSecSuccess {
            throw Error.unexpectedStatus(status)
        }
        guard let data = result as? Data, let str = String(data: data, encoding: .utf8) else {
            throw Error.unexpectedData
        }
        return str
        #else
        throw Error.unavailable
        #endif
    }

    /// Whether any legacy iCloud-synchronizable pairing value exists.
    public func hasLegacySynchronizableValues() throws -> Bool {
        #if canImport(Security)
        var query = Self.legacySynchronizableDeleteQuery(service: service)
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        if status == errSecItemNotFound { return false }
        if status != errSecSuccess {
            throw Error.unexpectedStatus(status)
        }
        return true
        #else
        throw Error.unavailable
        #endif
    }

    /// Delete only the legacy iCloud-synchronizable rows for this service.
    public func deleteLegacySynchronizableValues() throws {
        #if canImport(Security)
        let query = Self.legacySynchronizableDeleteQuery(service: service)
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess, status != errSecItemNotFound {
            throw Error.unexpectedStatus(status)
        }
        #else
        throw Error.unavailable
        #endif
    }

    /// Delete the stored value for the given key (no-op if absent).
    public func delete(_ key: String) throws {
        #if canImport(Security)
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess, status != errSecItemNotFound {
            throw Error.unexpectedStatus(status)
        }
        #else
        throw Error.unavailable
        #endif
    }

    /// Wipe every key this Keychain instance has touched — used on unpair.
    public func deleteAll() throws {
        #if canImport(Security)
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess, status != errSecItemNotFound {
            throw Error.unexpectedStatus(status)
        }
        #else
        throw Error.unavailable
        #endif
    }
}

extension Keychain: PairingStore {}
