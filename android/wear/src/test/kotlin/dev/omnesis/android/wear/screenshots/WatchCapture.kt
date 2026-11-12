// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wear.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.wear.ui.OmnesisWearTheme
import org.robolectric.RuntimeEnvironment

/** The watch shapes every screen is captured on. */
enum class WatchShape(val label: String, val qualifiers: String, val round: Boolean) {
    /** The smallest round Wear OS display. */
    SMALL_ROUND("round192", "w192dp-h192dp-small-notlong-round-watch-xhdpi-keyshidden-nonav", true),

    /** A large round display. */
    LARGE_ROUND("round227", "w227dp-h227dp-small-notlong-round-watch-xhdpi-keyshidden-nonav", true),

    SQUARE("square180", "w180dp-h180dp-small-notlong-notround-watch-xhdpi-keyshidden-nonav", false),
}

/**
 * Capture [content] once per [WatchShape] as `<name>_<shape>.png`. A round
 * display is drawn as a black disc on grey, so anything a real round screen
 * would cut off is visibly outside the disc. Inspection mode holds every
 * endless animation still.
 */
fun captureOnEveryWatch(name: String, content: @Composable () -> Unit) {
    for (shape in WatchShape.entries) {
        RuntimeEnvironment.setQualifiers(shape.qualifiers)
        captureRoboImage(filePath = "src/test/roborazzi/${name}_${shape.label}.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisWearTheme { WatchFrame(shape, content) }
            }
        }
    }
}

@Composable
fun WatchFrame(shape: WatchShape, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(if (shape.round) OUTSIDE_THE_DISPLAY else Color.Black)) {
        Box(Modifier.fillMaxSize().then(if (shape.round) Modifier.clip(CircleShape) else Modifier).background(Color.Black)) {
            content()
        }
    }
}

private val OUTSIDE_THE_DISPLAY = Color(0xFF4A4A4A)
