// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
import Network
import Security

/// The TLS engine supplies a real peer trust; the owner retains its pin and attempt policy.
enum GatewayTLSNetworkConnection {
    typealias Connector = (NWEndpoint, String, DispatchQueue, @escaping @Sendable (SecTrust) -> Bool) -> any GatewayByteConnection

    static func make(
        endpoint: NWEndpoint,
        serverName: String,
        queue: DispatchQueue,
        verify: @escaping @Sendable (SecTrust) -> Bool
    )
        -> any GatewayByteConnection {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
        sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, serverName)
        sec_protocol_options_set_verify_block(
            tls.securityProtocolOptions,
            { _, trust, complete in
                complete(verify(sec_trust_copy_ref(trust).takeRetainedValue()))
            },
            queue
        )
        return GatewayNetworkTransport.live.makeConnection(endpoint, NWParameters(tls: tls, tcp: NWProtocolTCP.Options()))
    }
}
