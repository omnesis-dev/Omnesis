// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.ui.devannotate.DevAnnotationDialog
import dev.omnesis.android.ui.devannotate.DevAnnotationTarget
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class DevAnnotationScreenshotTest {
    private fun capture(
        name: String,
        dark: Boolean,
        target: DevAnnotationTarget,
    ) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    Box(Modifier.fillMaxSize().background(OmTheme.colors.bgPrimary)) {
                        DevAnnotationDialog(target, fileNote = {}, onClose = {})
                    }
                }
            }
        }
    }

    private fun document() = DevAnnotationTarget(
        targetType = "document",
        targetId = "doc-1",
        label = "Document doc-1",
        deepLink = "document/doc-1",
    )

    private fun longRoute() = DevAnnotationTarget(
        targetType = "route",
        targetId = null,
        label = "General note — privacy/conversations/conversation-example/exchanges/task-example",
        deepLink = "privacy/conversations/conversation-example/exchanges/task-example",
    )

    @Test fun dev_annotation_document_light() = capture("dev_annotation_document_light", false, document())
    @Test fun dev_annotation_document_dark() = capture("dev_annotation_document_dark", true, document())
    @Test fun dev_annotation_route_long_light() = capture("dev_annotation_route_long_light", false, longRoute())
    @Test fun dev_annotation_route_long_dark() = capture("dev_annotation_route_long_dark", true, longRoute())
}
