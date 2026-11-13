// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Restricted RFC1928/1929 handshake: authenticated CONNECT to exactly one paired DNS origin.
struct GatewaySOCKSHandshake {
    enum Effect: Equatable {
        case reply(Data)
        case connect
        case reject(Data)
    }

    private enum Stage { case greeting, credentials, request }
    private var stage: Stage? = .greeting
    private var buffer = Data()
    private let hostname: [UInt8]
    private let port: UInt16
    private let username: [UInt8]
    private let password: [UInt8]

    init(hostname: String, port: UInt16, username: String, password: String) {
        self.hostname = Array(hostname.utf8)
        self.port = port
        self.username = Array(username.utf8)
        self.password = Array(password.utf8)
    }

    mutating func receive(_ data: Data) -> [Effect] {
        var effects: [Effect] = []
        var pendingInput: Data? = data
        while let stage {
            if let input = pendingInput {
                guard buffer.count + input.count <= 2048 else { return reject([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]) }
                buffer.append(input)
                pendingInput = nil
            }
            let bytes = Array(buffer)
            let step: [Effect]? = switch stage {
            case .greeting: greeting(bytes)
            case .credentials: credentials(bytes)
            case .request: request(bytes)
            }
            guard let step else { return effects }
            effects += step
        }
        return effects
    }

    private mutating func greeting(_ bytes: [UInt8]) -> [Effect]? {
        guard bytes.count >= 2 else { return nil }
        guard bytes[0] == 5, bytes[1] > 0 else { return reject([5, 255]) }
        let length = Int(bytes[1]) + 2
        guard bytes.count >= length else { return nil }
        guard bytes[2 ..< length].contains(2) else { return reject([5, 255]) }
        buffer.removeFirst(length)
        stage = .credentials
        return [.reply(Data([5, 2]))]
    }

    private mutating func credentials(_ bytes: [UInt8]) -> [Effect]? {
        guard bytes.count >= 2 else { return nil }
        let userEnd = 2 + Int(bytes[1])
        guard bytes[0] == 1, bytes[1] > 0 else { return reject([1, 1]) }
        guard bytes.count > userEnd else { return nil }
        let end = userEnd + 1 + Int(bytes[userEnd])
        guard bytes[userEnd] > 0 else { return reject([1, 1]) }
        guard bytes.count >= end else { return nil }
        guard Self.matches(Array(bytes[2 ..< userEnd]), username), Self.matches(Array(bytes[(userEnd + 1) ..< end]), password)
        else { return reject([1, 1]) }
        buffer.removeFirst(end)
        stage = .request
        return [.reply(Data([1, 0]))]
    }

    private mutating func request(_ bytes: [UInt8]) -> [Effect]? {
        guard bytes.count >= 5 else { return nil }
        guard bytes[0] == 5, bytes[1] == 1, bytes[2] == 0, bytes[3] == 3, bytes[4] > 0
        else { return reject([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]) }
        let end = 5 + Int(bytes[4])
        guard bytes.count >= end + 2 else { return nil }
        let targetPort = UInt16(bytes[end]) << 8 | UInt16(bytes[end + 1])
        guard bytes[5 ..< end].map({ (65 ... 90).contains($0) ? $0 + 32 : $0 }) == hostname, targetPort == port,
              bytes.count == end + 2
        else { return reject([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]) }
        buffer.removeAll(keepingCapacity: false)
        stage = nil
        return [.connect]
    }

    private static func matches(_ provided: [UInt8], _ expected: [UInt8]) -> Bool {
        guard provided.count == expected.count else { return false }
        return zip(provided, expected).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }

    private mutating func reject(_ bytes: [UInt8]) -> [Effect] {
        stage = nil
        buffer.removeAll(keepingCapacity: false)
        return [.reject(Data(bytes))]
    }
}
