// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI

/// Environment handler that opens Settings at Configure Models, where a
/// model can be assigned to the Agent capability. Injected by the app shell
/// (`HomeView`), which owns Settings presentation; the default no-op is only
/// hit by previews/snapshots and by call sites that render outside the shell
/// (they simply don't show the shortcut). Mirrors `openTrailDocument` in
/// `TrailTimelineView`.
private struct OpenModelSettingsKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var openModelSettings: (() -> Void)? {
        get { self[OpenModelSettingsKey.self] }
        set { self[OpenModelSettingsKey.self] = newValue }
    }
}

/// When a gateway-backed page is already inside Settings, its generic "Open
/// settings" recovery action should pop to the existing Settings root instead
/// of presenting a second Settings sheet. Outside that stack the value stays
/// nil and `GatewayErrorView` retains its standalone-sheet fallback.
private struct ReturnToSettingsRootKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var returnToSettingsRoot: (() -> Void)? {
        get { self[ReturnToSettingsRootKey.self] }
        set { self[ReturnToSettingsRootKey.self] = newValue }
    }
}

/// Full-screen error placeholder used wherever a top-level data fetch
/// fails before the page can show any content. Renders:
///
///   - One illustrative SF symbol (kind-dependent).
///   - A short, plain-English title ("Couldn't connect to gateway", …).
///   - A friendly explanation that does **not** dump raw `NSURLError`
///     internals at the user.
///   - A primary "Retry" button (re-runs the page's fetch).
///   - A secondary "Open settings" link that returns to an existing Settings
///     root, or presents `SettingsView` as a sheet from other app surfaces.
///
/// The one exception is the first-run `.agentNotConfigured` state (no
/// model assigned to the Agent capability yet): it drops the warning
/// framing entirely and shows a "Set up agent model" shortcut into the
/// model configuration page instead of the generic settings link, since
/// that's a normal setup step, not a fault.
///
/// Pass the underlying `Error?` (not a pre-stringified message): the
/// view's classifier maps it to a human-readable kind. `context` is a
/// short verb-phrase describing what failed ("load triggers", "start a
/// new conversation"); it's used to fill in the detail copy when the
/// error doesn't carry its own message.
@available(iOS 17.0, *)
struct GatewayErrorView: View {
    let context: String
    let error: Error?
    let onRetry: () -> Void

    @Environment(\.openModelSettings) private var openModelSettings
    @Environment(\.returnToSettingsRoot) private var returnToSettingsRoot
    @State private var showSettings: Bool = false

    /// Minimum vertical room the view needs to render its full
    /// stack (icon + title + detail + buttons) without crowding.
    /// Call sites that embed the view inside a `ScrollView` (e.g.
    /// `DocumentDetailView`, `PersonDetailView`, `FiringDetailView`,
    /// `TriggerDetailView`) apply this as `.frame(minHeight:)` so the
    /// inner content doesn't collapse to a 0-height strip.
    static let minScrollHeight: CGFloat = 360

