// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Foundation
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftDraw
import SwiftUI

/// Provider marks come from the paired gateway's cached Models.dev SVG route.
/// The phone never contacts Models.dev, and no provider brand art is bundled.
@available(iOS 17.0, *)
struct ProviderIcon: View {
    @Environment(AppStore.self) private var store: AppStore?
    @Environment(\.colorScheme) private var colorScheme
    let providerId: String
    var size: CGFloat = 14
    @State private var logo: UIImage?

    init(providerId: String, size: CGFloat = 14) {
        self.providerId = providerId
        self.size = size
    }

    #if DEBUG
    init(providerId: String, size: CGFloat = 14, previewSVG: Data, previewColorScheme: ColorScheme = .dark) {
        self.init(providerId: providerId, size: size)
        _logo = State(initialValue: ProviderSVGRenderer.render(previewSVG, colorScheme: previewColorScheme))
    }
    #endif

    private var remoteId: String? {
        switch providerId {
        case "local", "none", "http": nil
        default: providerId
        }
    }

    var body: some View {
        Group {
            if let logo {
                Image(uiImage: logo)
                    .resizable()
                    .scaledToFit()
            } else {
                Image(systemName: "server.rack")
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(Theme.textMuted)
            }
        }
        .frame(width: size, height: size)
        .task(id: "\(store?.admin?.baseURL.absoluteString ?? "preview")/\(remoteId ?? "none")/\(colorScheme)") {
            guard let admin = store?.admin else { return }
            logo = nil
            guard let remoteId else { return }
            let fetched = await ProviderLogoCache.shared.image(
                providerId: remoteId,
                admin: admin,
                colorScheme: colorScheme
            )
            guard !Task.isCancelled else { return }
            logo = fetched
        }
    }
}

/// Coalesces simultaneous icon requests on the phone. The gateway owns the
/// durable SVG cache; this memory cache only prevents repeated decoding while
/// the Models screen is visible.
@available(iOS 17.0, *)
@MainActor
private final class ProviderLogoCache {
    static let shared = ProviderLogoCache()
    private var images: [String: UIImage] = [:]
    private var tasks: [String: Task<UIImage?, Never>] = [:]

    func image(providerId: String, admin: AdminClient, colorScheme: ColorScheme) async -> UIImage? {
        let key = "\(admin.baseURL.absoluteString)/\(providerId)/\(colorScheme)"
        if let image = images[key] { return image }
        if let task = tasks[key] { return await task.value }
        let task = Task<UIImage?, Never> {
            guard let svg = try? await admin.modelProviderLogo(providerId: providerId) else { return nil }
            return ProviderSVGRenderer.render(svg, colorScheme: colorScheme)
        }
        tasks[key] = task
        let result = await task.value
        tasks[key] = nil
        if let result { images[key] = result }
        return result
    }
}

/// UIKit cannot decode SVG data. SwiftDraw parses the gateway-fetched mark
/// without creating a WebView or issuing any network request. Bound the raster
/// to icon scale so oversized upstream viewports do not allocate huge images.
@available(iOS 17.0, *)
@MainActor
enum ProviderSVGRenderer {
    static func render(_ data: Data, colorScheme: ColorScheme) -> UIImage? {
        guard let xml = String(data: data, encoding: .utf8) else { return nil }
        // Models.dev's monochrome marks use currentColor; a raster image
        // has no surrounding CSS color, so resolve it for this theme.
        let color = colorScheme == .dark ? "#F3F4F6" : "#171717"
        let colored = Data(xml.replacingOccurrences(of: "currentColor", with: color).utf8)
        return render(colored)
    }

    static func render(_ data: Data) -> UIImage? {
        guard let svg = SVG(data: data),
              svg.size.width > 0, svg.size.height > 0 else { return nil }
        let factor = min(64 / svg.size.width, 64 / svg.size.height)
        return svg.scaled(factor).rasterize(scale: 2)
    }
}

/// Backends whose names identify known providers use their provider mark;
/// custom names gracefully fall back to a generic server glyph.
@available(iOS 17.0, *)
struct BackendBrandIcon: View {
    let key: String
    var size: CGFloat = 18

    var body: some View {
        ProviderIcon(providerId: key, size: size)
    }
}

#if DEBUG
@available(iOS 17.0, *)
#Preview("ProviderIcon — known and unknown ids") {
    VStack(alignment: .leading, spacing: 12) {
        ForEach(["anthropic", "openai", "google", "cerebras", "nvidia", "local", "none"], id: \.self) { id in
            HStack(spacing: 8) {
                ProviderIcon(providerId: id, size: 18)
                Text(id)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.textPrimary)
            }
        }
    }
    .padding(40)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}

@available(iOS 17.0, *)
#Preview("ProviderIcon — SVG fetched from gateway") {
    HStack(spacing: 14) {
        ProviderIcon(providerId: "openai", size: 48, previewSVG: PreviewMocks.providerLogoSampleSVG)
        Text("Provider mark")
            .foregroundStyle(Theme.textPrimary)
    }
    .padding()
    .background(Theme.bgPrimary)
    .preferredColorScheme(.dark)
}
#endif
#endif
