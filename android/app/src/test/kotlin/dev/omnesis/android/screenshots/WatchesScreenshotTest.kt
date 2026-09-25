// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.screenshots

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import com.github.takahirom.roborazzi.captureRoboImage
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.transport.dto.PrivacySubscriptionFiring
import dev.omnesis.android.transport.dto.WatchDisclosureDto
import dev.omnesis.android.transport.dto.WatchFiringDeliveryDto
import dev.omnesis.android.transport.dto.WatchFiringDocumentDto
import dev.omnesis.android.transport.dto.WatchFiringDto
import dev.omnesis.android.transport.dto.WatchRecordDto
import dev.omnesis.android.transport.dto.WatchVerdictDto
import dev.omnesis.android.ui.watches.WatchDetailContent
import dev.omnesis.android.ui.watches.WatchDetailUiState
import dev.omnesis.android.ui.watches.WatchesContent
import dev.omnesis.android.ui.watches.WatchesUiState
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The watch runtime's surface on Android — the list, and one watch's ledger.
 *
 * The states worth looking at are the ones a person only sees when something
 * has gone wrong or gone quiet: a paused watch that has to say why, a firing
 * nobody was told about, and a watch that has never fired. Those are exactly
 * the states hardest to reach by hand on a real install, which is why they are
 * pinned here.
 *
 * All sample data is invented, never sourced from the corpus.
 *
 *   ./gradlew :app:recordRoborazziDebug   ->   app/build/outputs/roborazzi/
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w411dp-h891dp-xxhdpi")
class WatchesScreenshotTest {

    private fun capture(name: String, dark: Boolean, content: @androidx.compose.runtime.Composable () -> Unit) {
        captureRoboImage(filePath = "src/test/roborazzi/$name.png") {
            CompositionLocalProvider(LocalInspectionMode provides true) {
                OmnesisTheme(darkTheme = dark) { content() }
            }
        }
    }

    private fun disclosure(
        integrationName: String? = "Hermes",
        status: String = "active",
        instruction: String? = "Read the invoice and reply to the thread it arrived on.",
    ) = WatchDisclosureDto(
        authoredBy = "integration",
        subscriptionId = "sub_hermes",
        status = status,
        integrationName = integrationName,
        instruction = instruction,
    )

    private fun watches() = listOf(
        WatchRecordDto(
            id = "w_invoice",
            name = "an-invoice-arrived",
            status = "active",
            addedAt = "2026-05-01T09:00:00.000Z",
            firings = 4,
            fromSeq = 41,
            request = "an invoice arrives from a supplier I have not paid before",
            delivery = "omnesis-notify",
        ),
        // The row an integration asked for, and which wakes it rather than the reader — both
        // of those are indicators on the row rather than sections of the list.
        WatchRecordDto(
            id = "w_venue",
            name = "the-venue-confirms-a-date",
            status = "active",
            firings = 0,
            request = "the venue confirms a date for the spring showcase",
            delivery = "agent-wake",
            disclosure = disclosure(),
        ),
        WatchRecordDto(
            id = "w_broken",
            name = "a-deadline-passed",
            status = "paused",
            note = "node 'mail' failed (provider) — see `watch trace`",
            firings = 2,
            request = "a deadline I agreed to in writing passes without me sending anything",
        ),
        // Running, delivering, and worth doing something about: the verdict is the only other
        // coloured thing a row can carry.
        WatchRecordDto(
            id = "w_quiet",
            name = "a-contract-is-countersigned",
            status = "active",
            firings = 0,
            request = "a contract comes back countersigned",
            delivery = "omnesis-notify",
            verdict = WatchVerdictDto(
                name = "never-matched",
                label = "Never matched",
                because = "looked at 4,183 events over 21 days and admitted none",
                actionable = true,
            ),
        ),
        WatchRecordDto(
            id = "w_done",
            name = "the-deposit-cleared",
            status = "retired",
            note = "fired once and was done",
            firings = 1,
            request = "the deposit clears",
        ),
    )

    private fun firings() = listOf(
        // Delivered, with the documents it was reached through.
        WatchFiringDto(
            seq = 15226,
            firedAt = "2026-05-04T09:15:00.000Z",
            noticedAt = "2026-05-04T09:15:30.000Z",
            delivery = WatchFiringDeliveryDto(kind = "omnesis-notify", delivered = 1, attempted = 1),
            documents = listOf(
                WatchFiringDocumentDto(
                    id = "doc_quote",
                    title = "Your quote for the roof",
                    sourceId = "gmail:jamie.lopez@example.com",
                ),
                WatchFiringDocumentDto(
                    id = "doc_schedule",
                    title = "Schedule of works.pdf",
                    sourceId = "gmail:jamie.lopez@example.com",
                ),
            ),
        ),
        // Fired, and nobody was told — the case the row exists for.
        WatchFiringDto(
            seq = 15775,
            firedAt = "2026-05-06T11:32:24.000Z",
            noticedAt = "2026-05-06T11:32:24.900Z",
            delivery = WatchFiringDeliveryDto(
                kind = "omnesis-notify",
                delivered = 0,
                attempted = 2,
                error = "APNs delivery failed for all 2 device(s)",
            ),
        ),
        // Noticed most recently, about something dated months earlier. The
        // sequence is the journal's own order, so it rises with the moment the
        // runtime noticed — never with the subject's date.
        WatchFiringDto(
            seq = 16003,
            firedAt = "2026-03-01T12:00:00.000Z",
            noticedAt = "2026-05-07T08:30:00.000Z",
        ),
    )

