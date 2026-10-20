// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// The gateway relays OpenAI's realtime event vocabulary over its authenticated socket.
enum RealtimeProtocol {
    static let supportedVersion = 2

    static func negotiatedVersion(minimum: Int, maximum: Int) -> Int? {
        guard minimum > 0, maximum >= minimum,
              minimum <= supportedVersion, maximum >= supportedVersion else { return nil }
        return supportedVersion
    }

    static func validateReady(_ event: [String: Any]) throws {
        guard event["protocolVersion"] as? Int == supportedVersion else {
            let message = "This gateway and app cannot start a compatible voice conversation. Update both and try again."
            throw NSError(
                domain: "RealtimeCall",
                code: 6,
                userInfo: [NSLocalizedDescriptionKey: message]
            )
        }
    }

    static func socketRequest(pairing: Pairing, conversationID: String? = nil) -> URLRequest? {
        guard let url = socketURL(pairing.url, conversationID: conversationID) else { return nil }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        request.setValue(String(supportedVersion), forHTTPHeaderField: "X-Omnesis-Realtime-Version")
        return request
    }

    static func socketURL(_ base: URL, conversationID: String? = nil, timeZone: String = TimeZone.current.identifier) -> URL? {
        var parts = URLComponents(url: base.appendingPathComponent("agent/realtime/ws"), resolvingAgainstBaseURL: false)
        guard parts?.scheme == "https" else { return nil }
        parts?.scheme = "wss"
        var query = [URLQueryItem(name: "timeZone", value: timeZone)]
        if let conversationID { query.append(URLQueryItem(name: "conversationId", value: conversationID)) }
        parts?.queryItems = query
        return parts?.url
    }

    static func event(_ data: Data) -> [String: Any]? {
        (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    static func audioAppend(_ audio: Data) -> [String: String] {
        ["type": "input_audio_buffer.append", "audio": audio.base64EncodedString()]
    }
}

/// Capability reads are read-only and use the same pinned gateway transport as chat.
enum RealtimeCapability {
    static func available(pairing: Pairing, session: URLSessionLike = OmnesisURLSession.shared) async throws -> Bool {
        var request = URLRequest(url: pairing.url.appendingPathComponent("agent/realtime"))
        request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
        struct ProtocolRange: Decodable {
            let min: Int
            let max: Int
        }
        struct Capability: Decodable {
            let available: Bool
            let directAgentTools: Bool?
            let canonicalAgentEvents: Bool?
            let protocolRange: ProtocolRange?

            enum CodingKeys: String, CodingKey {
                case available, directAgentTools, canonicalAgentEvents
                case protocolRange = "protocol"
            }
        }
        guard let capability = try? JSONDecoder().decode(Capability.self, from: data),
              let range = capability.protocolRange,
              RealtimeProtocol.negotiatedVersion(minimum: range.min, maximum: range.max) != nil else { return false }
        return capability.available && capability.directAgentTools == true && capability.canonicalAgentEvents == true
    }
}
