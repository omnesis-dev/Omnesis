// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public protocol CloudPairingLeafTransportFactory: Sendable {
    func pinnedLeaf(_ fingerprint: String) -> any CloudPairingTransport
}

public protocol CloudPairingKeyTransportFactory: Sendable {
    func pinnedKey(_ spkiFingerprint: String, host: String) -> any CloudPairingTransport
}

/// Production composition is a concrete factory, independently testable from asynchronous discovery.
public struct CloudPairingHTTPFactory: CloudPairingLeafTransportFactory, CloudPairingKeyTransportFactory {
    private let verificationDate: Date?
    public init(verificationDate: Date? = nil) {
        self.verificationDate = verificationDate
    }

    public func pinnedLeaf(_ fingerprint: String) -> any CloudPairingTransport {
        CloudPairingHTTP(fingerprint: fingerprint, verificationDate: verificationDate)
    }

    public func pinnedKey(_ spkiFingerprint: String, host: String) -> any CloudPairingTransport {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 2.5
        configuration.timeoutIntervalForResource = 2.5
        return CloudPairingHTTP(
            spkiFingerprint: spkiFingerprint,
            canonicalHost: host,
            configuration: configuration,
            verificationDate: verificationDate
        )
    }
}
