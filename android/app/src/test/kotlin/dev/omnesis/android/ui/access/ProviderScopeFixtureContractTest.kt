// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
package dev.omnesis.android.ui.access

import dev.omnesis.android.screenshots.AccessLevelScreenshotTest
import dev.omnesis.android.transport.dto.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Assert the strict gateway reference contract on the actual HTTP-encoded fixture payload. */
internal fun assertProviderWireRef(ref: ScopeRef) {
    val wire = OmnesisJson.parseToJsonElement(OmnesisJson.encodeToString(ref)).jsonObject
    if (ref.kind == "participant") {
        assertEquals(setOf("kind", "label", "identifiers"), wire.keys)
        assertTrue(wire.getValue("label").jsonPrimitive.content.isNotBlank())
        assertTrue(wire.getValue("identifiers").jsonArray.isNotEmpty())
        wire.getValue("identifiers").jsonArray.forEach { element ->
            assertEquals(setOf("type", "value"), element.jsonObject.keys)
            assertTrue(element.jsonObject.getValue("type").jsonPrimitive.content in setOf("email", "phone", "domain"))
            assertTrue(element.jsonObject.getValue("value").jsonPrimitive.content.isNotBlank())
        }
    } else {
        assertTrue(ref.kind in setOf("label", "folder", "conversation"))
        assertEquals(setOf("kind", "id"), wire.keys)
        assertTrue(wire.getValue("id").jsonPrimitive.content.isNotBlank())
    }
}
internal fun assertProviderWirePolicy(policy: ScopePolicy) = policy.rules.flatMap { it.match }.forEach(::assertProviderWireRef)
internal fun assertProviderWireOptions(options: ScopeOptions): ScopeOptions = options.also { it.items.forEach { item -> assertProviderWireRef(item.ref) } }
internal fun assertProviderWireWrite(rules: List<AccessGrantRule>) {
    val body = AccessLevelCreateBody("Fixture contract", rules)
    val encoded = OmnesisJson.parseToJsonElement(OmnesisJson.encodeToString(body)).jsonObject
    encoded.getValue("rules").jsonArray.forEach { grant ->
        grant.jsonObject["scopePolicies"]?.jsonArray.orEmpty().forEach { policy ->
            policy.jsonObject.getValue("rules").jsonArray.forEach { rule ->
                rule.jsonObject.getValue("match").jsonArray.forEach { ref ->
                    assertProviderWireRef(OmnesisJson.decodeFromJsonElement<ScopeRef>(ref))
                }
            }
        }
    }
}
class ProviderScopeFixtureContractTest {
    @Test fun publicScreenshotWriteAndAllDeclaredProviderOptionsUseStrictWireReferences() = runBlocking {
        val fixture = AccessLevelScreenshotTest
        assertProviderWireWrite(fixture.level.rules)
        assertProviderWireRef(ScopeRef("folder", "workspace"))
        assertProviderWireRef(ScopeRef("label", "Label_41"))
        assertProviderWireRef(ScopeRef("conversation", "conversation-example"))
        fixture.refs.forEach(::assertProviderWireRef)
        fixture.overview.sources.forEach { source -> source.scopes!!.items.forEach { item ->
            assertProviderWireOptions(fixture.gateway.options(source.id, item.kind, "", null, null))
        } }
    }
    @Test fun fakeWritesRejectFriendlyNamesOnStableReferencesAndUncapturedParticipants() {
        assertThrows(AssertionError::class.java) { assertProviderWireRef(ScopeRef("folder", "workspace", "Workspace")) }
        assertThrows(AssertionError::class.java) { assertProviderWireRef(ScopeRef("participant", label = "Reader")) }
        assertProviderWireRef(ScopeRef("participant", label = "Reader", identifiers = listOf(ScopeIdentifier("email", "reader@example.org"))))
    }
}
