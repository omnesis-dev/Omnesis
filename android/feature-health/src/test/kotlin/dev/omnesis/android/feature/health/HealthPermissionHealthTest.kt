// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.health

import androidx.health.connect.client.permission.HealthPermission
import dev.omnesis.android.feature.health.di.HealthConnectAvailability
import dev.omnesis.android.transport.PermissionCapabilityState
import dev.omnesis.android.transport.PermissionHealthSnapshot
import dev.omnesis.android.transport.PermissionRepairAction
import dev.omnesis.android.transport.dto.OmnesisJson
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

class HealthPermissionHealthTest {
    @Test fun separates_type_background_and_history_semantics() {
        val snapshot = healthPermissionSnapshot(
            nowMillis = 1,
            availability = HealthConnectAvailability.Available,
            enabledTypePermissions = setOf("type-a", "type-b"),
            granted = setOf("type-a"),
            backgroundSupported = true,
            historySupported = true,
        )
        assertEquals(
            listOf(
                PermissionCapabilityState.PERMISSION_DEGRADED,
                PermissionCapabilityState.BACKGROUND_ACCESS_MISSING,
                PermissionCapabilityState.PERMISSION_DEGRADED,
            ),
            snapshot.capabilities.map { it.state },
        )
    }

    @Test fun all_expected_grants_are_healthy() {
        val snapshot = healthPermissionSnapshot(
            nowMillis = 1,
            availability = HealthConnectAvailability.Available,
            enabledTypePermissions = setOf("type-a"),
            granted = setOf(
                "type-a",
                HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND,
                HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY,
            ),
            backgroundSupported = true,
            historySupported = true,
        )
        assertEquals(List(3) { PermissionCapabilityState.HEALTHY }, snapshot.capabilities.map { it.state })
    }

    @Test fun missing_provider_is_unavailable_without_claiming_permission_denial() {
        val snapshot = healthPermissionSnapshot(1, HealthConnectAvailability.NotInstalled, emptySet(), emptySet(), false, false)
        assertEquals(PermissionCapabilityState.UNAVAILABLE, snapshot.capabilities.single().state)
    }

    @Test fun unsupported_provider_emits_schema_complete_non_actionable_wire_payload() {
        val snapshot = healthPermissionSnapshot(
            1, HealthConnectAvailability.NotSupported, emptySet(), emptySet(), false, false,
        )
        val capability = snapshot.capabilities.single()
        assertEquals(PermissionCapabilityState.UNAVAILABLE, capability.state)
        assertEquals(PermissionRepairAction.NONE, capability.repairAction)
        assertEquals("No settings change can enable Health Connect on this device.", capability.remediation)

        val wire = OmnesisJson.encodeToString(PermissionHealthSnapshot.serializer(), snapshot)
            .let(OmnesisJson::parseToJsonElement)
            .jsonObject["capabilities"]!!.jsonArray.single().jsonObject
        assertEquals("unavailable", wire["state"]!!.jsonPrimitive.content)
        assertEquals("Health records cannot sync on this device.", wire["impact"]!!.jsonPrimitive.content)
        assertEquals(
            "No settings change can enable Health Connect on this device.",
            wire["remediation"]!!.jsonPrimitive.content,
        )
        assertEquals("none", wire["repairAction"]!!.jsonPrimitive.content)
    }

    @Test fun unsupported_optional_features_are_omitted_instead_of_alerting() {
        val snapshot = healthPermissionSnapshot(
            1, HealthConnectAvailability.Available, setOf("type-a"), setOf("type-a"), false, false,
        )
        assertEquals(listOf("record-types"), snapshot.capabilities.map { it.id })
        assertEquals(PermissionCapabilityState.HEALTHY, snapshot.capabilities.single().state)
    }

    @Test fun optional_capabilities_are_irrelevant_when_every_category_is_disabled() {
        val snapshot = healthPermissionSnapshot(
            1, HealthConnectAvailability.Available, emptySet(), emptySet(), true, true,
        )
        assertEquals(listOf("record-types"), snapshot.capabilities.map { it.id })
    }
}
