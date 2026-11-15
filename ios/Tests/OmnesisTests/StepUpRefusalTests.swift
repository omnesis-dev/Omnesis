// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

@testable import Omnesis
import XCTest

/// Defect 6.2: a phone that joined by signing in, once the owner confirmed a passkey, is asked to
/// step up before it approves a device. The gateway answers 428 `STEP_UP_REQUIRED`, or 403
/// `STEP_UP_UNAVAILABLE` during a security lock (`packages/gateway/src/http/step-up.ts`). The
/// app must say so in plain words and send the person to the gateway's page, never a generic
/// "Permission denied" or a raw status.
final class StepUpRefusalTests: XCTestCase {
    private static let required =
        #"{"error":"Confirm this action with your passkey on the gateway's own page first.","code":"STEP_UP_REQUIRED","#
            + #""detail":{"method":"POST","path":"/admin/cloud-pairing/decision","bodySha256":"#
            + #""0000000000000000000000000000000000000000000000000000000000000000","#
            + #""options":"/admin/step-up/options","header":"X-Omnesis-Step-Up"}}"#
    private static let unavailable =
        #"{"error":"This action needs your passkey, which can't be used on this gateway right now. Do it on the gateway itself.","#
            + #""code":"STEP_UP_UNAVAILABLE"}"#
    private static let requestId = "00000000-0000-4000-8000-000000000901"

    private func client(_ session: StepUpHTTPSession) throws -> AdminClient {
        try AdminClient(baseURL: XCTUnwrap(URL(string: "https://g-1.relay.example.test")), token: "synthetic-token", session: session)
    }

    func testApprovingFromAPhoneThatMustStepUpSaysToConfirmOnTheGatewaysPage() async throws {
        let session = StepUpHTTPSession(status: 428, body: Self.required)
        do {
            try await client(session).decidePairingApproval(requestId: Self.requestId, approve: true)
            XCTFail("A 428 approval was taken as done")
        } catch {
            XCTAssertEqual(StepUpRefusal(error), .required)
            XCTAssertEqual(StepUpRefusal(error)?.title, "Confirm it's you")
        }
    }

    func testASecurityLockSaysOnlyTheGatewaysComputerCanMakeTheChange() async throws {
        let session = StepUpHTTPSession(status: 403, body: Self.unavailable)
        do {
            try await client(session).decidePairingApproval(requestId: Self.requestId, approve: true)
            XCTFail("A refused approval was taken as done")
        } catch {
            XCTAssertEqual(StepUpRefusal(error), .unavailable)
            XCTAssertEqual(StepUpRefusal(error)?.title, "Security lock is on")
            XCTAssertEqual(
                StepUpRefusal(error)?.message,
                "This change can only be made on the computer running Omnesis right now."
            )
            XCTAssertNil(StepUpRefusal(error)?.action)
        }
    }

