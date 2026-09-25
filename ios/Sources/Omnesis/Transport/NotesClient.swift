// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation

/// Client for the gateway's quick-capture `/notes` surface ("Tell
/// Omnesis"). Same shape as the other admin clients — same dispatch helper,
/// same `GatewayClient.Error` translation — and stays a thin transport:
/// offline queueing lives in `PendingNoteStore` / `NotesCoordinator`.
///
/// Current gateways always serve these routes; on an older version every
/// call 404s, which surfaces here as
/// `GatewayClient.Error.notFound`.
public final class NotesClient: Sendable {
    public let baseURL: URL
    public let token: String
    private let session: URLSessionLike
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(baseURL: URL, token: String, session: URLSessionLike = OmnesisURLSession.shared) {
        self.baseURL = baseURL
        self.token = token
        self.session = session
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    /// `POST /notes` — create one note. Capture entry points pass the
    /// instant, IANA zone, and observed UTC offset together so immediate
    /// and offline-queued delivery land on the original local day. `id` is an
    /// optional client-generated UUID the gateway uses as an idempotency
    /// key: retrying with the same id yields the same entry, never a
    /// duplicate — pass it so a POST whose response was lost is safe to
    /// replay from the pending queue.
    @discardableResult
    public func createNote(
        id: String? = nil,
        text: String,
        capturedAt: Date? = nil,
        capturedTimeZoneId: String? = nil,
        capturedUtcOffsetSeconds: Int? = nil,
        surface: String? = nil,
        deviceId: String? = nil,
        location: NoteLocation? = nil
    ) async throws
        -> NoteEntry {
        let body = CreateNoteRequest(
            id: id,
            text: text,
            capturedAt: capturedAt.map { NotesTime.isoString(from: $0) },
            capturedTimeZoneId: capturedTimeZoneId,
            capturedUtcOffsetSeconds: capturedUtcOffsetSeconds,
            surface: surface,
            deviceId: deviceId,
            latitude: location?.latitude,
            longitude: location?.longitude,
            placeName: location?.placeName
        )
        let (data, _) = try await dispatch(method: "POST", path: "/notes", body: encoder.encode(body))
        return try decodeOrThrow(NoteEntry.self, from: data)
    }

    // MARK: - Internals

    private func dispatch(
        method: String,
        path: String,
        body: Data?
    ) async throws
        -> (Data, HTTPURLResponse) {
        guard let requestURL = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw GatewayClient.Error.invalidURL
        }
        var request = URLRequest(url: requestURL)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayClient.Error.invalidResponse
        }
        switch http.statusCode {
        case 200 ... 299: return (data, http)
        case 401: throw GatewayClient.Error.unauthorized
        case 403: throw GatewayClient.Error.forbidden
        case 404: throw GatewayClient.Error.notFound
        default:
            let text = String(data: data, encoding: .utf8) ?? ""
            throw GatewayClient.Error.serverError(status: http.statusCode, body: text)
        }
    }

    private func decodeOrThrow<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do { return try decoder.decode(type, from: data) } catch { throw GatewayClient.Error.decoding("\(error)") }
    }
}

// MARK: - Wire types

/// One captured note, as the gateway returns it.
public struct NoteEntry: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    /// Local-day bucket, `YYYY-MM-DD` at capture time when timezone
    /// context was supplied (gateway-local when capture context is absent).
    public let day: String
    /// ISO-8601 capture timestamp.
    public let capturedAt: String
    /// ISO-8601 last-edit timestamp (== `capturedAt` until edited).
    public let updatedAt: String
    public let capturedTimeZoneId: String?
    public let capturedUtcOffsetSeconds: Int?
    public let receivedAt: String?
    public let text: String
    /// Capture surface slug (`NoteSurface`), or nil when unreported.
    public let surface: String?
    public let deviceId: String?
    /// WGS-84 capture location, or nil when the note was captured with no
    /// fix. `latitude`/`longitude` are always set together.
    public let latitude: Double?
    public let longitude: Double?
    /// Reverse-geocoded place name (e.g. "Paris"), or nil.
    public let placeName: String?

    public init(
        id: String,
        day: String,
        capturedAt: String,
        updatedAt: String,
        capturedTimeZoneId: String? = nil,
        capturedUtcOffsetSeconds: Int? = nil,
        receivedAt: String? = nil,
        text: String,
        surface: String?,
        deviceId: String?,
        latitude: Double? = nil,
        longitude: Double? = nil,
        placeName: String? = nil
    ) {
        self.id = id
        self.day = day
        self.capturedAt = capturedAt
        self.updatedAt = updatedAt
        self.capturedTimeZoneId = capturedTimeZoneId
        self.capturedUtcOffsetSeconds = capturedUtcOffsetSeconds
        self.receivedAt = receivedAt
        self.text = text
        self.surface = surface
        self.deviceId = deviceId
        self.latitude = latitude
        self.longitude = longitude
        self.placeName = placeName
    }
}

private struct CreateNoteRequest: Encodable {
    /// Client-generated UUID idempotency key (optional on the wire).
    let id: String?
    let text: String
    let capturedAt: String?
    let capturedTimeZoneId: String?
    let capturedUtcOffsetSeconds: Int?
    let surface: String?
    let deviceId: String?
    /// WGS-84 capture location. The synthesized encoder omits a nil
    /// optional entirely (`encodeIfPresent`), so a fix-less capture sends
    /// no location keys at all — which the gateway's `.optional()` fields
    /// accept as absent (a JSON `null` would fail them).
    let latitude: Double?
    let longitude: Double?
    let placeName: String?
}

/// Capture-surface slugs the iOS app reports on `POST /notes`. The
/// gateway stores them verbatim. Historical entry-point cases remain
/// so queued and server-backed notes keep their original provenance.
public enum NoteSurface: String, Sendable {
    case app = "ios-app"
    case siri = "ios-siri"
    case actionButton = "ios-action-button"
    case control = "ios-control"
    case widget = "ios-widget"
    case quickAction = "ios-quick-action"
    /// Dictated on the Apple Watch and relayed to the iPhone, which posts
    /// it (the watch holds no gateway pairing).
    case watch = "ios-watch"
}

/// ISO-8601 formatting shared by the notes transport and queue tests.
public enum NotesTime {
    /// ISO-8601 with fractional seconds — matches what the gateway's
    /// zod boundary accepts and emits.
    public static func isoString(from date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    /// Parse either plain or fractional-seconds ISO-8601 — the gateway
    /// emits fractional, but be lenient on the way in.
    public static func date(fromISO iso: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = fractional.date(from: iso) { return parsed }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: iso)
    }
}
