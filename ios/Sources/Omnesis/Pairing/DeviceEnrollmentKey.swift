// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Foundation
import Security

public protocol DeviceEnrollmentSigning: Sendable {
    /// Base64url DER SubjectPublicKeyInfo.
    var publicKey: String { get }
    /// ES256 over `transcript`, as base64url DER.
    func sign(_ transcript: Data) throws -> String
}

/// The one P-256 key an install proves itself with. It lives in the Secure Enclave where
/// there is one; the Keychain item holds the enclave's wrapped blob, or the software key
/// where there is none, such as the simulator. The item is `AfterFirstUnlockThisDeviceOnly`
/// and the key needs no user presence, so background work can use it like the gateway token.
public struct DeviceEnrollmentKey: DeviceEnrollmentSigning, @unchecked Sendable {
    private enum Backing {
        case enclave(SecureEnclave.P256.Signing.PrivateKey)
        case software(P256.Signing.PrivateKey)
    }

    private static let itemKey = "device.enrollment.key.v1"
    private static let lock = NSLock()
    private let backing: Backing

    public var publicKey: String {
        switch backing {
        case .enclave(let key): key.publicKey.derRepresentation.base64URLEncodedForEnrollment
        case .software(let key): key.publicKey.derRepresentation.base64URLEncodedForEnrollment
        }
    }

    public func sign(_ transcript: Data) throws -> String {
        let signature: Data = switch backing {
        case .enclave(let key): try key.signature(for: transcript).derRepresentation
        case .software(let key): try key.signature(for: transcript).derRepresentation
        }
        return signature.base64URLEncodedForEnrollment
    }

    /// Enrollment's own Keychain service, separate from the pairing bundle's: unpairing
    /// must not change who this install is.
    public static func sharedStore() -> any PairingStore {
        Keychain(service: "dev.omnesis.ios.enrollment")
    }

    /// A Keychain read failure, such as before the first unlock, is thrown rather than
    /// answered with a new key: only an absent or unusable item creates one.
    public static func loadOrCreate(
        store: any PairingStore = sharedStore(),
        enclaveAvailable: Bool = SecureEnclave.isAvailable
    ) throws
        -> Self {
        try lock.withLock {
            if let raw = try store.get(itemKey), let existing = decode(raw) { return existing }
            let enclave = enclaveAvailable ? makeEnclaveKey() : nil
            let backing = enclave.map(Backing.enclave) ?? .software(P256.Signing.PrivateKey())
            let created = Self(backing: backing)
            try store.set(created.encoded, forKey: itemKey)
            return created
        }
    }

    private static func makeEnclaveKey() -> SecureEnclave.P256.Signing.PrivateKey? {
        try? SecureEnclave.P256.Signing.PrivateKey(accessControl: accessControl())
    }

    private static func accessControl() throws -> SecAccessControl {
        var failure: Unmanaged<CFError>?
        guard let control = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            .privateKeyUsage,
            &failure
        ) else {
            if let failure { throw failure.takeRetainedValue() as Error }
            throw CloudPairingError.configuration
        }
        return control
    }

    private var encoded: String {
        switch backing {
        case .enclave(let key): "enclave:" + key.dataRepresentation.base64EncodedString()
        case .software(let key): "software:" + key.rawRepresentation.base64EncodedString()
        }
    }

    private static func decode(_ raw: String) -> Self? {
        let parts = raw.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2, let data = Data(base64Encoded: parts[1]) else { return nil }
        switch parts[0] {
        case "enclave":
            return (try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data)).map { Self(backing: .enclave($0)) }
        case "software":
            return (try? P256.Signing.PrivateKey(rawRepresentation: data)).map { Self(backing: .software($0)) }
        default:
            return nil
        }
    }
}

extension Data {
    var base64URLEncodedForEnrollment: String {
        let encoded = base64EncodedString()
        let urlAlphabet = encoded.replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        return urlAlphabet.replacingOccurrences(of: "=", with: "")
    }
}
