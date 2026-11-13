// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.screenshots

import android.app.Application
import android.content.Context
import android.graphics.Rect
import android.os.Looper
import android.view.View
import android.widget.FrameLayout
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.test.core.app.ApplicationProvider
import androidx.wear.protolayout.DeviceParametersBuilders
import androidx.wear.protolayout.LayoutElementBuilders
import androidx.wear.protolayout.StateBuilders
import androidx.wear.tiles.renderer.TileRenderer
import androidx.wear.watchface.complications.data.ComplicationData
import androidx.wear.watchface.complications.rendering.ComplicationDrawable
import com.github.takahirom.roborazzi.captureRoboImage
import com.google.common.util.concurrent.MoreExecutors
import dev.omnesis.android.wear.surfaces.CaptureComplication
import dev.omnesis.android.wear.surfaces.CaptureTile
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.util.function.Consumer

/**
 * Render-review screenshots of what the app puts on the watch face and in the
 * tile carousel: the tile, drawn by the tiles renderer on each display, and
 * the complication in each shape it fills.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class SurfacesScreenshotTest {
    @Test
    fun tile() {
        for (shape in WatchShape.entries) {
            RuntimeEnvironment.setQualifiers(shape.qualifiers)
            val context = ApplicationProvider.getApplicationContext<Application>()
            val tile = inflateTile(context, shape)
            captureRoboImage(filePath = "src/test/roborazzi/tile_${shape.label}.png") {
                CompositionLocalProvider(LocalInspectionMode provides true) {
                    WatchFrame(shape) { AndroidView(factory = { tile }, modifier = Modifier.fillMaxSize()) }
                }
            }
        }
    }

    /** Lay the tile out with the renderer the system uses, waiting for its asynchronous inflation. */
    private fun inflateTile(context: Context, shape: WatchShape): View {
        val configuration = context.resources.configuration
        val device = DeviceParametersBuilders.DeviceParameters.Builder()
            .setScreenWidthDp(configuration.screenWidthDp)
            .setScreenHeightDp(configuration.screenHeightDp)
            .setScreenDensity(context.resources.displayMetrics.density)
            .setScreenShape(
                if (shape.round) DeviceParametersBuilders.SCREEN_SHAPE_ROUND else DeviceParametersBuilders.SCREEN_SHAPE_RECT,
            )
            .setDevicePlatform(DeviceParametersBuilders.DEVICE_PLATFORM_WEAR_OS)
            .build()
        val layout = LayoutElementBuilders.Layout.Builder().setRoot(CaptureTile.layout(context, device)).build()
        val parent = FrameLayout(context)
        val renderer = TileRenderer(context, MoreExecutors.directExecutor(), Consumer<StateBuilders.State> { })
        val inflated = renderer.inflateAsync(layout, CaptureTile.resources(), parent)
        val deadline = System.currentTimeMillis() + INFLATION_TIMEOUT_MS
        while (!inflated.isDone && System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        assertTrue("the tile was inflated", inflated.isDone && inflated.get() != null)
        shadowOf(Looper.getMainLooper()).idle()
        return parent
    }

    @Test
    fun complication() {
        RuntimeEnvironment.setQualifiers(WatchShape.LARGE_ROUND.qualifiers)
        val context = ApplicationProvider.getApplicationContext<Application>()
        val slots = CaptureComplication.SUPPORTED_TYPES.map { type ->
            checkNotNull(CaptureComplication.data(context, type, tapAction = null)) { "$type is not filled" }
        }
        captureRoboImage(filePath = "src/test/roborazzi/complication_shapes.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                Row(
                    modifier = Modifier.fillMaxSize().background(Color.Black),
                    horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    slots.forEach { ComplicationSlot(context, it) }
                }
            }
        }
    }

    /** One complication as a watch face draws it, in a slot the size watch faces give it. */
    @androidx.compose.runtime.Composable
    private fun ComplicationSlot(context: Context, data: ComplicationData) {
        val drawable = ComplicationDrawable(context).apply { setComplicationData(data, false) }
        Box(Modifier.size(64.dp)) {
            Canvas(Modifier.fillMaxSize()) {
                drawIntoCanvas { canvas ->
                    drawable.bounds = Rect(0, 0, size.width.toInt(), size.height.toInt())
                    drawable.draw(canvas.nativeCanvas)
                }
            }
        }
    }

    private companion object {
        const val INFLATION_TIMEOUT_MS = 10_000L
    }
}
