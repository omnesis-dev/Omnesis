// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import DesktopCore
import XCTest

final class RuntimeProtocolTests: XCTestCase {
    func testHomeDoesNotOpenWithoutConfirmedEncryption() throws {
        let state = try JSONDecoder().decode(DesktopState.self, from: Data(
            #"{"phase":"ready","mode":"home","connection":{"url":"https://localhost:17601","token":"fixture-token"}}"#.utf8
        ))
        XCTAssertFalse(state.canOpenLibrary)
        XCTAssertEqual(state.statusLabel, "Checking your library’s protection")
    }

    func testReadyRequiresAnActualTrustedConnection() throws {
        XCTAssertFalse(DesktopState(phase: .ready, mode: "joined").canOpenLibrary)
        let state = try JSONDecoder().decode(DesktopState.self, from: Data(
            #"{"phase":"ready","mode":"joined","encrypted":true,"connection":{"url":"https://localhost:17601","token":"fixture-token"}}"#
                .utf8
        ))
        XCTAssertTrue(state.canOpenLibrary)
    }

    func testJoinedLibraryNeverOpensWithUnknownOrRefusedProtection() throws {
        for encryption in ["null", "false"] {
            let wire = #"{"phase":"ready","mode":"joined","encrypted":\#(encryption),"connection":{"url":"https://localhost:17601","token":"fixture-token"}}"#
            let state = try JSONDecoder().decode(DesktopState.self, from: Data(wire.utf8))
            XCTAssertFalse(state.canOpenLibrary)
            XCTAssertEqual(state.statusLabel, "Checking your library’s protection")
        }
    }

    func testFragmentedLinesAndMultipleFrames() throws {
        var buffer = JSONLineBuffer()
        XCTAssertTrue(try buffer.append(Data(#"{"event":"sta"#.utf8)).isEmpty)
        let lines = try buffer.append(Data("tus\"}\n{\"ok\":true}\n".utf8))
        XCTAssertEqual(lines.map { String(decoding: $0, as: UTF8.self) }, [#"{"event":"status"}"#, #"{"ok":true}"#])
    }

    func testOversizedUnterminatedFrameIsRejected() {
        var buffer = JSONLineBuffer()
        XCTAssertThrowsError(try buffer.append(Data(repeating: 65, count: JSONLineBuffer.maximumLineBytes + 1)))
    }

    func testCommandAcknowledgementsDoNotBreakStatusStream() throws {
        let reply = try JSONDecoder().decode(
            BridgeEnvelope.self,
            from: Data(#"{"id":"cancel-1","ok":true,"result":{"cancelled":true}}"#.utf8)
        )
        XCTAssertEqual(reply.id, "cancel-1")
        XCTAssertNil(reply.result)
    }

    func testProtocolAcceptsNullAndGenericInteractionAcknowledgements() throws {
        for payload in ["null", #"{"accepted":true}"#, #"{"cancelled":true}"#] {
            let wire = #"{"id":"response-1","ok":true,"result":\#(payload)}"#
            let envelope = try JSONDecoder().decode(BridgeEnvelope.self, from: Data(wire.utf8))
            XCTAssertEqual(envelope.id, "response-1")
            XCTAssertEqual(envelope.ok, true)
            XCTAssertNil(envelope.result)
        }
    }

    func testSignupAndMeasuredDownloadProgressDoNotChangeLibraryAdmission() throws {
        let wire = #"{"phase":"preparing","mode":"home","encrypted":true,"signup":{"policy":"invite","acmeTermsUrl":"https://ca.example.com/terms"},"searchModel":{"state":"downloading","downloadedBytes":256,"totalBytes":1024}}"#
        let state = try JSONDecoder().decode(DesktopState.self, from: Data(wire.utf8))
        XCTAssertEqual(state.signup?.policy, "invite")
        XCTAssertEqual(state.searchModel?.downloadedBytes, 256)
        XCTAssertEqual(state.searchModel?.totalBytes, 1024)
        XCTAssertFalse(state.canOpenLibrary)
    }

    func testUnsupportedBridgeVersionFailsClosed() throws {
        XCTAssertThrowsError(try JSONDecoder().decode(
            BridgeEnvelope.self,
            from: Data(#"{"version":2,"id":"request-1","ok":true,"result":null}"#.utf8)
        ))
        let legacy = try JSONDecoder().decode(BridgeEnvelope.self, from: Data(#"{"id":"request-1","ok":true,"result":null}"#.utf8))
        XCTAssertEqual(legacy.version, 1)
        let request = try JSONSerialization.jsonObject(with: JSONEncoder().encode(BridgeRequest(command: "status"))) as? [String: Any]
        XCTAssertEqual(request?["version"] as? Int, 1)
    }

    func testRequestsPreserveUserInputWithoutShellInterpretation() throws {
        let input = "A Mac with spaces; $(not-a-command)"
        let request = BridgeRequest(id: "request-1", command: "prepare", params: ["name": .string(input)])
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        XCTAssertEqual((json?["params"] as? [String: String])?["name"], input)
    }
}

extension RuntimeProtocolTests {
    func testRecoveryRepliesDecodeWithoutBecomingLibraryState() throws {
        let status = try JSONDecoder().decode(
            BridgeEnvelope.self,
            from: Data(#"{"version":1,"id":"recovery","ok":true,"result":{"available":true,"hasEnvelope":true,"envelopeValid":true}}"#.utf8)
        )
        XCTAssertTrue(try XCTUnwrap(status.recoveryStatus).available)
        XCTAssertNil(status.result)
        let draft = try JSONDecoder().decode(
            BridgeEnvelope.self,
            from: Data(
                #"{"version":1,"id":"draft","ok":true,"result":{"draftId":"fixture","expiresAt":1,"recoveryCode":"fictional-code","envelope":{"version":1,"sealed":"fictional"}}}"#
                    .utf8
            )
        )
        XCTAssertTrue(try XCTUnwrap(draft.recoveryDraft).expired)
        let data = try XCTUnwrap(draft.recoveryDraft).envelopeData()
        let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(envelope?["sealed"] as? String, "fictional")
        XCTAssertNil(envelope?["recoveryCode"])
        let commit = try JSONDecoder().decode(BridgeEnvelope.self, from: Data(#"{"id":"commit","ok":true,"result":{"saved":true}}"#.utf8))
        XCTAssertTrue(try XCTUnwrap(commit.recoveryCommit).saved)
        XCTAssertNil(commit.result)
    }
}
