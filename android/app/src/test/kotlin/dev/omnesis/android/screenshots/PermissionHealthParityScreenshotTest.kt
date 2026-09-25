// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.PermissionCapability
import dev.omnesis.android.transport.PermissionCapabilityState
import dev.omnesis.android.transport.PermissionHealthEntry
import dev.omnesis.android.transport.PermissionHealthSnapshot
import dev.omnesis.android.transport.PermissionRepairAction
import dev.omnesis.android.transport.PermissionRequirement
import dev.omnesis.android.ui.common.PermissionHealthBanner
import dev.omnesis.android.ui.common.NotificationHealthBanner
import dev.omnesis.android.ui.common.NotificationSetupBanner
import dev.omnesis.android.ui.common.NotificationSetupIssue
import dev.omnesis.android.ui.common.GlobalHealthWarningBanner
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PermissionHealthParityScreenshotTest {
    private val entries = listOf(
        PermissionHealthEntry(
            "fictional-source:local",
            PermissionHealthSnapshot(
                checkedAt = 1,
                capabilities = listOf(
                    PermissionCapability(
                        id = "background",
                        label = "Background updates",
                        state = PermissionCapabilityState.BACKGROUND_ACCESS_MISSING,
                        requirement = PermissionRequirement.OPTIONAL,
                        impact = "New records arrive only while Omnesis is open.",
                        remediation = "Allow background access in system Settings.",
                        repairAction = PermissionRepairAction.OPEN_SOURCE_SETTINGS,
                    ),
                ),
            ),
        ),
    )

    private fun capture(name: String, dark: Boolean) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    Column(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary).padding(OmSpacing.lg)) {
                        PermissionHealthBanner(entries, { "Fictional source" }, { _, _ -> })
                    }
                }
            }
        }
    }

    @Test fun permission_health_light() = capture("permission_health_light", false)
    @Test fun permission_health_dark() = capture("permission_health_dark", true)

    private fun captureNotification(name: String, dark: Boolean) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    Column(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary).padding(OmSpacing.lg)) {
                        NotificationHealthBanner("permission-denied") {}
                    }
                }
            }
        }
    }

    @Test fun notification_health_light() = captureNotification("notification_health_light", false)
    @Test fun notification_health_dark() = captureNotification("notification_health_dark", true)

    private fun captureNotificationSetup(name: String, dark: Boolean, issue: NotificationSetupIssue) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    Column(Modifier.fillMaxWidth().background(OmTheme.colors.bgPrimary).padding(OmSpacing.lg)) {
                        NotificationSetupBanner(issue, "dev.example.omnesis", {}, {})
                    }
                }
            }
        }
    }

    @Test fun notification_missing_client_light() = captureNotificationSetup("notification_missing_client_light", false, NotificationSetupIssue.CLIENT_CONFIG)
    @Test fun notification_missing_client_dark() = captureNotificationSetup("notification_missing_client_dark", true, NotificationSetupIssue.CLIENT_CONFIG)
    @Test fun notification_missing_gateway_light() = captureNotificationSetup("notification_missing_gateway_light", false, NotificationSetupIssue.DIRECT_CREDENTIAL)
    @Test fun notification_missing_gateway_dark() = captureNotificationSetup("notification_missing_gateway_dark", true, NotificationSetupIssue.DIRECT_CREDENTIAL)

    private fun captureGlobal(name: String, dark: Boolean) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    Box(Modifier.width(411.dp).height(891.dp).background(OmTheme.colors.bgPrimary)) {
                        Text(
                            "Ask Omnesis",
                            color = OmTheme.colors.textPrimary,
                            modifier = Modifier.align(Alignment.TopStart).padding(horizontal = OmSpacing.lg, vertical = OmSpacing.lg),
                        )
                        GlobalHealthWarningBanner(
                            notificationNeedsAttention = true,
                            permissionIssueCount = 7,
                            onOpenSettings = {},
                            modifier = Modifier.align(Alignment.TopCenter).padding(
                                start = OmSpacing.md,
                                top = 72.dp,
                                end = OmSpacing.md,
                            ),
                        )
                    }
                }
            }
        }
    }

    @Test fun global_health_multiple_issues_light() = captureGlobal("global_health_multiple_issues_light", false)
    @Test fun global_health_multiple_issues_dark() = captureGlobal("global_health_multiple_issues_dark", true)

    private fun captureGlobalDismissable(name: String, dark: Boolean) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) {
                    Box(Modifier.width(411.dp).height(891.dp).background(OmTheme.colors.bgPrimary)) {
                        Text(
                            "Ask Omnesis",
                            color = OmTheme.colors.textPrimary,
                            modifier = Modifier.align(Alignment.TopStart).padding(horizontal = OmSpacing.lg, vertical = OmSpacing.lg),
                        )
                        GlobalHealthWarningBanner(
                            notificationNeedsAttention = true,
                            permissionIssueCount = 0,
                            onOpenSettings = {},
                            modifier = Modifier.align(Alignment.TopCenter).padding(
                                start = OmSpacing.md,
                                top = 72.dp,
                                end = OmSpacing.md,
                            ),
                            onDismissNotification = {},
                        )
                    }
                }
            }
        }
    }

    @Test fun global_health_dismiss_light() = captureGlobalDismissable("global_health_dismiss_light", false)
    @Test fun global_health_dismiss_dark() = captureGlobalDismissable("global_health_dismiss_dark", true)
}
