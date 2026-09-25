// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if canImport(SwiftUI) && canImport(UIKit)
import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

/// Renders a string payload as a scannable QR code. The pairing flow uses
/// this for the NEW direction — the apps elsewhere only *scan* QR codes
/// (`PairingView`); here we *generate* one so a freshly-minted pairing code
/// can be handed to another phone.
///
/// Generation is `CIFilter.qrCodeGenerator` (CoreImage) → a nearest-neighbour
/// upscale so the modules stay crisp at display size. Error-correction level
/// "L" matches the portal: pairing payloads are a few hundred bytes and higher
/// correction would force a denser code. Returns nil if encoding fails.
@available(iOS 17.0, *)
enum QRCodeImage {
    static func make(from payload: String, scale: CGFloat = 8) -> UIImage? {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        filter.correctionLevel = "L"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

/// A QR code view over a payload string, sized square. Falls back to a small
/// "couldn't render" note (rather than crashing) when encoding fails.
@available(iOS 17.0, *)
struct QRCodeView: View {
    let payload: String
    var side: CGFloat = 220

    var body: some View {
        if let image = QRCodeImage.make(from: payload) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .frame(width: side, height: side)
                .padding(Theme.Spacing.sm)
                .background(Color.white)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium))
                .accessibilityLabel("Pairing QR code")
        } else {
            Text("Couldn't render QR — use the pairing code above.")
                .font(.footnote)
                .foregroundStyle(Theme.textMuted)
                .frame(width: side, height: side)
                .multilineTextAlignment(.center)
        }
    }
}
#endif
