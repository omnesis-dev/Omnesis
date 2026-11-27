// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Darwin
import Foundation

/// Untrusted, ephemeral dial hints. No address here establishes a gateway identity.
public enum DesktopNearbyGatewayHints {
    public enum Failure: Error { case invalid }
    public enum State: String, Codable, Sendable { case finding, ready, denied, unavailable }
    private struct Key: CodingKey {
        let stringValue: String
        let intValue: Int? = nil
        init(stringValue: String) {
            self.stringValue = stringValue
        }

        init?(intValue: Int) {
            nil
        }
    }

    private static func keys(_ decoder: Decoder, _ expected: Set<String>) throws {
        guard try Set(decoder.container(keyedBy: Key.self).allKeys.map(\.stringValue)) == expected else { throw Failure.invalid }
    }

    static func privateAddress(_ input: String) -> String? {
        guard !input.isEmpty, input.utf8.count <= 45, !input.contains("%"), !input.utf8.contains(0) else { return nil }
        var v4 = in_addr()
        if input.withCString({ inet_pton(AF_INET, $0, &v4) }) == 1 {
            let bytes = withUnsafeBytes(of: v4) { Array($0) }
            guard bytes[0] == 10 || (bytes[0] == 172 && (16 ... 31).contains(bytes[1])) ||
                (bytes[0] == 192 && bytes[1] == 168) else { return nil }
            let canonical = bytes.map(String.init).joined(separator: ".")
            guard input == canonical else { return nil }
            return canonical
        }
        var v6 = in6_addr()
        guard input.withCString({ inet_pton(AF_INET6, $0, &v6) }) == 1,
              withUnsafeBytes(of: v6, { $0[0] & 0xFE == 0xFC }) else { return nil }
        var text = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
        guard withUnsafePointer(to: &v6, { inet_ntop(AF_INET6, $0, &text, socklen_t(INET6_ADDRSTRLEN)) }) != nil else { return nil }
        return String(cString: text)
    }

    public struct Candidate: Codable, Equatable, Sendable {
        public let address: String
        public let port: Int
        public let remainingMs: Int
        private enum CodingKeys: String, CodingKey { case address, port, remainingMs }
        public init(address: String, port: Int, remainingMs: Int) throws {
            guard let canonical = DesktopNearbyGatewayHints.privateAddress(address),
                  (1 ... 65535).contains(port), (1 ... 30000).contains(remainingMs) else { throw Failure.invalid }
            self.address = canonical
            self.port = port
            self.remainingMs = remainingMs
        }

        public init(from decoder: Decoder) throws {
            try DesktopNearbyGatewayHints.keys(decoder, ["address", "port", "remainingMs"])
            let values = try decoder.container(keyedBy: CodingKeys.self)
            try self.init(
                address: values.decode(String.self, forKey: .address),
                port: values.decode(Int.self, forKey: .port),
                remainingMs: values.decode(Int.self, forKey: .remainingMs)
            )
        }
    }

    public struct Snapshot: Codable, Equatable, Sendable {
        public let format: Int
        public let generation: UUID
        public let sequence: Int
        public let state: State
        public let candidates: [Candidate]
        private enum CodingKeys: String, CodingKey { case format, generation, sequence, state, candidates }
        public static var unavailable: Snapshot {
            Snapshot(knownGeneration: UUID())
        }

        private init(knownGeneration: UUID) {
            format = 1
            generation = knownGeneration
            sequence = 0
            state = .unavailable
            candidates = []
        }

        public init(generation: UUID = UUID(), sequence: Int = 0, state: State = .unavailable, candidates: [Candidate] = []) throws {
            guard (0 ... 9_007_199_254_740_991).contains(sequence), candidates.count <= 8,
                  Set(candidates.map { "\($0.address):\($0.port)" }).count == candidates.count,
                  ![State.denied, .unavailable].contains(state) || candidates.isEmpty else { throw Failure.invalid }
            format = 1
            self.generation = generation
            self.sequence = sequence
            self.state = state
            self.candidates = candidates
        }

        public init(from decoder: Decoder) throws {
            try DesktopNearbyGatewayHints.keys(decoder, ["format", "generation", "sequence", "state", "candidates"])
            let values = try decoder.container(keyedBy: CodingKeys.self)
            guard try values.decode(Int.self, forKey: .format) == 1 else { throw Failure.invalid }
            try self.init(
                generation: values.decode(UUID.self, forKey: .generation),
                sequence: values.decode(Int.self, forKey: .sequence),
                state: values.decode(State.self, forKey: .state),
                candidates: values.decode(
                    [Candidate].self,
                    forKey: .candidates
                )
            )
        }
    }

    public static func decode(_ data: Data) throws -> Snapshot {
        guard data.count <= 4096 else { throw Failure.invalid }
        return try JSONDecoder().decode(Snapshot.self, from: data)
    }
}
