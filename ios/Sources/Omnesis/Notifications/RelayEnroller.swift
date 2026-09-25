// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

public struct RelayChallenge: Decodable, Equatable, Sendable {
    public let challengeId: String
}

public struct RelayCredential: Decodable, Equatable, Sendable {
    public let credential: String
}

public enum RelayEnrollerError: Error, Equatable {
    case invalidURL
    case invalidResponse
    case serverError(status: Int, body: String)
}

/// Possession-proof relay enrolment. The relay challenges the carrier token;
/// the app echoes that nonce and hands the resulting device-scoped credential
/// to its already-paired gateway.
public struct RelayEnroller: Sendable {
    public typealias Request = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    private let baseURL: URL
    private let request: Request

    public init(baseURL: URL, session: URLSession = .shared) {
        self.init(baseURL: baseURL) { request in try await session.data(for: request) }
    }

    public init(baseURL: URL, request: @escaping Request) {
        self.baseURL = baseURL
        self.request = request
    }

    public func enrol(
        deviceToken: String,
        bundleId: String,
        environment: String
    ) async throws
        -> RelayChallenge {
        try await post(
            path: "/v1/enrol",
            body: EnrolBody(
                platform: "ios",
                token: deviceToken,
                bundleId: bundleId,
                environment: environment
            ),
            as: RelayChallenge.self
        )
    }

    public func verify(challengeId: String, nonce: String) async throws -> RelayCredential {
        try await post(
            path: "/v1/enrol/verify",
            body: VerifyBody(challengeId: challengeId, nonce: nonce),
            as: RelayCredential.self
        )
    }

    private func post<Output: Decodable>(
        path: String,
        body: some Encodable,
        as: Output.Type
    ) async throws
        -> Output {
        guard baseURL.scheme?.lowercased() == "https",
              let url = URL(string: path, relativeTo: baseURL)?.absoluteURL
        else {
            throw RelayEnrollerError.invalidURL
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await request(urlRequest)
        guard let http = response as? HTTPURLResponse else {
            throw RelayEnrollerError.invalidResponse
        }
        guard (200 ... 299).contains(http.statusCode) else {
            throw RelayEnrollerError.serverError(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? ""
            )
        }
        do {
            return try JSONDecoder().decode(Output.self, from: data)
        } catch {
            throw RelayEnrollerError.invalidResponse
        }
    }

    private struct EnrolBody: Encodable {
        let platform: String
        let token: String
        let bundleId: String
        let environment: String
    }

    private struct VerifyBody: Encodable {
        let challengeId: String
        let nonce: String
    }
}
