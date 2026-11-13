// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.surfaces

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.Uri
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.data.ComplicationType
import androidx.wear.watchface.complications.data.MonochromaticImage
import androidx.wear.watchface.complications.data.MonochromaticImageComplicationData
import androidx.wear.watchface.complications.data.PlainComplicationText
import androidx.wear.watchface.complications.data.ShortTextComplicationData
import androidx.wear.watchface.complications.data.SmallImage
import androidx.wear.watchface.complications.data.SmallImageComplicationData
import androidx.wear.watchface.complications.data.SmallImageType
import androidx.wear.watchface.complications.datasource.ComplicationDataSourceService
import androidx.wear.watchface.complications.datasource.ComplicationRequest
import dev.omnesis.android.wear.MainActivity
import dev.omnesis.android.wear.R
import dev.omnesis.android.wearprotocol.WearLine
import dev.omnesis.android.wearprotocol.WearRoute

/**
 * The complication: the mark on the watch face, which opens the recorder
 * when pressed. It never changes, so it is never asked to update.
 */
class CaptureComplicationService : ComplicationDataSourceService() {
    override fun onComplicationRequest(request: ComplicationRequest, listener: ComplicationRequestListener) {
        listener.onComplicationData(CaptureComplication.data(this, request.complicationType, openRecorder()))
    }

    override fun getPreviewData(type: ComplicationType): ComplicationData? =
        CaptureComplication.data(this, type, tapAction = null)

    private fun openRecorder(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(Intent.ACTION_VIEW, Uri.parse(WearRoute.ASK.uri), this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
}

/** What the complication shows in each slot shape, apart from the service that serves it. */
object CaptureComplication {
    val SUPPORTED_TYPES = listOf(
        ComplicationType.SHORT_TEXT,
        ComplicationType.MONOCHROMATIC_IMAGE,
        ComplicationType.SMALL_IMAGE,
    )

    /** The complication for a slot of [type], or null for a shape it does not fill. */
    fun data(context: Context, type: ComplicationType, tapAction: PendingIntent?): ComplicationData? {
        val description = PlainComplicationText.Builder(context.getString(R.string.surface_description)).build()
        val mark = MonochromaticImage.Builder(Icon.createWithResource(context, R.drawable.omnesis_mark)).build()
        return when (type) {
            ComplicationType.SHORT_TEXT ->
                ShortTextComplicationData.Builder(PlainComplicationText.Builder(WearLine.ASK.text).build(), description)
                    .setMonochromaticImage(mark)
                    .setTapAction(tapAction)
                    .build()
            ComplicationType.MONOCHROMATIC_IMAGE ->
                MonochromaticImageComplicationData.Builder(mark, description).setTapAction(tapAction).build()
            ComplicationType.SMALL_IMAGE -> {
                val image = Icon.createWithResource(context, R.drawable.omnesis_mark_accent)
                SmallImageComplicationData.Builder(SmallImage.Builder(image, SmallImageType.ICON).build(), description)
                    .setTapAction(tapAction)
                    .build()
            }
            else -> null
        }
    }
}
