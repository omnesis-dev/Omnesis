// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.session

import dev.omnesis.android.ui.root.relayConsentDialogVisible
import java.io.IOException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** An Allow under way on the relay request, and what it leaves for the next answer. */
@OptIn(ExperimentalCoroutinesApi::class)
class RelayConsentRequestTest {
    private val waiting = SessionManager.RelayConsentPrompt("device-1", "dev.example.omnesis")

    @Test
    fun aCancelledAllowLeavesTheRequestAnswerableByTheSheet() = runTest {
        val prompts = MutableStateFlow<SessionManager.RelayConsentPrompt?>(waiting)
        val call = launch { requestRelayConsent(prompts, waiting, isCurrent = { true }) { awaitCancellation() } }
        runCurrent()
        assertTrue(prompts.value!!.requesting)

        call.cancelAndJoin()

        assertEquals(waiting, prompts.value)
        assertFalse("the sheet's answers are enabled", prompts.value!!.requesting)
        assertTrue(relayConsentDialogVisible(firstRunSetup = false, setupPresenting = false))
    }

    @Test
    fun aCancelledAllowLeavesARequestClearedMeanwhileCleared() = runTest {
        val prompts = MutableStateFlow<SessionManager.RelayConsentPrompt?>(waiting)
        val call = launch {
            requestRelayConsent(prompts, waiting, isCurrent = { true }) {
                prompts.value = null
                awaitCancellation()
            }
        }
        runCurrent()

        call.cancelAndJoin()

        assertNull(prompts.value)
    }

    @Test
    fun aFailedAllowShowsItsErrorWithTheAnswersEnabled() = runTest {
        val prompts = MutableStateFlow<SessionManager.RelayConsentPrompt?>(waiting)

        requestRelayConsent(prompts, waiting, isCurrent = { true }) { throw IOException("offline") }

        assertFalse(prompts.value!!.requesting)
        assertTrue(prompts.value!!.error != null)
    }
}
