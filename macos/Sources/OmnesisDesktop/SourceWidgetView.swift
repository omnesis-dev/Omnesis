// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import CryptoKit
import Security
import SwiftUI
import WebKit

@MainActor
struct SourceWidgetConfiguration {
    let origin: URL
    let fingerprint: String
    let nonce: String
    let json: String

    static func load(flow: DesktopSourceFlow, widget: AuthSnapshot.Widget) async throws -> Self {
        struct Account: Decodable { let publicOrigin: String?
            let account: Linked?
            struct Linked: Decodable { let linked: Bool }
        }
        struct Identity: Decodable { let gatewayFingerprint: String }
        let account: Account = try await flow.api.request("GET", "admin/cloud-relay")
        let identity: Identity = try await flow.api.request("GET", "devices/account/config")
        guard account.account?.linked == true, let text = SourceValidation.publicOrigin(account.publicOrigin),
              let origin = URL(string: text),
              identity.gatewayFingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw DesktopAPIError
                .message("Connect your Omnesis account in Settings before opening this provider’s secure connection window.")
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw URLError(.unknown) }
        let nonce = bytes.map { String(format: "%02x", $0) }.joined()
        let origins = flow.descriptor.widgetOrigins
        let object: [String: Any] = [
            "nonce": nonce,
            "kind": widget.kind,
            "payload": widget.payload,
            "origins": [
                "script": origins?.script ?? [],
                "frame": origins?.frame ?? [],
                "connect": origins?.connect ?? [],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: object)
        guard data.count <= 262_144, let json = String(data: data, encoding: .utf8) else {
            throw DesktopAPIError.message("This provider sent a connection request that is too large.")
        }
        return Self(origin: origin, fingerprint: identity.gatewayFingerprint, nonce: nonce, json: json)
    }
}

struct SourceWidgetView: View {
    let flow: DesktopSourceFlow
    let widget: AuthSnapshot.Widget
    @State private var configuration: SourceWidgetConfiguration?
    @State private var failure: String?
    var body: some View {
        VStack(alignment: .leading, spacing: DesktopDesignTokens.Space.medium) {
            if let configuration {
                SourceWidgetBrowser(configuration: configuration, origins: flow.descriptor.widgetOrigins) { type, token, metadata in
                    Task {
                        switch type {
                        case "result": await flow.submitWidgetResult(token: token, metadata: metadata)
                        case "exit": await flow.cancel(clearCredentials: false)
                        default: failure = "The provider’s connection window could not finish. You can cancel and try again."
                        }
                    }
                }.frame(minHeight: 420)
            }
            if let failure { Text(failure).foregroundStyle(DesktopTheme.danger) }
            else if configuration == nil { ProgressView("Opening secure account connection…") }
        }.task(id: widget.kind) {
            do { configuration = try await SourceWidgetConfiguration.load(flow: flow, widget: widget) }
            catch { failure = error.localizedDescription }
        }
    }
}

