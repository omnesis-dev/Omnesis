// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.voice

import androidx.test.core.app.ApplicationProvider
import dagger.hilt.EntryPoint
import dagger.hilt.EntryPoints
import dagger.hilt.InstallIn
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import dagger.hilt.android.testing.HiltTestApplication
import dagger.hilt.components.SingletonComponent
import dev.omnesis.android.pairing.PairingService
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.ui.home.MockGateway
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@EntryPoint
@InstallIn(SingletonComponent::class)
interface SpeechReadinessEntryPoint {
    fun pairingService(): PairingService
    fun sessionManager(): SessionManager
    fun speechReadiness(): SpeechReadiness
}

/**
 * Speech readiness on the real Hilt graph, paired to a [MockGateway]: a cold start's
 * unknowns — the dictation gate and the vocabulary fetches — are settled when it returns.
 */
@HiltAndroidTest
@RunWith(RobolectricTestRunner::class)
@Config(application = HiltTestApplication::class, sdk = [34])
class GatewaySpeechReadinessTest {
    @get:Rule
    val hilt = HiltAndroidRule(this)

    private val gateway = MockGateway()
    private val graph: SpeechReadinessEntryPoint
        get() = EntryPoints.get(
            ApplicationProvider.getApplicationContext<HiltTestApplication>(),
            SpeechReadinessEntryPoint::class.java,
        )

    @After
    fun tearDown() {
        runCatching { graph.sessionManager().beginRepair() }
        gateway.close()
    }

    @Test
    fun readiness_returns_with_the_dictation_gate_read_and_the_vocabulary_fetches_answered() = runBlocking {
        gateway.statusJson = """{"documents":{"total":0,"bySource":{}},"experimental":false,""" +
            """"transcriptionVocabulary":true,"dictation":{"visible":true,"enabled":true,""" +
            """"modelAssigned":true,"active":true,"maxAudioBytes":1000000}}"""
        graph.pairingService().pairManually(gateway.url, "ABCD-EFGH", gateway.fingerprint)

        // The session manager is created here, the way a cold start creates it: its
        // status read has only just been launched.
        val session = graph.sessionManager()
        withTimeout(TIMEOUT_MS) { graph.speechReadiness().await() }

        assertEquals(true, session.dictation.value?.active)
        // One fetch per speech purpose, each answered before readiness returned.
        assertEquals(2, gateway.requests.count { it == "POST /inference/transcription-vocabulary" })
    }

    @Test
    fun readiness_does_not_wait_while_unpaired() = runBlocking {
        val session = graph.sessionManager()
        withTimeout(TIMEOUT_MS) { graph.speechReadiness().await() }
        assertNull(session.dictation.value)
    }

    @Test
    fun readiness_returns_once_the_status_read_has_failed() = runBlocking {
        graph.pairingService().pairManually(gateway.url, "ABCD-EFGH", gateway.fingerprint)
        gateway.close()

        val session = graph.sessionManager()
        withTimeout(TIMEOUT_MS) { graph.speechReadiness().await() }
        assertNull(session.dictation.value)
    }

    private companion object {
        const val TIMEOUT_MS = 20_000L
    }
}
