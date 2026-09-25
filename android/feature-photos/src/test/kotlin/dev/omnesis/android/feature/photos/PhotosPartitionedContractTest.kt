// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.transport.ActivationOperations
import dev.omnesis.android.transport.ActivationOutcome
import dev.omnesis.android.transport.MobileSourceActivation
import dev.omnesis.android.transport.SourceMultiDeviceMode
import dev.omnesis.android.transport.dto.SourceRecord
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PhotosPartitionedContractTest {
    @Test
    fun `the Photos feature joins a separate partition without an ownership choice`() = runTest {
        val integration = PhotosIntegration(
            ApplicationProvider.getApplicationContext<Context>(), PhotosSettings(InMemoryKeyValueStore()),
        )
        assertEquals(SourceMultiDeviceMode.PARTITIONED, integration.hostedSourceContract.multiDeviceMode)
        val source = SourceRecord(
            id = "photos:local", type = "photos", accountId = "local",
            deviceId = "phone-one", members = listOf("phone-one"), multiDeviceMode = "partitioned",
        )
        val calls = mutableListOf<String>()
        val result = MobileSourceActivation.execute(
            source, "phone-two", integration.hostedSourceContract.multiDeviceMode,
            operations = ActivationOperations(
                setMode = { _, mode -> calls += "mode:${mode.wireValue}" },
                join = { _, device -> calls += "join:$device" },
                transfer = { _, device -> calls += "transfer:$device" },
            ),
        )
        assertEquals(ActivationOutcome.Ready, result)
        assertEquals(listOf("join:phone-two"), calls)
    }
}