    func testAnyOtherRefusalStaysWhatItWas() async throws {
        let plain = StepUpHTTPSession(status: 403, body: #"{"error":"forbidden","code":"FORBIDDEN"}"#)
        do {
            try await client(plain).decidePairingApproval(requestId: Self.requestId, approve: true)
            XCTFail("A 403 was taken as done")
        } catch {
            XCTAssertEqual(error as? GatewayClient.Error, .forbidden)
            XCTAssertNil(StepUpRefusal(error))
        }
        let empty = StepUpHTTPSession(status: 403, body: "")
        do {
            try await client(empty).decidePairingApproval(requestId: Self.requestId, approve: true)
            XCTFail("A 403 was taken as done")
        } catch { XCTAssertEqual(error as? GatewayClient.Error, .forbidden) }
        XCTAssertNil(StepUpRefusal(GatewayClient.Error.serverError(status: 500, body: "boom")))
        XCTAssertNil(StepUpRefusal(nil))
    }

    func testTheGatewaysPageIsOnTheAddressThePhoneUses() throws {
        let gateway = try XCTUnwrap(URL(string: "https://g-1.relay.example.test/some/path?x=1"))
        XCTAssertEqual(
            StepUpRefusal.page(gateway: gateway, path: "/portal/approve", fragment: Self.requestId)?.absoluteString,
            "https://g-1.relay.example.test/portal/approve#\(Self.requestId)"
        )
        XCTAssertNil(try StepUpRefusal.page(gateway: XCTUnwrap(URL(string: "http://g-1.relay.example.test")), path: "/portal/"))
        XCTAssertEqual(StepUpRefusal.required.action, "Open your gateway's page")
        XCTAssertEqual(StepUpRefusal.required.message, "This change needs Face ID on your gateway's page.")
    }

    /// The approval list keeps the request the gateway asked to step up for, opens the gateway's
    /// own approval page for exactly it, and shows no generic error beside it.
    @MainActor
    func testTheApprovalListOffersTheGatewaysPageForTheRequestThatNeedsIt() async throws {
        let session = StepUpHTTPSession(status: 428, body: Self.required)
        let client = try client(session)
        let model = GatewayPairingApprovalModel(now: { Date(timeIntervalSince1970: 1000) })
        await model.refresh(client: client)
        let request = try XCTUnwrap(model.requests.first)
        await model.confirmAndApprove(request, client: client)
        XCTAssertNil(model.error)
        XCTAssertEqual(model.stepUp, PairingStepUp(requestId: Self.requestId, refusal: .required))
        XCTAssertEqual(model.requests.map(\.id), [Self.requestId], "The request was dropped although it is still waiting")
        XCTAssertEqual(
            client.approvalPage(requestId: Self.requestId)?.absoluteString,
            "https://g-1.relay.example.test/portal/approve#\(Self.requestId)"
        )
        // Reading the list again forgets a refusal for a request that is no longer there.
        session.listed = false
        await model.refresh(client: client)
        XCTAssertNil(model.stepUp)
    }
}

private final class StepUpHTTPSession: URLSessionLike, @unchecked Sendable {
    let status: Int
    let body: String
    var listed = true
    init(status: Int, body: String) {
        self.status = status
        self.body = body
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        if request.httpMethod == "GET" {
            let items = listed
                ? #"[{"requestId":"00000000-0000-4000-8000-000000000901","kind":"portal","name":"Fictional laptop","#
                + #""status":"pending","verificationCode":"465 774","expiresAt":1100000}]"#
                : "[]"
            let ok = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (Data(#"{"items":\#(items)}"#.utf8), ok)
        }
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
}

/// M5: after a denial the owner may not have started that sign-in at all. One tap makes every new
/// device ask first, which only makes the gateway stricter, so the gateway never asks to step up.
@MainActor
final class PairingDenialFollowUpTests: XCTestCase {
    private final class Gateway: GatewayPairingApproving, CloudRelayManaging, @unchecked Sendable {
        var operations: [CloudRelayOperation] = []
        func pairingApprovalRequests() async throws -> [GatewayPairingApprovalRequest] {
            [GatewayPairingApprovalRequest(
                requestId: "00000000-0000-4000-8000-000000000902",
                kind: "ios",
                name: "Fictional phone",
                status: "pending",
                verificationCode: "081 434",
                expiresAt: 1_100_000,
                signIn: "google"
            )]
        }

        func decidePairingApproval(requestId _: String, approve _: Bool) async throws {}
        func cloudRelayStatus() async throws -> CloudRelayStatus {
            try JSONDecoder().decode(CloudRelayStatus.self, from: Data(#"{"enabled":true}"#.utf8))
        }

        func cloudRelay(_ operation: CloudRelayOperation) async throws -> CloudRelayStatus {
            operations.append(operation)
            return try await cloudRelayStatus()
        }
    }

    func testADenialOffersToMakeEveryNewDeviceAskFirst() async throws {
        let gateway = Gateway()
        let model = GatewayPairingApprovalModel(now: { Date(timeIntervalSince1970: 1000) })
        await model.askFirst(client: gateway)
        XCTAssertTrue(gateway.operations.isEmpty, "Asked first with nothing denied")
        await model.refresh(client: gateway)
        let request = try XCTUnwrap(model.requests.first)
        await model.decide(request, approve: false, client: gateway)
        XCTAssertEqual(model.denied?.id, request.id)
        XCTAssertTrue(model.requests.isEmpty)
        await model.askFirst(client: gateway)
        XCTAssertEqual(gateway.operations, [.setEnrollmentPolicy("ask")])
        XCTAssertTrue(model.askingFirst)
        await model.askFirst(client: gateway)
        XCTAssertEqual(gateway.operations.count, 1)
        model.stop()
        XCTAssertNil(model.denied)
        XCTAssertFalse(model.askingFirst)
    }
}

/// M5: the gateway suggests remembering the first confirmation, never for another Google account.
@MainActor
final class PairingRememberDefaultTests: XCTestCase {
    private struct Gateway: GatewayPairingApproving {
        let rows: [GatewayPairingApprovalRequest]
        func pairingApprovalRequests() async throws -> [GatewayPairingApprovalRequest] {
            rows
        }

        func pairingApprovals() async throws -> GatewayPairingApprovals {
            GatewayPairingApprovals(items: rows, stepUpRequired: true)
        }

        func decidePairingApproval(requestId _: String, approve _: Bool) async throws {}
    }

    private func row(_ id: String, remember: Bool? = nil, other: Bool? = nil) -> GatewayPairingApprovalRequest {
        GatewayPairingApprovalRequest(
            requestId: id,
            kind: "portal",
            name: "Fictional laptop",
            status: "pending",
            verificationCode: "465 774",
            expiresAt: 1_100_000,
            signIn: "google",
            canTrustSignIn: true,
            signInEmail: "maya@example.com",
            rememberByDefault: remember,
            otherGoogleAccount: other
        )
    }

    func testTheFirstConfirmationIsRememberedByDefaultOnceAndAnotherAccountNever() async {
        let first = row("00000000-0000-4000-8000-000000000911", remember: true)
        let other = row("00000000-0000-4000-8000-000000000912", other: true)
        let plain = row("00000000-0000-4000-8000-000000000913")
        let gateway = Gateway(rows: [first, other, plain])
        let model = GatewayPairingApprovalModel(now: { Date(timeIntervalSince1970: 1000) })
        await model.refresh(client: gateway)
        XCTAssertTrue(model.stepUpRequired)
        XCTAssertTrue(model.trustsSignIn(first))
        XCTAssertFalse(model.trustsSignIn(plain))
        model.setTrustSignIn(true, requestId: other.id)
        XCTAssertFalse(model.trustsSignIn(other), "Another Google account was remembered")
        // The owner's own choice stands across reads.
        model.setTrustSignIn(false, requestId: first.id)
        await model.refresh(client: gateway)
        XCTAssertFalse(model.trustsSignIn(first))
    }
}
