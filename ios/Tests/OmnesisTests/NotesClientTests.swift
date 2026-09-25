// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

final class NotesClientTests: XCTestCase {
    private final class MockSession: URLSessionLike, @unchecked Sendable {
        var requests: [URLRequest] = []
        var responder: ((URLRequest) -> (Data, URLResponse))?

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            requests.append(request)
            guard let responder else {
                throw GatewayClient.Error.invalidResponse
            }
            return responder(request)
        }
    }

    private let base = URL(string: "http://gateway.local:7600")!

    private func makeResponse(status: Int, body: String, url: URL) -> (Data, URLResponse) {
        let data = Data(body.utf8)
        let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (data, response)
    }

    private let entryJSON = """
    {
      "id": "note_1",
      "day": "2026-03-09",
      "capturedAt": "2026-03-09T09:31:47.000Z",
      "updatedAt": "2026-03-09T09:31:47.000Z",
      "text": "Renew the gym membership",
      "surface": "ios-siri",
      "deviceId": "dev_1"
    }
    """

    func testCreateNoteEncodesBodyAndDecodes201() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 201, body: self!.entryJSON, url: req.url!)
        }
        let client = NotesClient(baseURL: base, token: "omn_t", session: session)
        let capturedAt = try XCTUnwrap(NotesTime.date(fromISO: "2026-03-09T09:31:47.000Z"))

        let entry = try await client.createNote(
            id: "6f8f57e2-3b0c-4a5e-9c1d-2a7b8e4d0f11",
            text: "Renew the gym membership",
            capturedAt: capturedAt,
            capturedTimeZoneId: "Europe/London",
            capturedUtcOffsetSeconds: 0,
            surface: "ios-siri",
            deviceId: "dev_1"
        )

        XCTAssertEqual(entry.id, "note_1")
        XCTAssertEqual(entry.day, "2026-03-09")
        XCTAssertEqual(entry.surface, "ios-siri")

        let request = try XCTUnwrap(session.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/notes")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer omn_t")
        let sent = try JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any]
        // The client-generated idempotency key rides along as `id`.
        XCTAssertEqual(sent?["id"] as? String, "6f8f57e2-3b0c-4a5e-9c1d-2a7b8e4d0f11")
        XCTAssertEqual(sent?["text"] as? String, "Renew the gym membership")
        XCTAssertEqual(sent?["capturedAt"] as? String, "2026-03-09T09:31:47.000Z")
        XCTAssertEqual(sent?["capturedTimeZoneId"] as? String, "Europe/London")
        XCTAssertEqual(sent?["capturedUtcOffsetSeconds"] as? Int, 0)
        XCTAssertEqual(sent?["surface"] as? String, "ios-siri")
        XCTAssertEqual(sent?["deviceId"] as? String, "dev_1")
    }

    func testCreateNoteOmitsNilFields() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 201, body: self!.entryJSON, url: req.url!)
        }
        let client = NotesClient(baseURL: base, token: "omn_t", session: session)

        _ = try await client.createNote(text: "Renew the gym membership")

        let sent = try JSONSerialization
            .jsonObject(with: XCTUnwrap(session.requests.first?.httpBody)) as? [String: Any]
        XCTAssertNil(sent?["id"])
        XCTAssertNil(sent?["capturedAt"])
        XCTAssertNil(sent?["capturedTimeZoneId"])
        XCTAssertNil(sent?["capturedUtcOffsetSeconds"])
        XCTAssertNil(sent?["surface"])
        XCTAssertNil(sent?["deviceId"])
        // A fix-less capture sends no location keys at all (the gateway's
        // optional fields accept absent, but a JSON null would fail them).
        XCTAssertNil(sent?["latitude"])
        XCTAssertNil(sent?["longitude"])
        XCTAssertNil(sent?["placeName"])
    }

    func testCreateNoteEncodesLocation() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 201, body: self!.entryJSON, url: req.url!)
        }
        let client = NotesClient(baseURL: base, token: "omn_t", session: session)

        _ = try await client.createNote(
            text: "Scout this venue",
            surface: "ios-siri",
            location: NoteLocation(latitude: 48.8566, longitude: 2.3522, placeName: "Paris")
        )

        let sent = try JSONSerialization
            .jsonObject(with: XCTUnwrap(session.requests.first?.httpBody)) as? [String: Any]
        XCTAssertEqual(sent?["latitude"] as? Double ?? 0, 48.8566, accuracy: 0.0001)
        XCTAssertEqual(sent?["longitude"] as? Double ?? 0, 2.3522, accuracy: 0.0001)
        XCTAssertEqual(sent?["placeName"] as? String, "Paris")
    }

    func testCreateNoteOmitsPlaceNameWhenGeocodeMissed() async throws {
        let session = MockSession()
        session.responder = { [weak self] req in
            self!.makeResponse(status: 201, body: self!.entryJSON, url: req.url!)
        }
        let client = NotesClient(baseURL: base, token: "omn_t", session: session)

        // A fix with no place name (offline geocode) sends the coordinate
        // but omits `placeName`.
        _ = try await client.createNote(
            text: "note",
            location: NoteLocation(latitude: 10, longitude: 20, placeName: nil)
        )

        let sent = try JSONSerialization
            .jsonObject(with: XCTUnwrap(session.requests.first?.httpBody)) as? [String: Any]
        XCTAssertEqual(sent?["latitude"] as? Double, 10)
        XCTAssertEqual(sent?["longitude"] as? Double, 20)
        XCTAssertNil(sent?["placeName"])
    }

    func testNoteEntryDecodesLocation() async throws {
        let session = MockSession()
        let geoJSON = """
        {"id":"note_1","day":"2026-03-09","capturedAt":"2026-03-09T09:31:47.000Z",
         "updatedAt":"2026-03-09T09:31:47.000Z","text":"note","surface":"ios-siri",
         "deviceId":"dev_1","latitude":51.5074,"longitude":-0.1278,"placeName":"London"}
        """
        session.responder = { [weak self] req in
            self!.makeResponse(status: 201, body: geoJSON, url: req.url!)
        }
        let client = NotesClient(baseURL: base, token: "omn_t", session: session)

        let entry = try await client.createNote(text: "note")
        XCTAssertEqual(entry.latitude ?? 0, 51.5074, accuracy: 0.0001)
        XCTAssertEqual(entry.longitude ?? 0, -0.1278, accuracy: 0.0001)
        XCTAssertEqual(entry.placeName, "London")
    }

    // MARK: - NotesTime

    func testIsoRoundTripKeepsFractionalSeconds() throws {
        let date = try XCTUnwrap(NotesTime.date(fromISO: "2026-03-09T09:31:47.250Z"))
        XCTAssertEqual(NotesTime.isoString(from: date), "2026-03-09T09:31:47.250Z")
    }

    func testIsoParsingToleratesPlainSeconds() {
        XCTAssertNotNil(NotesTime.date(fromISO: "2026-03-09T09:31:47Z"))
    }
}
