// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import dev.omnesis.android.transport.dto.SourceRecord
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlinx.coroutines.runBlocking

class MobileSourceActivationTest {
    private val thisPhone = "11111111-1111-4111-8111-111111111111"
    private val otherPhone = "22222222-2222-4222-8222-222222222222"

    @Test
    fun `new source and existing membership need no choice`() {
        assertEquals(ActivationPlan.Ready, MobileSourceActivation.plan(null, thisPhone, SourceMultiDeviceMode.REPLICATED))
        assertEquals(
            ActivationPlan.Ready,
            MobileSourceActivation.plan(source("replicated", listOf(otherPhone, thisPhone)), thisPhone, SourceMultiDeviceMode.REPLICATED),
        )
    }

    @Test
    fun `legacy exclusive replicated source offers all three choices`() {
        assertEquals(
            ActivationPlan.Choose(SourceMultiDeviceMode.REPLICATED),
            MobileSourceActivation.plan(source("exclusive"), thisPhone, SourceMultiDeviceMode.REPLICATED),
        )
    }

    @Test
    fun `partitioned source adds an independent device stream`() {
        assertEquals(
            ActivationPlan.AddPartition,
            MobileSourceActivation.plan(source("exclusive"), thisPhone, SourceMultiDeviceMode.PARTITIONED),
        )
        assertEquals(
            ActivationPlan.Join,
            MobileSourceActivation.plan(source("partitioned"), thisPhone, SourceMultiDeviceMode.PARTITIONED),
        )
    }

    @Test
    fun `an existing owner explicitly upgrades a newly partitioned contract`() = runBlocking {
        val calls = mutableListOf<String>()
        val outcome = MobileSourceActivation.execute(
            source("exclusive", listOf(thisPhone)), thisPhone, SourceMultiDeviceMode.PARTITIONED,
            operations = ActivationOperations(
                setMode = { _, mode -> calls += "mode:${mode.wireValue}" },
                join = { _, device -> calls += "join:$device" },
                transfer = { _, _ -> calls += "transfer" },
            ),
        )
        assertEquals(ActivationOutcome.Ready, outcome)
        assertEquals(listOf("mode:partitioned", "join:$thisPhone"), calls)
    }

    @Test
    fun `an existing member cannot sync a partition contract into replicated storage`() {
        assertEquals(
            ActivationPlan.Incompatible(SourceMultiDeviceMode.REPLICATED, SourceMultiDeviceMode.PARTITIONED),
            MobileSourceActivation.plan(source("replicated", listOf(thisPhone)), thisPhone, SourceMultiDeviceMode.PARTITIONED),
        )
    }

    @Test
    fun `background partition preparation upgrades only an existing owner without joining`() = runBlocking {
        val calls = mutableListOf<String>()
        MobileSourceActivation.prepareHostedPartition(source("exclusive", listOf(thisPhone)), thisPhone) { id, mode ->
            calls += "$id:${mode.wireValue}"
        }
        assertEquals(listOf("fictional-mobile:local:partitioned"), calls)
        calls.clear()
        MobileSourceActivation.prepareHostedPartition(source("partitioned", listOf(thisPhone)), thisPhone) { _, _ ->
            calls += "unexpected mutation"
        }
        assertEquals(emptyList<String>(), calls)
    }

    @Test
    fun `background partition preparation refuses missing membership and incompatible storage`() = runBlocking {
        val calls = mutableListOf<String>()
        val candidates = listOf(null, source("partitioned"), source("replicated", listOf(thisPhone)))
        for (candidate in candidates) {
            var failed = false
            try {
                MobileSourceActivation.prepareHostedPartition(candidate, thisPhone) { _, _ -> calls += "mutation" }
            } catch (_: IllegalStateException) { failed = true }
            assertEquals("must refuse $candidate", true, failed)
        }
        assertEquals(emptyList<String>(), calls)
    }

    @Test
    fun `exclusive source offers keep or transfer only`() {
        assertEquals(
            ActivationPlan.Choose(SourceMultiDeviceMode.EXCLUSIVE),
            MobileSourceActivation.plan(source("exclusive"), thisPhone, SourceMultiDeviceMode.EXCLUSIVE),
        )
    }

    @Test
    fun `existing nonexclusive mode mismatch is incompatible`() {
        assertEquals(
            ActivationPlan.Incompatible(SourceMultiDeviceMode.PARTITIONED, SourceMultiDeviceMode.REPLICATED),
            MobileSourceActivation.plan(source("partitioned"), thisPhone, SourceMultiDeviceMode.REPLICATED),
        )
    }

    @Test
    fun `contract refusal identifies the device that must update`() {
        val refusal = GatewayException.ServerError(
            status = 409,
            body = "device \"Kitchen Tablet\" does not support the partitioned contract; update the device",
            code = "MULTI_DEVICE_CONTRACT_UNSUPPORTED",
        )

        assertEquals(
            "Device \"Kitchen Tablet\" does not support the partitioned contract; update the device",
            activationFailureMessage(refusal, "The gateway could not prepare this phone."),
        )
    }

    @Test
    fun `ordinary activation failure keeps the caller's actionable fallback`() {
        assertEquals(
            "The gateway could not prepare this phone. Check the connection and try again.",
            activationFailureMessage(
                GatewayException.Network(java.io.IOException("offline")),
                "The gateway could not prepare this phone. Check the connection and try again.",
            ),
        )
    }

    @Test
    fun `use both transitions before joining`() = runBlocking {
        val calls = mutableListOf<String>()
        val outcome = MobileSourceActivation.execute(
            source("exclusive"),
            thisPhone,
            SourceMultiDeviceMode.REPLICATED,
            ActivationChoice.USE_BOTH,
            ActivationOperations(
                setMode = { _, mode -> calls += "mode:${mode.wireValue}" },
                join = { _, _ -> calls += "join" },
                transfer = { _, _ -> calls += "transfer" },
            ),
        )
        assertEquals(ActivationOutcome.Ready, outcome)
        assertEquals(listOf("mode:replicated", "join"), calls)
    }

    @Test
    fun `transfer and keep other are mutually exclusive`() = runBlocking {
        val transferCalls = mutableListOf<String>()
        assertEquals(
            ActivationOutcome.Ready,
            MobileSourceActivation.execute(
                source("exclusive"), thisPhone, SourceMultiDeviceMode.REPLICATED,
                ActivationChoice.TAKE_OVER,
                operations(transferCalls),
            ),
        )
        assertEquals(listOf("transfer"), transferCalls)

        val keepCalls = mutableListOf<String>()
        assertEquals(
            ActivationOutcome.KeptOther,
            MobileSourceActivation.execute(
                source("exclusive"), thisPhone, SourceMultiDeviceMode.REPLICATED,
                ActivationChoice.KEEP_OTHER,
                operations(keepCalls),
            ),
        )
        assertEquals(emptyList<String>(), keepCalls)
    }

    private fun operations(calls: MutableList<String>) = ActivationOperations(
        setMode = { _, _ -> calls += "mode" },
        join = { _, _ -> calls += "join" },
        transfer = { _, _ -> calls += "transfer" },
    )

    private fun source(mode: String, members: List<String> = listOf(otherPhone)) = SourceRecord(
        id = "fictional-mobile:local",
        type = "fictional-mobile",
        accountId = "local",
        deviceId = otherPhone,
        members = members,
        multiDeviceMode = mode,
    )
}