struct SourceWidgetBrowser: NSViewRepresentable {
    let configuration: SourceWidgetConfiguration
    let origins: DesktopDescriptor.WidgetOrigins?
    let receive: (String, String?, [String: Any]?) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(configuration: configuration, origins: origins, receive: receive)
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(context.coordinator, name: "omnesisWidget")
        let view = WKWebView(frame: .zero, configuration: config)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        context.coordinator.webView = view
        // Strip outgoing cookies, including vendor frames. The isolated ephemeral
        // store is discarded with this window and never shares an admin session.
        let rules = #"[{"trigger":{"url-filter":".*"},"action":{"type":"block-cookies"}}]"#
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "omnesis-widget-no-cookies-v1",
            encodedContentRuleList: rules
        ) { list, _ in
            DispatchQueue.main.async {
                guard !context.coordinator.closed else { return }
                guard let list else { self.receive("error", nil, nil)
                    return
                }
                view.configuration.userContentController.add(list)
                var request = URLRequest(url: configuration.origin.appendingPathComponent("portal/native-widget.html"))
                request.httpShouldHandleCookies = false
                view.load(request)
            }
        }
        return view
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {}
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        coordinator.closed = true
        view.stopLoading()
        view.configuration.userContentController.removeScriptMessageHandler(forName: "omnesisWidget")
        view.navigationDelegate = nil
        view.uiDelegate = nil
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        let configuration: SourceWidgetConfiguration
        let origins: DesktopDescriptor.WidgetOrigins?
        let receive: (String, String?, [String: Any]?) -> Void
        weak var webView: WKWebView?
        var closed = false
        private var started = false
        init(
            configuration: SourceWidgetConfiguration,
            origins: DesktopDescriptor.WidgetOrigins?,
            receive: @escaping (String, String?, [String: Any]?) -> Void
        ) {
            self.configuration = configuration
            self.origins = origins
            self.receive = receive
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            guard !closed, !started, webView.url == configuration.origin.appendingPathComponent("portal/native-widget.html") else { return }
            started = true
            webView.evaluateJavaScript("void window.omnesisWidgetHost.start(\(configuration.json))") { _, error in
                if error != nil { self.receive("error", nil, nil) }
            }
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard !closed, message.frameInfo.isMainFrame,
                  message.frameInfo.securityOrigin.protocol == configuration.origin.scheme,
                  message.frameInfo.securityOrigin.host == configuration.origin.host,
                  (message.frameInfo.securityOrigin.port == 0 ? 443 : message.frameInfo.securityOrigin.port) ==
                  (configuration.origin.port ?? 443),
                  let event = SourceWidgetMessage.parse(message.body, nonce: configuration.nonce) else { return }
            receive(event.type, event.token, event.metadata)
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard !closed, let url = navigationAction.request.url else { decisionHandler(.cancel)
                return
            }
            let hostPage = configuration.origin.appendingPathComponent("portal/native-widget.html")
            if navigationAction.targetFrame?.isMainFrame != false {
                decisionHandler(url == hostPage ? .allow : .cancel)
            } else {
                decisionHandler((url.absoluteString == "about:blank" || Self.allowedFrame(url, origins: origins?.frame ?? [])) ? .allow :
                    .cancel)
            }
        }

        static func allowedFrame(_ url: URL, origins: [String]) -> Bool {
            guard url.scheme == "https", url.user == nil, url.password == nil, let host = url.host?.lowercased() else { return false }
            return origins.contains { origin in
                let wildcard = origin.hasPrefix("https://*.")
                let exact = wildcard ? origin.replacingOccurrences(of: "https://*.", with: "https://") : origin
                guard let allowed = URL(string: exact), allowed.scheme == "https", allowed.path.isEmpty,
                      allowed.query == nil, allowed.fragment == nil, allowed.user == nil, allowed.password == nil,
                      let expected = allowed.host?.lowercased(), (url.port ?? 443) == (allowed.port ?? 443) else { return false }
                return wildcard ? host.hasSuffix("." + expected) : host == expected
            }
        }

        func webView(
            _ webView: WKWebView,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
                  challenge.protectionSpace.host == configuration.origin.host else {
                completionHandler(.performDefaultHandling, nil)
                return
            }
            guard let trust = challenge.protectionSpace.serverTrust, SecTrustEvaluateWithError(trust, nil),
                  let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let certificate = chain.first else {
                completionHandler(.cancelAuthenticationChallenge, nil)
                return
            }
            let fingerprint = SHA256.hash(data: SecCertificateCopyData(certificate) as Data).map { String(format: "%02x", $0) }.joined()
            guard fingerprint == configuration.fingerprint else { completionHandler(.cancelAuthenticationChallenge, nil)
                return
            }
            completionHandler(.useCredential, URLCredential(trust: trust))
        }

        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        )
            -> WKWebView? {
            receive("error", nil, nil)
            return nil
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if !closed { receive("error", nil, nil) }
        }
    }
}

struct SourceWidgetMessage {
    let type: String
    let token: String?
    let metadata: [String: Any]?
    static func parse(_ value: Any, nonce: String) -> Self? {
        guard let body = value as? [String: Any], body["nonce"] as? String == nonce,
              let type = body["type"] as? String, ["result", "exit", "error"].contains(type),
              JSONSerialization.isValidJSONObject(body),
              let bytes = try? JSONSerialization.data(withJSONObject: body), bytes.count <= 98304 else { return nil }
        if type == "result" {
            guard let token = body["token"] as? String, !token.isEmpty, token.utf8.count <= 16384,
                  let metadata = body["metadata"] as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: metadata), data.count <= 65536 else { return nil }
            return Self(type: type, token: token, metadata: metadata)
        }
        return Self(type: type, token: nil, metadata: nil)
    }
}
