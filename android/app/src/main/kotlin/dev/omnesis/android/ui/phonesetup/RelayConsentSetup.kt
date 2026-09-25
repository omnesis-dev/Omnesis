// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.phonesetup

import androidx.compose.runtime.Composable
import dev.omnesis.android.session.RelayConsentActions
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.setup.flow.PhoneSetupFlow
import dev.omnesis.android.setup.ui.SetupPageScaffold
import dev.omnesis.android.setup.ui.SetupProgress
import dev.omnesis.android.setup.ui.asSetupForeground
import dev.omnesis.android.setup.ui.setupPalette
import dev.omnesis.android.ui.root.RelayConsentAnswers
import dev.omnesis.android.ui.root.RelayConsentBody
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged

/** The id of the page phone setup inserts before Finish while a relay request is waiting. */
const val RELAY_CONSENT_STEP_ID = "private-notification-wakes"

/**
 * A relay request inside phone setup. While one is waiting and notifications
 * are on for this phone, at any point before the flow closes, the flow walks a
 * "Private notification wakes" page right before Finish, and drops it again
 * once the request clears or notifications are turned off. With notifications
 * skipped there are no wakes to ask about, so the walk ends without the page.
 *
 * The page answers exactly as the standalone sheet does. Allow settles the
 * request on the gateway, so the sheet has nothing left to ask. Not now defers
 * it with the sheet's own deferral, so the sheet may ask again on a later
 * visit to the app — but this flow does not add the page again.
 */
internal class RelayConsentSetup(private val flow: PhoneSetupFlow, private val consent: RelayConsentActions) {
    private var declined = false

    /** Keeps the page in step with the request and with whether notifications are on, for as long as it is collected. */
    suspend fun follow(prompts: Flow<SessionManager.RelayConsentPrompt?>, notificationsOn: Flow<Boolean>) {
        combine(prompts, notificationsOn.distinctUntilChanged()) { prompt, on -> prompt to on }
            .collect { (prompt, on) -> onPrompt(prompt, on) }
    }

    fun onPrompt(prompt: SessionManager.RelayConsentPrompt?, notificationsOn: Boolean) {
        if (prompt != null && notificationsOn && !declined) {
            flow.insertBeforeFinish(RELAY_CONSENT_STEP_ID)
        } else {
            flow.removeInserted(RELAY_CONSENT_STEP_ID)
        }
    }

    fun allow() = consent.allowRelayConsent()

    fun notNow() {
        if (consent.relayConsentPrompt.value?.requesting == true) return
        declined = true
        consent.dismissRelayConsent()
    }
}

/** The relay request as a setup page: the shared relay body, with its answers at the bottom. */
@Composable
fun RelayConsentStepPage(
    appId: String,
    requesting: Boolean,
    error: String?,
    progress: SetupProgress,
    onAllow: () -> Unit,
    onNotNow: () -> Unit,
) {
    val palette = setupPalette
    SetupPageScaffold(
        tint = NotificationsSetupCopy.tint,
        progress = progress,
        bottom = { RelayConsentAnswers(requesting, error, onAllow, onNotNow) },
    ) {
        RelayConsentBody(appId, iconTint = NotificationsSetupCopy.tint.asSetupForeground(palette))
    }
}
