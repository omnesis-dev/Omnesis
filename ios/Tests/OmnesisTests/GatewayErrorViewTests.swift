// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
@testable import Omnesis
import XCTest

/// Locks in the user-visible mapping from underlying `Error` values to
/// `GatewayErrorView.Kind` buckets and the copy each bucket renders.
/// Snapshot tests cover the rendered PNGs; these unit tests pin the
/// classifier so a regression in `classify(_:)` is caught directly
/// rather than via a noisy image diff.
@available(iOS 17.0, *)
@MainActor
final class GatewayErrorViewTests: XCTestCase {
    // MARK: - classify(_:)

    func testNilErrorClassifiesAsUnreachable() {
        XCTAssertEqual(GatewayErrorView.classify(nil), .gatewayUnreachable)
    }

    func testNetworkErrorsClassifyAsUnreachable() {
        let codes: [URLError.Code] = [
            .cannotConnectToHost,
            .notConnectedToInternet,
            .timedOut,
            .dnsLookupFailed,
            .networkConnectionLost,
            .cannotFindHost,
        ]
        for code in codes {
            XCTAssertEqual(
                GatewayErrorView.classify(URLError(code)),
                .gatewayUnreachable,
                "URLError(\(code.rawValue)) should fold to .gatewayUnreachable"
            )
        }
    }

    func testCertificateErrorsHaveSeparateRecoveryGuidance() {
        for code: URLError.Code in [.serverCertificateUntrusted, .secureConnectionFailed] {
            XCTAssertEqual(GatewayErrorView.classify(URLError(code)), .certificate)
        }
        XCTAssertTrue(GatewayErrorView.Kind.certificate.detail(for: "load people").contains("certificate covers that hostname"))
        XCTAssertTrue(GatewayErrorView.Kind.gatewayUnreachable.detail(for: "load people").contains("Tailscale hostname"))
    }

    func testUnauthorizedMapsToUnauthorized() {
        XCTAssertEqual(
            GatewayErrorView.classify(GatewayClient.Error.unauthorized),
            .unauthorized
        )
    }

    func testForbiddenMapsToForbidden() {
        XCTAssertEqual(
            GatewayErrorView.classify(GatewayClient.Error.forbidden),
            .forbidden
        )
    }

    func testServerErrorCarriesStatusAndBody() {
        let kind = GatewayErrorView.classify(GatewayClient.Error.serverError(
            status: 500,
            body: "Internal server error."
        ))
        XCTAssertEqual(kind, .server(status: 500, body: "Internal server error."))
    }

    func testAgentDisabledClassifiesAsAgentNotConfigured() {
        let bodies = [
            // The first-run "no model assigned to the agent capability"
            // body the gateway emits from agent-lifecycle.ts. This is the
            // common setup state, not a fault.
            "Agent disabled. Set inference.assignments.agent in omnesis.json (e.g. \"anthropic/claude-sonnet-4-6\") to enable it.",
            "Agent disabled. Set inference.assignments.agent in omnesis.json to enable it.",
            "Agent harness disabled. Set agent.backend to \"anthropic\" in omnesis.json.",
            "Anthropic API key not configured. Set it from the portal's Settings → Models tab.",
            "Replay backend selected but no fixture configured.",
        ]
        for body in bodies {
            XCTAssertEqual(
                GatewayErrorView.classify(GatewayClient.Error.serverError(status: 503, body: body)),
                .agentNotConfigured,
                "Expected .agentNotConfigured for body: \(body)"
            )
        }
    }

    func testNonAgentServer503StaysAsServer() {
        let kind = GatewayErrorView.classify(GatewayClient.Error.serverError(
            status: 503,
            body: "Service temporarily unavailable."
        ))
        XCTAssertEqual(kind, .server(status: 503, body: "Service temporarily unavailable."))
    }

    func testNon503WithAgentBodyDoesNotMisclassify() {
        // Only 503s should trigger .agentNotConfigured — a 500 with the
        // same body text is a genuine server error, not a config issue.
        let kind = GatewayErrorView.classify(GatewayClient.Error.serverError(
            status: 500,
            body: "Anthropic API key not configured."
        ))
        XCTAssertEqual(kind, .server(status: 500, body: "Anthropic API key not configured."))
    }

    func testNotFoundCollapsesToUnknown() {
        XCTAssertEqual(
            GatewayErrorView.classify(GatewayClient.Error.notFound),
            .unknown("Not found.")
        )
    }

    func testInvalidResponseCollapsesToUnknown() {
        XCTAssertEqual(
            GatewayErrorView.classify(GatewayClient.Error.invalidResponse),
            .unknown("The gateway returned an invalid response.")
        )
    }

    func testInvalidURLCollapsesToUnknown() {
        XCTAssertEqual(
            GatewayErrorView.classify(GatewayClient.Error.invalidURL),
            .unknown("The gateway URL is malformed. Open Settings to fix it.")
        )
    }

    func testDecodingEmbedsMessage() {
        XCTAssertEqual(
            GatewayErrorView.classify(GatewayClient.Error.decoding("bad json")),
            .unknown("Couldn't parse the gateway's response: bad json")
        )
    }

