// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import androidx.compose.material3.Text
import androidx.compose.ui.text.style.TextAlign
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import android.graphics.Bitmap

/**
 * Encodes [payload] to a black-on-white QR [ImageBitmap], or null on failure.
 *
 * This is the NEW direction for the apps — elsewhere they only *scan* QR
 * (CameraX + ML Kit). Error-correction level "L" matches the portal: pairing
 * payloads are a few hundred bytes and higher correction would force a denser
 * code. zxing-core is pure JVM so this works under Roborazzi with no device.
 */
fun encodeQr(payload: String, sizePx: Int = 480): ImageBitmap? = runCatching {
    val hints = mapOf(
        EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.L,
        EncodeHintType.MARGIN to 1,
    )
    val matrix = QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, sizePx, sizePx, hints)
    val w = matrix.width
    val h = matrix.height
    val pixels = IntArray(w * h)
    for (y in 0 until h) {
        val row = y * w
        for (x in 0 until w) {
            pixels[row + x] = if (matrix.get(x, y)) 0xFF000000.toInt() else 0xFFFFFFFF.toInt()
        }
    }
    Bitmap.createBitmap(pixels, w, h, Bitmap.Config.ARGB_8888).asImageBitmap()
}.getOrNull()

/** A square QR view over [payload]; degrades to a note if encoding fails. */
@Composable
fun QrCodeView(payload: String, side: Int = 220) {
    val c = OmTheme.colors
    val bitmap = remember(payload) { encodeQr(payload) }
    if (bitmap != null) {
        Image(
            bitmap = bitmap,
            contentDescription = null,
            contentScale = ContentScale.Fit,
            modifier = Modifier
                .size(side.dp)
                .clip(RoundedCornerShape(OmRadius.medium))
                .background(Color.White)
                .padding(OmSpacing.sm)
                .semantics { contentDescription = "Pairing QR code" },
        )
    } else {
        Text(
            "Couldn't render QR — use the pairing code above.",
            color = c.textMuted,
            textAlign = TextAlign.Center,
            modifier = Modifier.size(side.dp).padding(OmSpacing.md),
        )
    }
}