    var body: some View {
        let kind = Self.classify(error)
        VStack(spacing: Theme.Spacing.md) {
            Image(systemName: kind.symbol)
                .font(.system(size: 42, weight: .regular))
                .foregroundStyle(kind.tint)
                .padding(.bottom, 4)
            Text(kind.title)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.center)
            Text(kind.detail(for: context))
                .font(.system(size: 13))
                .foregroundStyle(Theme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Spacing.lg)
            actions(for: kind)
                .padding(.top, Theme.Spacing.sm)
        }
        .padding(Theme.Spacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bgPrimary)
        .sheet(isPresented: $showSettings) {
            SettingsView()
                .omnesisColorScheme()
        }
    }

    /// Action buttons under the message. The first-run "no agent model
    /// yet" state gets a primary jump to Settings → Configure Models (where
    /// the assignment is made) and drops the generic settings link. Every
    /// other kind keeps the Retry + "Open settings" pair.
    @ViewBuilder
    private func actions(for kind: Kind) -> some View {
        if kind == .agentNotConfigured, let openModelSettings {
            VStack(spacing: 6) {
                Button("Set up agent model", action: openModelSettings)
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    .controlSize(.regular)
                Button("Retry", action: onRetry)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.accent)
                    .padding(.top, 2)
            }
        } else {
            VStack(spacing: 6) {
                Button("Retry", action: onRetry)
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    .controlSize(.regular)
                Button("Open settings", action: openSettings)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(Theme.accent)
                    .padding(.top, 2)
            }
        }
    }

    enum SettingsRecoveryRoute: Equatable {
        case existingRoot
        case newSheet
    }

    static func settingsRecoveryRoute(hasExistingSettingsStack: Bool) -> SettingsRecoveryRoute {
        hasExistingSettingsStack ? .existingRoot : .newSheet
    }

    static func performSettingsRecovery(
        hasExistingSettingsStack: Bool,
        returnToExistingRoot: () -> Void,
        presentNewSheet: () -> Void
    ) {
        switch settingsRecoveryRoute(hasExistingSettingsStack: hasExistingSettingsStack) {
        case .existingRoot:
            returnToExistingRoot()
        case .newSheet:
            presentNewSheet()
        }
    }

    private func openSettings() {
        Self.performSettingsRecovery(
            hasExistingSettingsStack: returnToSettingsRoot != nil,
            returnToExistingRoot: { returnToSettingsRoot?() },
            presentNewSheet: { showSettings = true }
        )
    }

    // MARK: - Classification

    /// Friendly buckets every thrown `Error` maps into. Keeps the view
    /// free of raw `NSURLError` / GatewayClient internals.
    enum Kind: Equatable {
        case gatewayUnreachable
        case certificate
        case unauthorized
        case forbidden
        case agentNotConfigured
        case server(status: Int, body: String)
        case unknown(String)

        var symbol: String {
            switch self {
            case .gatewayUnreachable: "wifi.exclamationmark"
            case .certificate: "lock.trianglebadge.exclamationmark"
            case .unauthorized, .forbidden: "lock.shield"
            case .agentNotConfigured: "sparkles"
            case .server, .unknown: "exclamationmark.triangle"
            }
        }

        var tint: Color {
            switch self {
            case .gatewayUnreachable: Theme.textMuted
            case .certificate: Theme.warning
            case .agentNotConfigured: Theme.accent
            case .unauthorized, .forbidden, .server, .unknown: Theme.warning
            }
        }

        var title: String {
            switch self {
            case .gatewayUnreachable: "Couldn't connect to gateway"
            case .certificate: "Couldn't verify gateway certificate"
            case .unauthorized: "Authentication failed"
            case .forbidden: "Permission denied"
            case .agentNotConfigured: "Set up your agent"
            case .server: "Gateway error"
            case .unknown: "Something went wrong"
            }
        }

        func detail(for context: String) -> String {
            switch self {
            case .gatewayUnreachable:
                "Check that the gateway is running and this phone has internet. If you use Tailscale away from home, connect it on both devices and pair using the gateway's Tailscale hostname. A home-network address works only at home."
            case .certificate:
                "The saved gateway address does not pass HTTPS verification. Check that the gateway's certificate covers that hostname. If you need a different address, re-pair from Settings using a new QR code."
            case .unauthorized:
                "The gateway rejected this device's pairing. Re-pair from Settings to continue."
            case .forbidden:
                "This device's token lacks the scope needed to \(context). Re-pair from Settings."
            case .agentNotConfigured:
                "No model is assigned to the agent yet. Open Settings, then Configure Models, "
                    + "and pick a model for the Agent capability to start chatting."
            case .server(let status, let body):
                Self.serverDetail(status: status, body: body, context: context)
            case .unknown(let message):
                message.isEmpty
                    ? "Something went wrong trying to \(context). Retry, or open Settings to repair the connection."
                    : message
            }
        }

        /// `body` is the `error` message `classify(_:)` unwrapped from the
        /// gateway's error envelope — an operator-curated string
        /// ("Anthropic API key not configured.", …), never the raw JSON. It is
        /// surfaced verbatim, dropping the status-code preamble, because it
        /// says more than the status does. Empty bodies fall back to the
        /// status so the user still has something to act on.
        private static func serverDetail(status: Int, body: String, context: String) -> String {
            let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                return "The gateway returned status \(status) while trying to \(context)."
            }
            return trimmed
        }

        /// Whether a 503 body text indicates the agent harness is not
        /// configured (no model assigned, disabled, missing API key, or
        /// missing fixture). The gateway phrases the "no model assigned
        /// to the agent capability" case as
        /// `Agent disabled. Set inference.assignments.agent …` — the
        /// common first-run state before any agent model is picked.
        static func isAgentNotConfigured(body: String) -> Bool {
            let lower = body.lowercased()
            return lower.contains("agent harness disabled")
                || lower.contains("agent disabled")
                || lower.contains("anthropic api key not configured")
                || lower.contains("replay backend selected but no fixture")
        }
    }

    /// Map any `Error` into one of the friendly `Kind`s above. `nil`
    /// collapses to `gatewayUnreachable` so callers that just want to
    /// signal "we couldn't reach the gateway" without an exception can
    /// pass `nil`.
    static func classify(_ error: Error?) -> Kind {
        guard let error else { return .gatewayUnreachable }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .serverCertificateUntrusted, .serverCertificateHasBadDate,
                 .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot,
                 .secureConnectionFailed:
                return .certificate
            default:
                break
            }
            return .gatewayUnreachable
        }
        if let gw = error as? GatewayClient.Error {
            switch gw {
            case .unauthorized: return .unauthorized
            case .forbidden: return .forbidden
            case .internalSource:
                return .unknown("That action isn't available for gateway-hosted sources.")
            case .notFound: return .unknown("Not found.")
            case .serverError(let status, let body):
                // The thrown body is the gateway's raw envelope; the message
                // inside it is what a person can act on, so it is unwrapped
                // once here and every `Kind.server` downstream carries prose.
                let message = GatewayClient.errorMessage(from: body)
                // Agent config errors are always 503 (ServiceUnavailable).
                // Restrict matching to 503 so a 500 that happens to contain
                // "agent harness disabled" doesn't get misclassified.
                if status == 503, Kind.isAgentNotConfigured(body: message) {
                    return .agentNotConfigured
                }
                return .server(status: status, body: message)
            case .invalidResponse: return .unknown("The gateway returned an invalid response.")
            case .invalidURL: return .unknown("The gateway URL is malformed. Open Settings to fix it.")
            case .decoding(let message): return .unknown("Couldn't parse the gateway's response: \(message)")
            }
        }
        // Any remaining error that isn't a GatewayClient case is
        // genuinely unexpected — fall back to localizedDescription.
        return .unknown(error.localizedDescription)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("GatewayErrorView — unreachable") {
    GatewayErrorView(
        context: "load triggers",
        error: URLError(.cannotConnectToHost),
        onRetry: {}
    )
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("GatewayErrorView — offline") {
    GatewayErrorView(
        context: "load people",
        error: URLError(.notConnectedToInternet),
        onRetry: {}
    )
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("GatewayErrorView — certificate") {
    GatewayErrorView(
        context: "load people",
        error: URLError(.serverCertificateUntrusted),
        onRetry: {}
    )
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("GatewayErrorView — unauthorized") {
    GatewayErrorView(
        context: "load triggers",
        error: GatewayClient.Error.unauthorized,
        onRetry: {}
    )
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("GatewayErrorView — forbidden") {
    GatewayErrorView(
        context: "load triggers",
        error: GatewayClient.Error.forbidden,
        onRetry: {}
    )
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("GatewayErrorView — no model assigned (first run)") {
    GatewayErrorView(
        context: "start the agent",
        error: GatewayClient.Error.serverError(
            status: 503,
            body: "Agent disabled. Set inference.assignments.agent in omnesis.json to enable it."
        ),
        onRetry: {}
    )
    .environment(AppStore.preview())
    .environment(\.openModelSettings) {}
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("GatewayErrorView — agent not configured (disabled)") {
    GatewayErrorView(
        context: "start the agent",
        error: GatewayClient.Error.serverError(
            status: 503,
            body: "Agent harness disabled. Set agent.backend to \"anthropic\" in omnesis.json."
        ),
        onRetry: {}
    )
    .environment(AppStore.preview())
    .environment(\.openModelSettings) {}
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("GatewayErrorView — agent not configured (no key)") {
    GatewayErrorView(
        context: "start the agent",
        error: GatewayClient.Error.serverError(
            status: 503,
            body: "Anthropic API key not configured. Set it from the portal's Settings → Models tab."
        ),
        onRetry: {}
    )
    .environment(AppStore.preview())
    .environment(\.openModelSettings) {}
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("GatewayErrorView — server body") {
    GatewayErrorView(
        context: "load triggers",
        error: GatewayClient.Error.serverError(
            status: 503,
            body: "Service temporarily unavailable. Try again in a few seconds."
        ),
        onRetry: {}
    )
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("GatewayErrorView — server body long") {
    GatewayErrorView(
        context: "load people",
        error: GatewayClient.Error.serverError(
            status: 500,
            body: "Indexer is rebuilding the embeddings table for the model swap; people resolution is "
                + "temporarily disabled while the writer worker drains the backlog. Retry in a couple of "
                + "minutes — or follow progress in the portal under Settings → Models."
        ),
        onRetry: {}
    )
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("GatewayErrorView — empty server body") {
    GatewayErrorView(
        context: "load triggers",
        error: GatewayClient.Error.serverError(status: 502, body: ""),
        onRetry: {}
    )
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("GatewayErrorView — nil error") {
    GatewayErrorView(
        context: "load documents",
        error: nil,
        onRetry: {}
    )
    .environment(AppStore.preview())
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("GatewayErrorView — Dynamic Type AX5") {
    GatewayErrorView(
        context: "load triggers",
        error: URLError(.cannotConnectToHost),
        onRetry: {}
    )
    .environment(AppStore.preview())
    .environment(\.dynamicTypeSize, .accessibility5)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("GatewayErrorView — light mode") {
    GatewayErrorView(
        context: "load triggers",
        error: URLError(.cannotConnectToHost),
        onRetry: {}
    )
    .environment(AppStore.preview())
    .preferredColorScheme(.light)
}
#endif
#endif
