// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import dev.omnesis.android.transport.client.TranscriptionVocabularySnapshot
import dev.omnesis.android.transport.client.VocabularyEntry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class TranscriptionVocabularyCacheTest {
    private fun snapshot(text: String = "Veltrio") = TranscriptionVocabularySnapshot(true, listOf(VocabularyEntry(text, 2.0)))

    @Test fun offAndCoalescedWarmNeverBlockReads() = runTest {
        val cache = TranscriptionVocabularyCache { 1L }
        var calls = 0
        val reply = CompletableDeferred<TranscriptionVocabularySnapshot>()
        val fetch: suspend (String, String) -> TranscriptionVocabularySnapshot = { _, _ -> calls++; reply.await() }
        cache.warm(false, "en-US", backgroundScope, fetch = fetch)
        runCurrent()
        assertEquals(0, calls)
        repeat(3) { cache.warm(true, "en-US", backgroundScope, fetch = fetch) }
        runCurrent()
        assertEquals(2, calls)
        assertTrue(cache.phrases("dictation", "en-US").isEmpty())
        reply.complete(snapshot())
        runCurrent()
        assertEquals(listOf("Veltrio"), cache.phrases("dictation", "en-US"))
        assertTrue(cache.phrases("agent", "fr-FR").isEmpty())
        cache.warm(true, "en-US", backgroundScope, fetch = fetch)
        runCurrent()
        assertEquals(2, calls)
    }

    @Test fun stalePairingOrDisabledRepliesCannotRepopulate() = runTest {
        val cache = TranscriptionVocabularyCache { 1L }
        val old = CompletableDeferred<TranscriptionVocabularySnapshot>()
        cache.warm(true, "en-US", backgroundScope) { _, _ -> withContext(NonCancellable) { old.await() } }
        runCurrent()
        cache.reset()
        cache.warm(true, "en-US", backgroundScope) { _, _ -> snapshot("Newterm") }
        runCurrent()
        old.complete(snapshot("Oldterm"))
        runCurrent()
        assertEquals(listOf("Newterm"), cache.phrases("agent", "en-US"))
        cache.warm(false, "en-US", backgroundScope) { _, _ -> snapshot() }
        assertTrue(cache.phrases("agent", "en-US").isEmpty())
    }

    @Test fun transientRetryIsThrottledAndOfflineSnapshotExpires() = runTest {
        var time = 1L
        val cache = TranscriptionVocabularyCache { time }
        var calls = 0
        cache.warm(true, "en-US", backgroundScope) { _, _ -> snapshot() }
        runCurrent()
        time += 1_800_000
        val fail: suspend (String, String) -> TranscriptionVocabularySnapshot = { _, _ -> calls++; throw GatewayException.Network(Exception()) }
        cache.warm(true, "en-US", backgroundScope, fetch = fail)
        runCurrent()
        assertEquals(2, calls)
        assertEquals(listOf("Veltrio"), cache.phrases("dictation", "en-US"))
        cache.warm(true, "en-US", backgroundScope, fetch = fail)
        runCurrent()
        assertEquals(2, calls)
        time += 300_000
        cache.warm(true, "en-US", backgroundScope, fetch = fail)
        runCurrent()
        assertEquals(4, calls)
        time = 86_400_001
        assertTrue(cache.phrases("dictation", "en-US").isEmpty())
    }

    @Test fun forbiddenClearsBothPurposesUntilNewPairing() = runTest {
        val cache = TranscriptionVocabularyCache { 1L }
        cache.warm(true, "en-US", backgroundScope) { _, _ -> snapshot() }
        runCurrent()
        cache.warm(true, "fr-FR", backgroundScope) { _, _ -> throw GatewayException.Forbidden() }
        runCurrent()
        assertTrue(cache.phrases("dictation", "en-US").isEmpty())
        var calls = 0
        cache.warm(true, "en-US", backgroundScope) { _, _ -> calls++; snapshot() }
        runCurrent()
        assertEquals(0, calls)
        cache.reset()
        cache.warm(true, "en-US", backgroundScope) { _, _ -> snapshot() }
        runCurrent()
        assertFalse(cache.phrases("agent", "en-US").isEmpty())
    }

    @Test fun emptyAndDisabledSnapshotsClearAndBoundsRejectMalformedHints() = runTest {
        val cache = TranscriptionVocabularyCache { 1L }
        val entries = listOf(VocabularyEntry("valid", 4.0), VocabularyEntry("VALID", 3.0), VocabularyEntry("unsafe\nline", 3.0), VocabularyEntry("bad", Double.NaN)) +
            (1..150).map { VocabularyEntry("Term$it", 2.0) }
        cache.warm(true, "en-US", backgroundScope) { _, _ -> TranscriptionVocabularySnapshot(true, entries) }
        runCurrent()
        val phrases = cache.phrases("agent", "en-US")
        assertEquals(100, phrases.size)
        assertEquals("valid", phrases.first())
        assertFalse(phrases.contains("VALID"))
        assertFalse(phrases.contains("bad"))
        cache.warm(false, "en-US", backgroundScope) { _, _ -> snapshot() }
        cache.warm(true, "en-US", backgroundScope) { _, _ -> TranscriptionVocabularySnapshot() }
        runCurrent()
        assertTrue(cache.phrases("agent", "en-US").isEmpty())
    }
    @Test fun oldStatusOwnerCannotWarmNewPairingAndNegativeClockStartsImmediately() = runTest {
        val cache = TranscriptionVocabularyCache { -500_000L }
        val oldOwner = cache.ownerToken()
        cache.reset()
        var calls = 0
        cache.warm(true, "en-US", backgroundScope, ownerToken = oldOwner) { _, _ -> calls++; snapshot() }
        runCurrent()
        assertEquals(0, calls)
        cache.warm(true, "en-US", backgroundScope, ownerToken = cache.ownerToken()) { _, _ -> calls++; snapshot() }
        runCurrent()
        assertEquals(2, calls)
        assertEquals(listOf("Veltrio"), cache.phrases("agent", "en-US"))
    }

    @Test fun localeRotationDropsOldSnapshotAndRejectsInvalidLocales() = runTest {
        val cache = TranscriptionVocabularyCache { 1L }
        cache.warm(true, "en-US", backgroundScope) { _, _ -> snapshot() }
        runCurrent()
        cache.warm(true, "fr-FR", backgroundScope) { _, _ -> snapshot("Lorméa") }
        runCurrent()
        assertTrue(cache.phrases("agent", "en-US").isEmpty())
        assertEquals(listOf("Lorméa"), cache.phrases("agent", "fr-FR"))
        var calls = 0
        cache.warm(true, "invalid_locale", backgroundScope) { _, _ -> calls++; snapshot() }
        runCurrent()
        assertEquals(0, calls)
    }

    @Test fun oldStatusAuthFailureCannotClearNewPairingSnapshot() = runTest {
        val cache = TranscriptionVocabularyCache { 1L }
        val oldOwner = cache.ownerToken()
        cache.reset()
        cache.warm(true, "en-US", backgroundScope) { _, _ -> snapshot("Newterm") }
        runCurrent()
        cache.reset(expectedOwner = oldOwner)
        assertEquals(listOf("Newterm"), cache.phrases("agent", "en-US"))
        cache.reset(expectedOwner = cache.ownerToken())
        assertTrue(cache.phrases("agent", "en-US").isEmpty())
    }

}
