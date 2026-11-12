// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.surfaces

import android.content.Context
import android.graphics.Color
import androidx.wear.protolayout.ActionBuilders
import androidx.wear.protolayout.ColorBuilders.argb
import androidx.wear.protolayout.DeviceParametersBuilders.DeviceParameters
import androidx.wear.protolayout.DimensionBuilders.dp
import androidx.wear.protolayout.DimensionBuilders.expand
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.LayoutElementBuilders.LayoutElement
import androidx.wear.protolayout.ModifiersBuilders
import androidx.wear.protolayout.ResourceBuilders
import androidx.wear.protolayout.TimelineBuilders
import androidx.wear.protolayout.material.ChipColors
import androidx.wear.protolayout.material.CompactChip
import androidx.wear.protolayout.material.Text
import androidx.wear.protolayout.material.Typography
import androidx.wear.protolayout.material.layouts.PrimaryLayout
import androidx.wear.tiles.RequestBuilders
import androidx.wear.tiles.TileBuilders
import androidx.wear.tiles.TileService
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import dev.omnesis.android.wear.MainActivity
import dev.omnesis.android.wear.R
import dev.omnesis.android.wearprotocol.WearLine
import dev.omnesis.android.wearprotocol.WearRoute

/**
 * The tile: the mark over one button, and pressing anywhere on it opens the recorder. It
 * never changes, so one layout serves every request.
 */
class CaptureTileService : TileService() {
    override fun onTileRequest(requestParams: RequestBuilders.TileRequest): ListenableFuture<TileBuilders.Tile> =
        Futures.immediateFuture(
            TileBuilders.Tile.Builder()
                .setResourcesVersion(CaptureTile.RESOURCES_VERSION)
                .setTileTimeline(
                    TimelineBuilders.Timeline.fromLayoutElement(
                        CaptureTile.layout(this, requestParams.deviceConfiguration),
                    ),
                )
                .build(),
        )

    override fun onTileResourcesRequest(
        requestParams: RequestBuilders.ResourcesRequest,
    ): ListenableFuture<ResourceBuilders.Resources> = Futures.immediateFuture(CaptureTile.resources())
}

/** What the tile shows, apart from the service that serves it, so it can be rendered on its own. */
object CaptureTile {
    const val RESOURCES_VERSION = "1"
    private const val MARK = "mark"
    private const val MICROPHONE = "microphone"
    private const val ACCENT = 0xFF58A6FF.toInt()

    fun layout(context: Context, device: DeviceParameters): LayoutElement {
        val open = openRecorder(context)
        val content = PrimaryLayout.Builder(device)
            .setResponsiveContentInsetEnabled(true)
            .setPrimaryLabelTextContent(
                Text.Builder(context, context.getString(R.string.app_name))
                    .setTypography(Typography.TYPOGRAPHY_CAPTION1)
                    .setColor(argb(Color.WHITE))
                    .build(),
            )
            .setContent(
                LayoutElementBuilders.Image.Builder()
                    .setResourceId(MARK)
                    .setWidth(dp(52f))
                    .setHeight(dp(52f))
                    .setColorFilter(LayoutElementBuilders.ColorFilter.Builder().setTint(argb(ACCENT)).build())
                    .build(),
            )
            .setPrimaryChipContent(
                // The full "Tap to speak" does not fit a compact chip on the smallest display.
                CompactChip.Builder(context, WearLine.SPEAK.text, open, device)
                    .setIconContent(MICROPHONE)
                    .setChipColors(ChipColors(ACCENT, Color.BLACK))
                    .build(),
            )
            .build()
        // The whole tile opens the recorder, not the button alone.
        return LayoutElementBuilders.Box.Builder()
            .setWidth(expand())
            .setHeight(expand())
            .setModifiers(ModifiersBuilders.Modifiers.Builder().setClickable(open).build())
            .addContent(content)
            .build()
    }

    fun resources(): ResourceBuilders.Resources = ResourceBuilders.Resources.Builder()
        .setVersion(RESOURCES_VERSION)
        .addIdToImageMapping(
            MARK,
            ResourceBuilders.ImageResource.Builder()
                .setAndroidResourceByResId(
                    ResourceBuilders.AndroidImageResourceByResId.Builder().setResourceId(R.drawable.omnesis_mark).build(),
                )
                .build(),
        )
        .addIdToImageMapping(
            MICROPHONE,
            ResourceBuilders.ImageResource.Builder()
                .setAndroidResourceByResId(
                    ResourceBuilders.AndroidImageResourceByResId.Builder().setResourceId(R.drawable.ic_mic).build(),
                )
                .build(),
        )
        .build()

    /** A tile cannot set an intent's data, so the route travels as an extra. */
    private fun openRecorder(context: Context): ModifiersBuilders.Clickable = ModifiersBuilders.Clickable.Builder()
        .setId("open-recorder")
        .setOnClick(
            ActionBuilders.LaunchAction.Builder()
                .setAndroidActivity(
                    ActionBuilders.AndroidActivity.Builder()
                        .setPackageName(context.packageName)
                        .setClassName(MainActivity::class.java.name)
                        .addKeyToExtraMapping(MainActivity.EXTRA_ROUTE, ActionBuilders.stringExtra(WearRoute.ASK.uri))
                        .build(),
                )
                .build(),
        )
        .build()
}