    func testUnknownFoundationErrorUsesLocalizedDescription() {
        struct CustomError: LocalizedError {
            var errorDescription: String? {
                "something went sideways"
            }
        }
        XCTAssertEqual(
            GatewayErrorView.classify(CustomError()),
            .unknown("something went sideways")
        )
    }

    // MARK: - Kind.detail(for:)

    func testServerDetailDropsStatusPrefixWhenBodyPresent() {
        let kind = GatewayErrorView.Kind.server(
            status: 503,
            body: "Anthropic API key not configured."
        )
        // The body alone is the message — no "status 503:" preamble.
        XCTAssertEqual(
            kind.detail(for: "start the agent"),
            "Anthropic API key not configured."
        )
    }

    func testServerDetailTrimsWhitespaceFromBody() {
        let kind = GatewayErrorView.Kind.server(
            status: 500,
            body: "  \n  trimmed message  \n  "
        )
        XCTAssertEqual(kind.detail(for: "load watches"), "trimmed message")
    }

    func testServerDetailFallsBackToStatusWhenBodyEmpty() {
        let kind = GatewayErrorView.Kind.server(status: 502, body: "")
        XCTAssertEqual(
            kind.detail(for: "load watches"),
            "The gateway returned status 502 while trying to load watches."
        )
    }

    func testServerDetailFallsBackToStatusWhenBodyWhitespaceOnly() {
        let kind = GatewayErrorView.Kind.server(status: 504, body: "   \n  ")
        XCTAssertEqual(
            kind.detail(for: "load watches"),
            "The gateway returned status 504 while trying to load watches."
        )
    }

    func testUnknownNonEmptyMessageReachesUserVerbatim() {
        let detail = GatewayErrorView.Kind.unknown("operator says X").detail(for: "anything")
        XCTAssertEqual(detail, "operator says X")
    }

    func testSettingsRecoveryReturnsToExistingStackInsteadOfPresentingSheet() {
        var returnedToRoot = false
        var presentedSheet = false

        GatewayErrorView.performSettingsRecovery(
            hasExistingSettingsStack: true,
            returnToExistingRoot: { returnedToRoot = true },
            presentNewSheet: { presentedSheet = true }
        )

        XCTAssertTrue(returnedToRoot)
        XCTAssertFalse(presentedSheet)
    }

    func testSettingsRecoveryPresentsSheetWithoutExistingStack() {
        var returnedToRoot = false
        var presentedSheet = false

        GatewayErrorView.performSettingsRecovery(
            hasExistingSettingsStack: false,
            returnToExistingRoot: { returnedToRoot = true },
            presentNewSheet: { presentedSheet = true }
        )

        XCTAssertFalse(returnedToRoot)
        XCTAssertTrue(presentedSheet)
    }

    func testUnreachableUsesNeutralTintAndWifiSymbol() {
        XCTAssertEqual(GatewayErrorView.Kind.gatewayUnreachable.symbol, "wifi.exclamationmark")
    }

    func testAuthFailuresShareLockShieldSymbol() {
        XCTAssertEqual(GatewayErrorView.Kind.unauthorized.symbol, "lock.shield")
        XCTAssertEqual(GatewayErrorView.Kind.forbidden.symbol, "lock.shield")
    }

    /// The transport throws the gateway's envelope verbatim. What a person
    /// reads must be the message inside it, never the JSON — the classifier
    /// is where that unwrapping happens.
    func testAServerErrorRendersTheEnvelopeMessageNotTheRawJSON() {
        let kind = GatewayErrorView.classify(
            GatewayClient.Error.serverError(
                status: 500,
                body: #"{"error":"writer busy — try again","code":"BUSY"}"#
            )
        )
        XCTAssertEqual(kind, .server(status: 500, body: "writer busy — try again"))
        XCTAssertEqual(kind.detail(for: "load watches"), "writer busy — try again")
    }

    /// A proxy's HTML is not the envelope; it reaches the user as it stands
    /// rather than being swallowed.
    func testANonEnvelopeServerBodyIsShownAsItStands() {
        let kind = GatewayErrorView.classify(
            GatewayClient.Error.serverError(status: 502, body: "<html>Bad Gateway</html>")
        )
        XCTAssertEqual(kind, .server(status: 502, body: "<html>Bad Gateway</html>"))
    }

    /// The 503 first-run agent state is recognised through the envelope too —
    /// the phrase it matches on sits inside `error`, not at the top level.
    func testAgentNotConfiguredIsRecognisedThroughTheEnvelope() {
        XCTAssertEqual(
            GatewayErrorView.classify(
                GatewayClient.Error.serverError(
                    status: 503,
                    body: #"{"error":"Agent disabled. Set inference.assignments.agent","code":"SERVICE_UNAVAILABLE"}"#
                )
            ),
            .agentNotConfigured
        )
    }

    func testAgentNotConfiguredUsesFriendlySparklesNotWarningTriangle() {
        // The first-run setup state must not wear the warning triangle
        // that server/unknown faults use — it's a normal onboarding step.
        XCTAssertEqual(GatewayErrorView.Kind.agentNotConfigured.symbol, "sparkles")
        XCTAssertNotEqual(
            GatewayErrorView.Kind.agentNotConfigured.symbol,
            GatewayErrorView.Kind.server(status: 503, body: "").symbol
        )
    }
}
