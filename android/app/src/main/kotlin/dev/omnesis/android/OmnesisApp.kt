// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.decode.SvgDecoder
import dev.omnesis.android.designsystem.image.DataUriFetcher
import dev.omnesis.android.transport.MembershipRefusalCoordinator
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

/**
 * Application entry point and Hilt root. Starts the
 * [MembershipRefusalCoordinator] — the app-scoped consumer of the gateway's
 * refusals to have this phone host a source, which has to act on one whether
 * or not a screen is open. Supplies a Coil [ImageLoader] for source /
 * provider icons. The gateway delivers icons as inline `data:image/...;base64,…`
 * URIs (PNG from source-meta, SVG from descriptors). Coil 2.x can't fetch `data:`
 * URIs out of the box, so a [DataUriFetcher] base64-decodes them in memory; the
 * built-in BitmapFactory decoder then handles PNG and [SvgDecoder] handles SVG.
 */
@HiltAndroidApp
class OmnesisApp : Application(), ImageLoaderFactory {

    @Inject
    lateinit var membershipRefusals: MembershipRefusalCoordinator

    override fun onCreate() {
        super.onCreate()
        // Nothing else resolves this holder, and a refusal that arrives with
        // no settings screen open still has to put the phone's switch back.
        membershipRefusals.start()
    }

    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this)
            .components {
                add(DataUriFetcher.Factory())
                add(SvgDecoder.Factory())
            }
            .build()
}
