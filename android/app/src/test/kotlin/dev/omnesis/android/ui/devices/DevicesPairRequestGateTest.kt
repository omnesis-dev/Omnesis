// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.devices

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DevicesPairRequestGateTest {
    @Test
    fun aLateSheetResponseCannotCrossIntoANewerRepair() {
        val gate = DevicesPairRequestGate()
        val first = gate.beginSheet()
        val second = gate.beginSheet()

        assertFalse(gate.ownsSheet(first))
        assertTrue(gate.ownsSheet(second))
    }

    @Test
    fun onlyTheLatestQrForTheCurrentSheetCanRender() {
        val gate = DevicesPairRequestGate()
        val sheet = gate.beginSheet()
        val firstQr = gate.beginQr()
        val secondQr = gate.beginQr()

        assertFalse(gate.ownsQr(sheet, firstQr))
        assertTrue(gate.ownsQr(sheet, secondQr))
        gate.closeSheet()
        assertFalse(gate.ownsQr(sheet, secondQr))
    }
}
