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

/** Assert the gateway's strict entry shapes on the actual HTTP-encoded fixture payload. */
internal fun assertProviderWireRef(ref: FilterRef) {
    val wire = OmnesisJson.parseToJsonElement(OmnesisJson.encodeToString(ref)).jsonObject
    if (ref.isPerson) {
        assertEquals(setOf("capability", "label", "identifiers"), wire.keys)
        assertTrue(wire.getValue("label").jsonPrimitive.content.isNotBlank())
        assertTrue(wire.getValue("identifiers").jsonArray.isNotEmpty())
        wire.getValue("identifiers").jsonArray.forEach { element ->
            assertEquals(setOf("type", "value"), element.jsonObject.keys)
            assertTrue(element.jsonObject.getValue("type").jsonPrimitive.content in setOf("email", "phone", "domain"))
            assertTrue(element.jsonObject.getValue("value").jsonPrimitive.content.isNotBlank())
        }
    } else {
        assertTrue(ref.capability in setOf(FilterRef.MEMBERSHIP, FilterRef.TREE))
        assertTrue(wire.keys == setOf("capability", "field", "id") || wire.keys == setOf("capability", "field", "id", "device"))
        assertTrue(wire.getValue("field").jsonPrimitive.content.isNotBlank())
        // An empty id stands for a whole device, which a per-device entry always names.
        assertTrue(wire.getValue("id").jsonPrimitive.content.isNotBlank() || wire["device"] != null)
    }
}
internal fun assertProviderWirePolicy(policy: SourceFilter) = policy.rules.flatMap { it.match }.forEach(::assertProviderWireRef)
/** Every choice belongs to the [field] asked for, and a person's addresses use the kinds that field accepts. */
internal fun assertProviderWireOptions(options: FilterOptions, field: FilterEditorField, sourceId: String): FilterOptions = options.also {
    assertEquals(sourceId, options.sourceId)
    assertEquals(field.field, options.field)
    it.items.forEach { item ->
        assertProviderWireRef(item.ref)
        assertEquals(field.field, item.ref.fieldPath)
        if (item.ref.isPerson) assertTrue("Person identifiers must use the field's vocabulary",
            item.ref.identifiers.orEmpty().all { identifier -> identifier.type in field.identifiers.orEmpty() })
        else assertEquals(field.capability, item.ref.capability)
    }
}
internal fun assertProviderWireWrite(rules: List<AccessGrantRule>) {
    val body = AccessLevelCreateBody("Fixture contract", rules)
    val encoded = OmnesisJson.parseToJsonElement(OmnesisJson.encodeToString(body)).jsonObject
    encoded.getValue("rules").jsonArray.forEach { grant ->
        grant.jsonObject["scopePolicies"]?.jsonArray.orEmpty().forEach { policy ->
            policy.jsonObject.getValue("rules").jsonArray.forEach { rule ->
                rule.jsonObject.getValue("match").jsonArray.forEach { ref ->
                    assertProviderWireRef(OmnesisJson.decodeFromJsonElement<FilterRef>(ref))
                }
            }
        }
    }
}
class ProviderFilterFixtureContractTest {
    @Test fun publicScreenshotWriteAndEveryFixtureFieldUseStrictWireEntries() = runBlocking {
        val fixture = AccessLevelScreenshotTest
        assertProviderWireWrite(fixture.level.rules)
        fixture.refs.forEach(::assertProviderWireRef)
        fixture.overview.sources.forEach { source ->
            val editor = fixture.gateway.editor(source.id)
            editor.fields.forEach { field ->
                val options = fixture.gateway.options(source.id, field.field, "", null, null, null)
                assertTrue("Every fixture field has a positive example", options.items.isNotEmpty())
                assertProviderWireOptions(options, field, source.id)
            }
        }
    }
    @Test fun aValidWireEntryStillMustBelongToTheFieldItWasListedFor() = runBlocking<Unit> {
        val fixture = AccessLevelScreenshotTest
        val phones = fixture.gateway.options(fixture.source.id, FilterRef.PEOPLE_FIELD, "", null, null, null)
        val mailPeople = fixture.gateway.editor(fixture.gmailSource.id).field(FilterRef.PEOPLE_FIELD)!!
        assertThrows(AssertionError::class.java) { assertProviderWireOptions(phones.copy(sourceId = fixture.gmailSource.id), mailPeople, fixture.gmailSource.id) }
        val folders = fixture.gateway.options(fixture.driveSource.id, AccessLevelScreenshotTest.DRIVE_FOLDERS, "", null, null, null)
        val labels = fixture.gateway.editor(fixture.gmailSource.id).field(AccessLevelScreenshotTest.GMAIL_LABELS)!!
        assertThrows(AssertionError::class.java) { assertProviderWireOptions(folders.copy(sourceId = fixture.gmailSource.id), labels, fixture.gmailSource.id) }
    }
    @Test fun fakeWritesRejectNamesOnListedEntriesAndUncapturedPeople() {
        assertThrows(AssertionError::class.java) { assertProviderWireRef(FilterRef.item(FilterRef.TREE, "extra.folderId", "workspace").copy(label = "Workspace")) }
        assertThrows(AssertionError::class.java) { assertProviderWireRef(FilterRef(FilterRef.PERSON, label = "Reader")) }
        assertThrows(AssertionError::class.java) { assertProviderWireRef(FilterRef.item(FilterRef.TREE, "extra.projectDir", "")) }
        assertProviderWireRef(FilterRef.item(FilterRef.TREE, "extra.projectDir", "", device = "dev_studio"))
        assertProviderWireRef(FilterRef.person("Reader", listOf(FilterIdentifier("email", "reader@example.org"))))
    }
}
