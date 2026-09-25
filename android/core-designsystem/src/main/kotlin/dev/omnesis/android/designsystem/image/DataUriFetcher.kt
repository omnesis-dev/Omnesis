// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.designsystem.image

import android.net.Uri
import android.util.Base64
import coil.ImageLoader
import coil.decode.DataSource
import coil.decode.ImageSource
import coil.fetch.FetchResult
import coil.fetch.Fetcher
import coil.fetch.SourceResult
import coil.request.Options
import okio.Buffer

/**
 * Coil 2.x has no built-in `data:` URI fetcher (data-URI support arrived in Coil 3).
 * The gateway delivers every source/provider icon as an inline
 * `data:image/...;base64,…` URI — `/portal/source-meta.json` PNGs and descriptor
 * SVGs — so without this fetcher Coil fails silently at the FETCH stage (before any
 * decoder runs) and every [dev.omnesis.android.designsystem.components.SourceIcon]
 * renders blank. This base64-decodes the payload in memory (no network, no auth),
 * mirroring how iOS `SourceIconView` decodes a data URI into a `UIImage`. Coil's
 * built-in BitmapFactory decoder then handles `image/png` and the registered
 * `SvgDecoder` handles `image/svg+xml`.
 */
class DataUriFetcher(
    private val uri: Uri,
    private val options: Options,
) : Fetcher {
    override suspend fun fetch(): FetchResult {
        // An opaque URI keeps everything after "data:" in its scheme-specific part,
        // e.g. "image/png;base64,iVBORw0K…". Base64 chars (+ / =) and alphanumerics
        // pass through Uri decoding untouched (no %-escapes, + is not form-decoded).
        val ssp = uri.schemeSpecificPart
        val comma = ssp.indexOf(',')
        require(comma >= 0) { "malformed data URI (no comma)" }
        val meta = ssp.substring(0, comma)
        val payload = ssp.substring(comma + 1)
        val bytes = if (meta.endsWith(";base64", ignoreCase = true)) {
            Base64.decode(payload, Base64.DEFAULT)
        } else {
            Uri.decode(payload).toByteArray()
        }
        return SourceResult(
            source = ImageSource(Buffer().apply { write(bytes) }, options.context),
            mimeType = meta.substringBefore(';').ifBlank { null },
            dataSource = DataSource.MEMORY,
        )
    }

    class Factory : Fetcher.Factory<Uri> {
        override fun create(data: Uri, options: Options, imageLoader: ImageLoader): Fetcher? =
            if (data.scheme == "data") DataUriFetcher(data, options) else null
    }
}