    @Test fun watchesList() {
        capture("watches-list", dark = true) {
            WatchesContent(
                state = WatchesUiState(loading = false, watches = watches()),
                onOpenWatch = {},
                onRetry = {},
            )
        }
    }

    @Test fun watchesListLight() {
        capture("watches-list-light", dark = false) {
            WatchesContent(
                state = WatchesUiState(loading = false, watches = watches()),
                onOpenWatch = {},
                onRetry = {},
            )
        }
    }

    @Test fun watchesEmpty() {
        // Named as something to do rather than as an absence: this screen
        // cannot create a watch, so "none" alone would strand the reader.
        capture("watches-empty", dark = true) {
            WatchesContent(
                state = WatchesUiState(loading = false),
                onOpenWatch = {},
                onRetry = {},
            )
        }
    }

    @Test fun watchDetailWithFirings() {
        capture("watch-detail", dark = true) {
            WatchDetailContent(
                state = WatchDetailUiState(
                    loading = false,
                    watch = watches()[0],
                    firings = firings(),
                ),
                onRetry = {},
                onShowDefinition = {},
            )
        }
    }

    @Test fun watchDetailShowingItsDefinition() {
        capture("watch-detail-definition", dark = true) {
            WatchDetailContent(
                state = WatchDetailUiState(
                    loading = false,
                    watch = watches()[0],
                    firings = emptyList(),
                    definition = """
                        {
                          "name": "an-invoice-arrived",
                          "nodes": [
                            {
                              "id": "mail",
                              "type": "source.document_event",
                              "filter": { "source": "gmail", "documentType": "email" }
                            }
                          ]
                        }
                    """.trimIndent(),
                ),
                onRetry = {},
                onShowDefinition = {},
            )
        }
    }

    /**
     * The record of what a watch may tell an integration, and the way out of it. The three
     * states worth capturing are the ones that differ in what the reader can still do:
     * an active grant, one the operator asked for themselves, and one already withdrawn.
     */
    @Test fun watchDetailDisclosingToAnIntegration() {
        capture("watch-detail-disclosure", dark = true) {
            WatchDetailContent(
                state = WatchDetailUiState(
                    loading = false,
                    watch = watches()[1],
                    firings = emptyList(),
                    disclosure = disclosure(),
                ),
                onRetry = {},
                onShowDefinition = {},
            )
        }
    }

    @Test fun watchDetailDisclosingToAnIntegrationLight() {
        capture("watch-detail-disclosure-light", dark = false) {
            WatchDetailContent(
                state = WatchDetailUiState(
                    loading = false,
                    watch = watches()[1],
                    firings = emptyList(),
                    disclosure = disclosure(),
                ),
                onRetry = {},
                onShowDefinition = {},
            )
        }
    }

    /** Already withdrawn: the section still accounts for what was sent, minus the way out. */
    @Test fun watchDetailWithRevokedAccess() {
        capture("watch-detail-disclosure-revoked", dark = true) {
            WatchDetailContent(
                state = WatchDetailUiState(
                    loading = false,
                    watch = watches()[1],
                    firings = emptyList(),
                    disclosure = disclosure(status = "revoked", instruction = null),
                ),
                onRetry = {},
                onShowDefinition = {},
            )
        }
    }

    /** A revoke that did not land must say so without losing the button. */
    @Test fun watchDetailWhenRevokeFailed() {
        capture("watch-detail-revoke-failed", dark = true) {
            WatchDetailContent(
                state = WatchDetailUiState(
                    loading = false,
                    watch = watches()[1],
                    firings = emptyList(),
                    disclosure = disclosure(),
                    actionError = java.io.IOException("fictional gateway unavailable"),
                ),
                onRetry = {},
                onShowDefinition = {},
            )
        }
    }

    /**
     * The runtime caught three firings and the egress ledger accounts for one of them, plus a
     * disclosure the runtime has no record of. Both ledgers, one list.
     */
    @Test fun watchDetailFoldingBothLedgers() {
        capture("watch-detail-ledgers", dark = true) {
            WatchDetailContent(
                state = WatchDetailUiState(
                    loading = false,
                    watch = watches()[1],
                    firings = firings(),
                    disclosure = disclosure(),
                    sentFirings = listOf(
                        PrivacySubscriptionFiring(
                            id = "egress_15226",
                            subscriptionId = "sub_hermes",
                            createdAt = 1_777_886_100_000,
                            deliveryStatus = "accepted",
                            acceptedAt = 1_777_886_101_000,
                            watchId = "w_venue",
                            seq = 15226,
                        ),
                        PrivacySubscriptionFiring(
                            id = "egress_orphan",
                            subscriptionId = "sub_hermes",
                            createdAt = 1_778_060_000_000,
                            deliveryStatus = "accepted",
                            watchId = "w_venue",
                            seq = 99999,
                        ),
                    ),
                ),
                onRetry = {},
                onShowDefinition = {},
            )
        }
    }

    @Test fun watchDetailPausedAndSayingWhy() {
        // A watch that stopped and cannot say why is one the operator has to
        // delete to recover from.
        capture("watch-detail-paused", dark = true) {
            WatchDetailContent(
                state = WatchDetailUiState(
                    loading = false,
                    watch = watches()[2],
                    firings = emptyList(),
                ),
                onRetry = {},
                onShowDefinition = {},
            )
        }
    }
}
