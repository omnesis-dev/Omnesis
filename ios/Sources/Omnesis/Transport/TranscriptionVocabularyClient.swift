// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Corpus-derived hints travel only over the paired gateway's trusted session.
public final class TranscriptionVocabularyClient: Sendable {
    private let baseURL: URL
    private let token: String
    private let session: URLSessionLike

    public init(baseURL: URL, token: String, session: URLSessionLike = OmnesisURLSession.shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    public func fetch(locale: String) async throws -> TranscriptionVocabularySnapshot {
        let request = try Self.request(baseURL: baseURL, token: token, locale: locale)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw GatewayClient.Error.invalidResponse }
        switch http.statusCode {
        case 200 ... 299:
            guard data.count <= 65536 else { throw GatewayClient.Error.invalidResponse }
            return try JSONDecoder().decode(TranscriptionVocabularySnapshot.self, from: data)
        case 401: throw GatewayClient.Error.unauthorized
        case 403: throw GatewayClient.Error.forbidden
        case 404: throw GatewayClient.Error.notFound
        default: throw GatewayClient.Error.invalidResponse
        }
    }

    static func request(baseURL: URL, token: String, locale: String) throws -> URLRequest {
        guard let url = URL(string: "/inference/transcription-vocabulary", relativeTo: baseURL)?.absoluteURL else {
            throw GatewayClient.Error.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        let language = locale.replacingOccurrences(of: "_", with: "-")
        let hints = language.range(of: "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$", options: .regularExpression) != nil ? [language] : []
        request.httpBody = try JSONEncoder().encode(Context(purpose: "dictation", speaker: .init(isSelf: true), languageHints: hints))
        return request
    }

    private struct Speaker: Encodable { let isSelf: Bool }

    private struct Context: Encodable {
        let purpose: String
        let speaker: Speaker
        let languageHints: [String]
    }
}

public struct TranscriptionVocabularySnapshot: Decodable, Sendable {
    public struct Entry: Decodable, Sendable {
        public let text: String
        public let score: Double
    }

    public let enabled: Bool
    public let entries: [Entry]
    public let refreshAfterSeconds: Double
    public let expiresAfterSeconds: Double

    /// Apple accepts at most 100 phrases; arbitrary control characters and
    /// oversized server responses must never reach the recognition request.
    var phrases: [String] {
        guard enabled else { return [] }
        var seen = Set<String>()
        let candidates = entries.prefix(128).compactMap { entry -> String? in
            let trimmed = entry.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let phrase = trimmed.precomposedStringWithCanonicalMapping
            guard !phrase.isEmpty, phrase.count <= 256, phrase.utf8.count <= 512,
                  entry.score.isFinite,
                  !phrase.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
                  seen.insert(phrase.lowercased()).inserted
            else { return nil }
            return phrase
        }
        return Array(candidates.prefix(100))
    }
}
