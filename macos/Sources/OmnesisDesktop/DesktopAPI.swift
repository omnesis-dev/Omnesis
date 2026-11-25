// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import DesktopCore
import Foundation
import Omnesis
import Security

/// Missing desktop administration operations over the existing gateway API.
/// Chat and its streaming protocol use the shared Apple client unchanged.
final class DesktopAPI: @unchecked Sendable {
    let connection: DesktopConnection
    let session: URLSession
    let agent: AgentClient
    let admin: AdminClient
    private let pin: PinnedSession?

    init(connection: DesktopConnection, sessionOverride: URLSession? = nil) throws {
        guard connection.url.user == nil, connection.url.password == nil,
              connection.url.query == nil, connection.url.fragment == nil,
              connection.url.path.isEmpty || connection.url.path == "/" else {
            throw DesktopAPIError.message("Omnesis received an invalid library address.")
        }
        let local = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(connection.url.host?.lowercased() ?? "")
        guard connection.url.scheme == "https" || (connection.url.scheme == "http" && local) else {
            throw DesktopAPIError.message("Omnesis requires an encrypted connection to your library.")
        }
        self.connection = connection
        if let sessionOverride {
            pin = nil
            session = sessionOverride
        } else if let pem = connection.certificatePEM {
            let base64 = pem.replacingOccurrences(of: "-----BEGIN CERTIFICATE-----", with: "")
                .replacingOccurrences(of: "-----END CERTIFICATE-----", with: "")
                .components(separatedBy: .whitespacesAndNewlines).joined()
            guard let der = Data(base64Encoded: base64), SecCertificateCreateWithData(nil, der as CFData) != nil else {
                throw DesktopAPIError.message("Omnesis could not verify the library’s certificate.")
            }
            let fingerprint = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
            let pinned = PinnedSession(fingerprintHex: fingerprint, host: connection.url.host)
            pin = pinned
            session = pinned.session
        } else {
            pin = nil
            session = URLSession(configuration: .ephemeral)
        }
        agent = AgentClient(baseURL: connection.url, token: connection.token, session: session)
        admin = AdminClient(baseURL: connection.url, token: connection.token, session: session)
    }

    func request<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> T {
        guard !path.hasPrefix("/"), !path.contains("://"),
              let url = URL(string: path, relativeTo: connection.url)?.absoluteURL,
              url.host == connection.url.host, url.port == connection.url.port, url.scheme == connection.url.scheme else {
            throw DesktopAPIError.message("Omnesis received an invalid request path.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 70
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200 ..< 300).contains(response.statusCode) else {
            struct Refusal: Decodable { let error: String?
                let code: String?
            }
            let refusal = try? JSONDecoder().decode(Refusal.self, from: data)
            throw DesktopAPIError.refusal(
                status: response.statusCode,
                code: refusal?.code,
                message: refusal?.error ?? "Omnesis could not complete this request (\(response.statusCode))."
            )
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func sources() async throws -> [DesktopSource] {
        let page: Rows<DesktopSource> = try await request("GET", "admin/sources")
        return page.items
    }

    func devices() async throws -> [DesktopDevice] {
        let page: Rows<DesktopDevice> = try await request("GET", "admin/devices")
        return page.items
    }

    func descriptors() async throws -> [DesktopDescriptor] {
        let page: Rows<DesktopDescriptor> = try await request("GET", "admin/source-descriptors")
        return page.items
    }

    func mutate(_ method: String = "POST", _ path: String, body: [String: Any] = [:]) async throws {
        let _: LooseReply = try await request(method, path, body: body)
    }

    struct Rows<T: Decodable>: Decodable { let items: [T] }
    struct LooseReply: Decodable {}
}

enum DesktopAPIError: LocalizedError {
    case message(String)
    case refusal(status: Int, code: String?, message: String)
    var errorDescription: String? {
        switch self {
        case .message(let text), .refusal(_, _, let text): text
        }
    }
}

struct DesktopSource: Decodable, Identifiable {
    let id: String
    let type: String
    let accountId: String
    let enabled: Bool
    let deviceId: String
    let members: [String]?
    let multiDeviceMode: String?
}

struct DesktopDevice: Decodable, Identifiable {
    let id: String
    let name: String
    let kind: String
    let online: Bool?
    let revokedAt: Double?
}

struct DesktopDescriptor: Decodable, Identifiable {
    let id: String
    let name: String
    let description: String
    let hasAuthFlow: Bool
    let hasDiscover: Bool
    let hasResolveAccountId: Bool?
    let acceptsAuthCode: Bool?
    let multiDeviceMode: String?
    let singleInstance: Bool?
    let authType: String?
    let experimental: Bool?
    let provider: Provider?
    struct Provider: Decodable { let id: String
        let name: String
    }

    let memberScopedParamNames: [String]?
    let params: [Param]?
    let devices: [Host]?
    let credentials: Credentials?
    let setupGuide: String?
    let gatewayHosted: Bool?
    let pushBased: Bool?
    let widgetOrigins: WidgetOrigins?

    struct WidgetOrigins: Decodable {
        let script: [String]?
        let frame: [String]?
        let connect: [String]?
    }

    struct Host: Decodable, Identifiable { let id: String
        let name: String?
    }

    struct Param: Decodable, Identifiable {
        let name: String
        let label: String
        let type: String
        let required: Bool?
        let placeholder: String?
        let help: String?
        let options: [Option]?
        let scope: String?
        let pattern: String?
        let patternHint: String?
        let validateWhenEmpty: Bool?
        let provesLocalAvailabilityForAccount: String?
        var id: String {
            name
        }

        struct Option: Decodable, Identifiable { let value: String
            let label: String
            var id: String {
                value
            }
        }
    }

    struct Credentials: Decodable {
        let fileKey: String
        let fields: [Field]
        let required: Bool?
        let perAccount: Bool?
        let publicClient: Bool?
        let wizard: Wizard?
        struct Wizard: Decodable {
            let intro: String
            let why: String
            let estMinutes: Int
            let steps: [Step]
            struct Step: Decodable {
                let kind: String
                let title: String
                let body: String
                let url: URL?
            }
        }

        struct Field: Decodable, Identifiable {
            let name: String
            let label: String
            let secret: Bool?
            let placeholder: String?
            let `default`: String?
            let required: Bool?
            let pattern: String?
            let patternHint: String?
            var id: String {
                name
            }
        }
    }
}
