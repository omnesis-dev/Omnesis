// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.PrivacyPolicyDocument
import dev.omnesis.android.transport.dto.PrivacyPolicyFamilySummary
import dev.omnesis.android.ui.privacy.PoliciesListContent
import dev.omnesis.android.ui.privacy.PoliciesListUiState
import dev.omnesis.android.ui.privacy.PrivacyPolicyContent
import dev.omnesis.android.ui.privacy.PrivacyPolicyUiState
import dev.omnesis.android.ui.privacy.policyFamilyRows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The Policies list under Settings and one named family's document, in both themes. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class PoliciesListScreenshotTest {
    private val defaultFamilyId = "family-everyday"

    private val families = listOf(
        PrivacyPolicyFamilySummary(
            id = "family-work",
            name = "Work updates",
            currentRevision = "fedcba9876543210fedcba9876543210",
            currentVersion = 2,
            affectedGrantIds = listOf("grant-1"),
        ),
        PrivacyPolicyFamilySummary(
            id = defaultFamilyId,
            name = "Everyday policy",
            currentRevision = "0123456789abcdef0123456789abcdef",
            currentVersion = 4,
            affectedGrantIds = listOf("grant-2", "grant-3", "grant-4"),
        ),
        PrivacyPolicyFamilySummary(
            id = "family-fresh",
            name = "Family plans with a deliberately long name that wraps onto a second line",
            currentRevision = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ),
        PrivacyPolicyFamilySummary(
            id = "family-archived",
            name = "Retired policy",
            currentRevision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            archivedAt = 1_782_000_000_000,
        ),
    )

    private fun capture(name: String, dark: Boolean, content: @Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark, content = content)
            }
        }
    }

    @Composable
    private fun populated() = PoliciesListContent(
        state = PoliciesListUiState(
            loading = false,
            policies = policyFamilyRows(families, defaultFamilyId),
        ),
        onBack = {},
    )

    @Composable
    private fun loading() = PoliciesListContent(state = PoliciesListUiState(loading = true), onBack = {})

    /** Cached rows with a refresh that failed: the rows stay and the failure is one banner. */
    @Composable
    private fun stale() = PoliciesListContent(
        state = PoliciesListUiState(
            loading = false,
            policies = policyFamilyRows(families, defaultFamilyId),
            error = IllegalStateException("The gateway did not answer."),
        ),
        onBack = {},
    )

    /** A family whose name is longer than the app bar, so the title has to ellipsise. */
    @Composable
    private fun namedPolicy() = PrivacyPolicyContent(
        state = PrivacyPolicyUiState(
            loading = false,
            familyName = "Everyday policy for the household calendar, travel plans and school runs",
            policy = PrivacyPolicyDocument(
                policy = "# Everyday policy\n\nA summary may leave Omnesis; an exact date may not.",
                revision = "example-revision",
                updatedAt = 1_782_000_000_000,
            ),
        ),
        onBack = {},
    )

    @Composable
    private fun empty() = PoliciesListContent(state = PoliciesListUiState(loading = false), onBack = {})

    @Composable
    private fun error() = PoliciesListContent(
        state = PoliciesListUiState(loading = false, error = IllegalStateException("offline")),
        onBack = {},
    )

    @Test
    fun policies_list_light() = capture("policies_list_light", false) { populated() }

    @Test
    fun policies_list_dark() = capture("policies_list_dark", true) { populated() }

    @Test
    fun policies_list_empty_light() = capture("policies_list_empty_light", false) { empty() }

    @Test
    fun policies_list_empty_dark() = capture("policies_list_empty_dark", true) { empty() }

    @Test
    fun policies_list_error_light() = capture("policies_list_error_light", false) { error() }

    @Test
    fun policies_list_error_dark() = capture("policies_list_error_dark", true) { error() }

    @Test
    fun policies_list_loading_light() = capture("policies_list_loading_light", false) { loading() }

    @Test
    fun policies_list_loading_dark() = capture("policies_list_loading_dark", true) { loading() }

    @Test
    fun policies_list_stale_light() = capture("policies_list_stale_light", false) { stale() }

    @Test
    fun policies_list_stale_dark() = capture("policies_list_stale_dark", true) { stale() }

    @Test
    fun privacy_policy_named_light() = capture("privacy_policy_named_light", false) { namedPolicy() }

    @Test
    fun privacy_policy_named_dark() = capture("privacy_policy_named_dark", true) { namedPolicy() }
}
