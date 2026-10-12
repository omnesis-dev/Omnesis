// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Reads what one morning brief was based on: the ranked observations the
/// Brain wrote it from, each with the documents behind it and the tasks it
/// touches.
public protocol DailyBriefItemsLoading: Sendable {
    func items(conversationId: String, day: String) async throws -> DailyBriefItems
}

/// Client for `GET /agent/conversations/:id/briefs/:day`. Same auth as
/// reading the conversation; the gateway answers 404 when no brief was sent
/// that day.
public final class DailyBriefClient: DailyBriefItemsLoading {
    public let baseURL: URL
    public let token: String
    private let session: URLSessionLike
    private let decoder = JSONDecoder()

    public init(baseURL: URL, token: String, session: URLSessionLike = OmnesisURLSession.shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
    }

    /// `GET /agent/conversations/:id/briefs/:day` — the brief sent on `day`
    /// (`YYYY-MM-DD`) and the ranked items it was written from.
    public func items(conversationId: String, day: String) async throws -> DailyBriefItems {
        let path = "/agent/conversations/\(percentEncode(conversationId))/briefs/\(percentEncode(day))"
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw GatewayClient.Error.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayClient.Error.invalidResponse
        }
        switch http.statusCode {
        case 200 ... 299:
            do {
                return try decoder.decode(DailyBriefItems.self, from: data)
            } catch {
                throw GatewayClient.Error.decoding("\(error)")
            }
        case 401: throw GatewayClient.Error.unauthorized
        case 403: throw GatewayClient.Error.forbidden
        case 404: throw GatewayClient.Error.notFound
        default:
            throw GatewayClient.Error.serverError(
                status: http.statusCode,
                body: String(data: data, encoding: .utf8) ?? ""
            )
        }
    }

    private func percentEncode(_ raw: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove("/")
        return raw.addingPercentEncoding(withAllowedCharacters: allowed) ?? raw
    }
}

// MARK: - Wire types

/// One morning brief and what it was based on, most important first.
public struct DailyBriefItems: Decodable, Sendable, Equatable {
    public let day: String
    public let messageId: String
    /// When the brief was sent (ISO 8601, UTC).
    public let sentAt: String?
    public let items: [DailyBriefItem]

    public init(day: String, messageId: String, sentAt: String? = nil, items: [DailyBriefItem]) {
        self.day = day
        self.messageId = messageId
        self.sentAt = sentAt
        self.items = items
    }

    private enum CodingKeys: String, CodingKey {
        case day, messageId, sentAt, items
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        day = try values.decode(String.self, forKey: .day)
        messageId = try values.decode(String.self, forKey: .messageId)
        sentAt = try? values.decodeIfPresent(String.self, forKey: .sentAt)
        // One item this build cannot read is dropped; the rest still show.
        items = (try? values.decodeIfPresent([Lossy<DailyBriefItem>].self, forKey: .items))?
            .compactMap(\.value) ?? []
    }
}

/// One thing a brief was based on: a plain sentence, the documents behind
/// it and the tasks it touches.
public struct DailyBriefItem: Decodable, Sendable, Equatable, Identifiable {
    public var id: String {
        observationId
    }

    public let rank: Int
    public let observationId: String
    public let summary: String
    public let sources: [DailyBriefSource]
    public let tasks: [DailyBriefTask]

    public init(
        rank: Int,
        observationId: String,
        summary: String,
        sources: [DailyBriefSource] = [],
        tasks: [DailyBriefTask] = []
    ) {
        self.rank = rank
        self.observationId = observationId
        self.summary = summary
        self.sources = sources
        self.tasks = tasks
    }

    private enum CodingKeys: String, CodingKey {
        case rank, observationId, summary, sources, tasks
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        rank = try values.decodeIfPresent(Int.self, forKey: .rank) ?? 0
        observationId = try values.decode(String.self, forKey: .observationId)
        summary = try values.decode(String.self, forKey: .summary)
        sources = (try? values.decodeIfPresent([Lossy<DailyBriefSource>].self, forKey: .sources))?
            .compactMap(\.value) ?? []
        tasks = (try? values.decodeIfPresent([Lossy<DailyBriefTask>].self, forKey: .tasks))?
            .compactMap(\.value) ?? []
    }
}

/// A document an item rests on.
public struct DailyBriefSource: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    /// Nil when the document has no title.
    public let title: String?
    public let sourceType: String
    public let createdAt: String?

    public init(id: String, title: String?, sourceType: String, createdAt: String? = nil) {
        self.id = id
        self.title = title
        self.sourceType = sourceType
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, sourceType, createdAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        title = try? values.decodeIfPresent(String.self, forKey: .title)
        sourceType = (try? values.decodeIfPresent(String.self, forKey: .sourceType)) ?? ""
        createdAt = try? values.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

/// A task an item touches.
public struct DailyBriefTask: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let title: String
    /// The task's state as the gateway names it (`open`, `done`, …).
    public let state: String

    public init(id: String, title: String, state: String) {
        self.id = id
        self.title = title
        self.state = state
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, state
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        title = (try? values.decodeIfPresent(String.self, forKey: .title)) ?? ""
        state = (try? values.decodeIfPresent(String.self, forKey: .state)) ?? "open"
    }

    /// Whether the task is finished one way or another.
    public var isResolved: Bool {
        state != "open"
    }
}

/// Decodes one element without failing the list it sits in.
private struct Lossy<Value: Decodable>: Decodable {
    let value: Value?

    init(from decoder: Decoder) throws {
        value = try? Value(from: decoder)
    }
}
