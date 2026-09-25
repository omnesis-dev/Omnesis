// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// A QR code drawn for the page's theme.
//
// The canvas cannot read CSS variables, so the colours are chosen from the
// active theme — conventional dark modules on white in light mode, an inverted
// light-on-dark code that sits on the dark page otherwise — and redrawn on a
// theme flip so a code left open stays scannable. The `qrcode` module comes
// from the portal's vendored bundle through the import map, the one copy every
// QR on the portal draws with.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import QRCode from "qrcode";

/**
 * @param {object} props
 * @param {string} props.payload  what the code encodes.
 * @param {number} [props.width]  rendered edge in CSS pixels.
 * @param {string} [props.class]  class for the canvas, and for the error line
 *                                that replaces it when drawing fails.
 */
export function QrCanvas({ payload, width = 200, class: className = "" }) {
  const canvasRef = useRef(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!payload || !canvasRef.current) return undefined;
    const draw = () => {
      if (!canvasRef.current) return;
      setError(null);
      const isLight = document.documentElement.dataset.theme === "light";
      QRCode.toCanvas(canvasRef.current, payload, {
        width,
        margin: 2,
        errorCorrectionLevel: "M",
        color: isLight
          ? { dark: "#1a1a1a", light: "#ffffff" }
          : { dark: "#f2f2f2", light: "#1a1a1a" },
      }).catch((cause) => setError(String(cause?.message || cause)));
    };
    draw();
    window.addEventListener("omnesis:themechange", draw);
    return () => window.removeEventListener("omnesis:themechange", draw);
  }, [payload, width]);

  if (error) {
    return html`<p class=${`qr-canvas-error ${className}`.trim()} role="status">Could not render QR: ${error}</p>`;
  }
  return html`<canvas ref=${canvasRef} class=${className} width=${width} height=${width}></canvas>`;
}
