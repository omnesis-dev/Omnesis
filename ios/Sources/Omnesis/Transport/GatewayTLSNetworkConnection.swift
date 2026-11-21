// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Network
import Security

/// The TLS engine supplies a real peer trust; the owner retains its pin and attempt policy.
enum GatewayTLSNetworkConnection {
    /// How a handshake's peer trust is judged.
    ///
    /// `admits` runs on the owner's queue and says whether the attempt may still be authenticated; a
    /// trust it refuses is never evaluated. `evaluate` checks the trust itself. A trust evaluation can
    /// take as long as the platform takes to answer, so it runs on a queue of its own and must not touch
    /// the owner's state. `decide` then runs on the owner's queue with that result and returns the
    /// handshake's verdict: the owner records it there, or refuses a handshake whose attempt it abandoned
    /// meanwhile. The owner's queue stays free while a trust is evaluated, so its deadlines keep firing.
    struct Verification {
        let admits: () -> Bool
        let evaluate: @Sendable (SecTrust) -> Bool
        let decide: (Bool) -> Bool
    }

    typealias Connector = (NWEndpoint, String, DispatchQueue, Verification) -> any GatewayByteConnection

    static func make(
        endpoint: NWEndpoint,
        serverName: String,
        queue: DispatchQueue,
        verification: Verification
    )
        -> any GatewayByteConnection {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
        sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, serverName)
        let evaluation = DispatchQueue(label: "omnesis.gateway.tls-trust", qos: .userInitiated)
        sec_protocol_options_set_verify_block(
            tls.securityProtocolOptions,
            { _, trust, complete in
                guard verification.admits() else { return complete(false) }
                let peer = sec_trust_copy_ref(trust).takeRetainedValue()
                evaluation.async {
                    let accepted = verification.evaluate(peer)
                    queue.async { complete(verification.decide(accepted)) }
                }
            },
            queue
        )
        return GatewayNetworkTransport.live.makeConnection(endpoint, NWParameters(tls: tls, tcp: NWProtocolTCP.Options()))
    }
}
