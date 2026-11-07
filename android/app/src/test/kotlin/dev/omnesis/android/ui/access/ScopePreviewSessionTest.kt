// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.transport.dto.*
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class ScopePreviewSessionTest {
    private val ref = ScopeRef("label", "label-example")
    private val policy = ScopePolicy("mail:reader@example.org", ScopeAudience("level-example", "answer"), listOf(ScopeRule(listOf(ref), "share")), "hide")
    private val scopes = SourceScopes(listOf(SourceScopeItem("label", "changes")))
    private fun preview(source: String = policy.sourceId, missing: Boolean = false) = ScopePreview(source, 4, 2, 2, 0, listOf(ScopePreviewItem(ref, if (missing) "label-example" else "Workshop", 2, missing = missing)), emptyList(), emptyList())
    @Test fun optionsAndPreviewsSharePhysicalCapacityEvenWhenTheirConsumerIsCancelled() = runBlocking {
        val started = AtomicInteger(); val physical = AtomicInteger(); val peak = AtomicInteger()
        val release = CompletableDeferred<Unit>()
        suspend fun enter() { started.incrementAndGet(); val count = physical.incrementAndGet(); peak.updateAndGet { maxOf(it, count) }; try { release.await() } finally { physical.decrementAndGet() } }
        val session = ScopePreviewSession(object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy): ScopePreview { enter(); return preview() }
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?): ScopeOptions { enter(); return ScopeOptions(sourceId, "mail", scopes, emptyList(), emptyList()) }
        })
        val first = launch { session.preview(policy) }
        val second = launch { session.options(policy.sourceId, "label", "", null, null) }
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
        val session = ScopePreviewSession(object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy) = preview(if (wrong) "other" else policy.sourceId, missing)
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?) = ScopeOptions("other", "mail", scopes, emptyList(), emptyList())
        })
        session.preview(policy); missing = true; session.preview(policy)
        assertEquals("Workshop", session.label(policy.sourceId, ref))
        wrong = true
        try { session.preview(policy); fail("Wrong source accepted") } catch (_: IllegalStateException) { }
        try { session.options(policy.sourceId, "label", "", null, null); fail("Wrong options accepted") } catch (_: IllegalStateException) { }
    }
    @Test fun displayHintsUseStableIdsWhileEqualNamesAndExpandedCapturesStaySeparate() = runBlocking {
        val renamed = ref.copy(label = "Renamed")
        val other = ScopeRef("label", "another-label")
        val session = ScopePreviewSession(object : ScopeEditorGateway {
            override suspend fun preview(policy: ScopePolicy) = preview()
            override suspend fun options(sourceId: String, kind: String, query: String, parentId: String?, cursor: String?) = ScopeOptions(sourceId, "mail", scopes, emptyList(), listOf(ScopeOption(renamed, "Renamed", 2), ScopeOption(other, "Renamed", 1)))
        })
        session.preview(policy)
        session.options(policy.sourceId, "label", "", null, null)
        assertEquals("Renamed", session.label(policy.sourceId, ref))
        assertEquals("Renamed", session.label(policy.sourceId, other))
        assertEquals(2, session.labels.value.size)
        val captured = ScopeRef("participant", identifiers = listOf(ScopeIdentifier("email", "reader@example.org")))
        val expanded = captured.copy(identifiers = captured.identifiers!! + ScopeIdentifier("email", "other@example.org"))
        assertNotEquals(scopeRefKey(captured), scopeRefKey(expanded))
    }
}
