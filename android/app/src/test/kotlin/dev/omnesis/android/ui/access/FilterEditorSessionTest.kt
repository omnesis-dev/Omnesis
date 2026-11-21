// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class FilterEditorSessionTest {
    private val ref = FilterRef.item(FilterRef.MEMBERSHIP, "extra.labelIds", "label-example")
    private val policy = SourceFilter("mail:reader@example.org", FilterAudience("level-example", "answer"), listOf(FilterRule(listOf(ref), "share")), "hide")
    private fun preview(source: String = policy.sourceId, missing: Boolean = false) =
        readyPreview(source, 4, 2, listOf(FilterPreviewItem(ref, if (missing) "label-example" else "Workshop", 2, missing = missing)))
    @Test fun optionsAndPreviewsSharePhysicalCapacityEvenWhenTheirConsumerIsCancelled() = runBlocking {
        val started = AtomicInteger(); val physical = AtomicInteger(); val peak = AtomicInteger()
        val release = CompletableDeferred<Unit>()
        suspend fun enter() { started.incrementAndGet(); val count = physical.incrementAndGet(); peak.updateAndGet { maxOf(it, count) }; try { release.await() } finally { physical.decrementAndGet() } }
        val session = FilterEditorSession(FakeFilterGateway(
            previewFor = { enter(); preview() },
            optionsFor = { enter(); FilterOptions(it.sourceId, it.field) },
        ))
        val first = launch { session.preview(policy) }
        val second = launch { session.options(policy.sourceId, "extra.labelIds", "", null, null, null) }
        withTimeout(5000) { while (started.get() < 2) yield() }
        first.cancel()
        val third = launch { session.preview(policy) }
        repeat(10) { yield() }
        assertEquals(2, started.get()); assertEquals(2, physical.get())
        release.complete(Unit)
        joinAll(first, second, third)
        assertEquals(2, peak.get()); assertEquals(0, physical.get())
    }
    @Test fun missingResultsKeepFriendlyLabelsAndWrongSourceResponsesAreRejected() = runBlocking {
        var missing = false; var wrong = false
        val session = FilterEditorSession(FakeFilterGateway(
            previewFor = { preview(if (wrong) "other" else it.sourceId, missing) },
            optionsFor = { FilterOptions("other", it.field) },
            editorFor = { FilterEditor("other", "mail") },
        ))
        session.preview(policy); missing = true; session.preview(policy)
        assertEquals("Workshop", session.label(policy.sourceId, ref))
        // The entry is remembered as missing, so its row says the list no longer names it.
        assertTrue(session.hints.value.getValue(policy.sourceId to filterRefKey(ref)).missing)
        missing = false; session.preview(policy)
        assertFalse(session.hints.value.getValue(policy.sourceId to filterRefKey(ref)).missing)
        wrong = true
        try { session.preview(policy); fail("Wrong source accepted") } catch (_: IllegalStateException) { }
        try { session.options(policy.sourceId, "extra.labelIds", "", null, null, null); fail("Wrong options accepted") } catch (_: IllegalStateException) { }
        try { session.editor(policy.sourceId); fail("Wrong editor accepted") } catch (_: IllegalStateException) { }
        // A pending preview names no source yet and is accepted as it is.
        val pending = FilterEditorSession(FakeFilterGateway(previewFor = { pendingPreview() }))
        assertTrue(pending.preview(policy).pending)
    }
    @Test fun hintsUseStableIdsKeepTheDepthAChoiceGaveAndTheEditorIsRemembered() = runBlocking {
        val other = FilterRef.item(FilterRef.MEMBERSHIP, "extra.labelIds", "another-label")
        val session = FilterEditorSession(FakeFilterGateway(
            previewFor = { preview() },
            optionsFor = { FilterOptions(it.sourceId, it.field, listOf(FilterOption(ref, "Renamed", count = 2, depth = 1), FilterOption(other, "Renamed", count = 1))) },
            editorFor = { FilterEditor(it, "mail", fields = listOf(readyField("extra.labelIds", FilterRef.MEMBERSHIP, "label", "labels"))) },
        ))
        session.options(policy.sourceId, "extra.labelIds", "", null, null, null)
        session.preview(policy)
        assertEquals("Workshop", session.label(policy.sourceId, ref))
        assertEquals(1, session.hints.value[policy.sourceId to filterRefKey(ref)]?.depth)
        assertEquals("Renamed", session.label(policy.sourceId, other))
        assertEquals(2, session.hints.value.size)
        session.editor(policy.sourceId)
        assertEquals("labels", session.editors.value[policy.sourceId]?.fields?.single()?.noun?.many)
    }
    @Test fun resyncAndAddressChecksGoThroughTheSession() = runBlocking {
        val fake = FakeFilterGateway(identifierFor = { type, _ -> FilterIdentifierCheck(FilterIdentifier(type, "+15550100142")) })
        val session = fake.editorSession()
        session.resync(policy.sourceId)
        assertEquals(listOf(policy.sourceId), fake.resynced)
        assertEquals("+15550100142", session.identifier("phone", "00 1 (555) 010-0142").identifier?.value)
        assertSame(session, session.editorSession())
    }
}
