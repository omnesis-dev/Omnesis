// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.models

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import coil.ImageLoader
import coil.decode.SvgDecoder
import coil.fetch.SourceResult
import coil.request.Options
import dev.omnesis.android.designsystem.image.DataUriFetcher
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.Base64

/** The provider-logo data URI uses the same fetcher/decoder pair as OmnesisApp. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class ProviderSvgDecodeTest {
    @Test fun gateway_svg_data_uri_decodes_to_the_expected_pixels() = runBlocking {
        val svg = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#FF8800"/></svg>"""
        val dataUri = "data:image/svg+xml;base64," + Base64.getEncoder().encodeToString(svg.toByteArray())
        val context = ApplicationProvider.getApplicationContext<Context>()
        val options = Options(context)
        val loader = ImageLoader.Builder(context).build()
        val fetched = DataUriFetcher(Uri.parse(dataUri), options).fetch() as SourceResult
        val decoder = SvgDecoder.Factory().create(fetched, options, loader)
        assertNotNull("SvgDecoder should accept the fetched SVG MIME", decoder)

        val decoded = decoder!!.decode()
        assertNotNull("SvgDecoder should produce a drawable", decoded)
        val drawable = decoded!!.drawable
        val bitmap = Bitmap.createBitmap(48, 48, Bitmap.Config.ARGB_8888)
        drawable.setBounds(0, 0, bitmap.width, bitmap.height)
        drawable.draw(Canvas(bitmap))
        val center = bitmap.getPixel(bitmap.width / 2, bitmap.height / 2)
        assertTrue(
            "SVG center should be orange: #${Integer.toHexString(center)}",
            Color.red(center) > 230 && Color.green(center) in 100..170 && Color.blue(center) < 30,
        )
    }
}
