// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Security

/// Security setup operations, isolated so documented OS failures can be tested.
/// Certificate parsing, hashing and the final trust evaluation remain real.
struct PinnedTrustPlatformOperations {
    var certificateChain: (SecTrust) -> [SecCertificate]?
    var createTrust: ([SecCertificate], SecPolicy) -> (status: OSStatus, trust: SecTrust?)
    var setAnchors: (SecTrust, [SecCertificate]) -> OSStatus
    var setAnchorOnly: (SecTrust, Bool) -> OSStatus
    var setNetworkFetch: (SecTrust, Bool) -> OSStatus
    var setVerifyDate: (SecTrust, Date) -> OSStatus

    static let live = PinnedTrustPlatformOperations(
        certificateChain: { SecTrustCopyCertificateChain($0) as? [SecCertificate] },
        createTrust: { chain, policy in
            var trust: SecTrust?
            let status = SecTrustCreateWithCertificates(chain as CFArray, policy, &trust)
            return (status, trust)
        },
        setAnchors: { SecTrustSetAnchorCertificates($0, $1 as CFArray) },
        setAnchorOnly: { SecTrustSetAnchorCertificatesOnly($0, $1) },
        setNetworkFetch: { SecTrustSetNetworkFetchAllowed($0, $1) },
        setVerifyDate: { SecTrustSetVerifyDate($0, $1 as CFDate) }
    )
}
