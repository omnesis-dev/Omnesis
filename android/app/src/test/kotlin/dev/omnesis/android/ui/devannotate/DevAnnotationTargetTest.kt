// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devannotate

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DevAnnotationTargetTest {

    @Test
    fun document_route_targets_the_open_document() {
        val target = devTargetForRoute(
            route = "document/doc-1",
            documentId = "doc-1",
            agentSessionId = "s-9",
        )
        assertEquals("document", target.targetType)
        assertEquals("doc-1", target.targetId)
        assertEquals("document/doc-1", target.deepLink)
    }

    @Test
    fun agent_route_targets_the_open_conversation() {
        val target = devTargetForRoute(
            route = "agent",
            documentId = null,
            agentSessionId = "s-9",
        )
        assertEquals("conversation", target.targetType)
        assertEquals("s-9", target.targetId)
    }

    @Test
    fun agent_route_without_a_session_files_a_freeform_note() {
        // Fresh hero state: no conversation exists yet, so there is nothing
        // addressable — the note still files, tagged with the route.
        val target = devTargetForRoute(
            route = "agent",
            documentId = null,
            agentSessionId = null,
        )
        assertEquals("route", target.targetType)
        assertNull(target.targetId)
        assertEquals("agent", target.deepLink)
    }

    @Test
    fun unmapped_route_files_a_freeform_note_tagged_with_the_route() {
        val target = devTargetForRoute(
            route = "settings",
            documentId = null,
            agentSessionId = "s-9",
        )
        assertEquals("route", target.targetType)
        assertNull(target.targetId)
        assertEquals("General note — settings", target.label)
        assertEquals("settings", target.deepLink)
    }

    @Test
    fun missing_route_still_files_a_general_note() {
        val target = devTargetForRoute(
            route = null,
            documentId = null,
            agentSessionId = null,
        )
        assertEquals("route", target.targetType)
        assertEquals("General note", target.label)
        assertNull(target.deepLink)
    }

    @Test
    fun document_pattern_resolves_through_arguments_not_placeholders() {
        // At runtime `NavDestination.route` is the pattern (`document/{id}`),
        // never the filled address — the id comes from the entry's arguments.
        // The filed deep link must be the real address, not the template.
        val target = devTargetForRoute(
            route = "document/{id}",
            documentId = "doc-9",
            agentSessionId = null,
        )
        assertEquals("document", target.targetType)
        assertEquals("doc-9", target.targetId)
        assertEquals("document/doc-9", target.deepLink)
    }

    @Test
    fun document_pattern_without_an_id_files_a_freeform_note() {
        val target = devTargetForRoute(
            route = "document/{id}",
            documentId = null,
            agentSessionId = null,
        )
        assertEquals("route", target.targetType)
        assertNull(target.targetId)
        assertNull(target.deepLink)
    }

    @Test
    fun templated_pattern_never_reaches_the_store_as_a_deep_link() {
        val target = devTargetForRoute(
            route = "watches/{watchId}?firingKey={firingKey}",
            documentId = null,
            agentSessionId = null,
        )
        assertEquals("route", target.targetType)
        assertNull(target.targetId)
        assertNull(target.deepLink)
    }
}
