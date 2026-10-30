// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Authenticated transport used by the phone's durable complication inbox.
struct WatchCaptureClient: Sendable {
    let baseURL: URL
    let token: String
    var session: URLSessionLike = OmnesisURLSession.shared

    func route(_ text: String) async throws -> WatchCaptureRoute {
        struct Response: Decodable { let route: WatchCaptureRoute }
        let data = try await post(path: "/watch/capture/route", body: JSONEncoder().encode(["text": text]), contentType: "application/json")
        let route = try JSONDecoder().decode(Response.self, from: data).route
        guard route != .automatic else { throw GatewayClient.Error.invalidResponse }
        return route
    }

    func transcribe(_ file: URL, locale: String?, legacyGateway: Bool = false) async throws -> String? {
        struct Response: Decodable { let available: Bool
            let text: String?
        }
        let language = locale?.split(whereSeparator: { $0 == "_" || $0 == "-" }).first.map(String.init) ?? ""
        let suffix = language.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let endpoint = legacyGateway ? "/inference/transcribe" : "/watch/capture/transcribe"
        let data = try await post(
            path: "\(endpoint)?language=\(suffix)",
            body: Data(contentsOf: file),
            contentType: WatchVoiceFormat.contentType
        )
        let result = try JSONDecoder().decode(Response.self, from: data)
        return result.available ? result.text : nil
    }

    private func post(path: String, body: Data, contentType: String) async throws -> Data {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else { throw GatewayClient.Error.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        request.timeoutInterval = 60
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw GatewayClient.Error.invalidResponse }
        guard (200 ... 299).contains(http.statusCode) else {
            throw GatewayClient.Error.serverError(status: http.statusCode, body: "Watch capture request failed")
        }
        return data
    }
}
