// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import android.provider.CallLog
import java.time.LocalDate
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Tests for [CallLogNormalizer]. Runs under Robolectric — not for a
 * ContentResolver (this class never touches one), but because
 * `normalizedPhone` calls the real `android.telephony.PhoneNumberUtils`
 * framework API, which plain JVM unit tests stub to defaults.
 */
@RunWith(RobolectricTestRunner::class)
class CallLogNormalizerTest {

    private fun row(
        id: Long = 1,
        number: String? = "+14155552671",
        cachedName: String? = null,
        dateMillis: Long = 1_759_400_000_000L,
        durationSeconds: Long = 0,
        type: Int = CallLog.Calls.INCOMING_TYPE,
        countryIso: String? = "US",
        features: Int = 0,
        missedReason: Int? = null,
        numberPresentation: Int = CallLog.Calls.PRESENTATION_ALLOWED,
    ) = RawCallRow(id, number, cachedName, dateMillis, durationSeconds, type, countryIso, features, missedReason, numberPresentation)

    @Test
    fun `outgoing type is the only outgoing direction`() {
        assertTrue(CallLogNormalizer.isOutgoing(row(type = CallLog.Calls.OUTGOING_TYPE)))
        for (t in listOf(CallLog.Calls.INCOMING_TYPE, CallLog.Calls.MISSED_TYPE, CallLog.Calls.REJECTED_TYPE, CallLog.Calls.BLOCKED_TYPE)) {
            assertFalse(CallLogNormalizer.isOutgoing(row(type = t)))
        }
    }

    @Test
    fun `only incoming and outgoing types are connected`() {
        assertTrue(CallLogNormalizer.isConnected(row(type = CallLog.Calls.INCOMING_TYPE)))
        assertTrue(CallLogNormalizer.isConnected(row(type = CallLog.Calls.OUTGOING_TYPE)))
        for (t in listOf(CallLog.Calls.MISSED_TYPE, CallLog.Calls.REJECTED_TYPE, CallLog.Calls.BLOCKED_TYPE, CallLog.Calls.VOICEMAIL_TYPE)) {
            assertFalse("type $t should not be connected", CallLogNormalizer.isConnected(row(type = t)))
        }
    }

    @Test
    fun `callTypeLabel maps every known CallLog type`() {
        assertEquals("incoming", CallLogNormalizer.callTypeLabel(row(type = CallLog.Calls.INCOMING_TYPE)))
        assertEquals("outgoing", CallLogNormalizer.callTypeLabel(row(type = CallLog.Calls.OUTGOING_TYPE)))
        assertEquals("missed", CallLogNormalizer.callTypeLabel(row(type = CallLog.Calls.MISSED_TYPE)))
        assertEquals("voicemail", CallLogNormalizer.callTypeLabel(row(type = CallLog.Calls.VOICEMAIL_TYPE)))
        assertEquals("rejected", CallLogNormalizer.callTypeLabel(row(type = CallLog.Calls.REJECTED_TYPE)))
        assertEquals("blocked", CallLogNormalizer.callTypeLabel(row(type = CallLog.Calls.BLOCKED_TYPE)))
        assertEquals(
            "answered_externally",
            CallLogNormalizer.callTypeLabel(row(type = CallLog.Calls.ANSWERED_EXTERNALLY_TYPE)),
        )
    }

    @Test
    fun `medium reads the FEATURES_VIDEO bit`() {
        assertEquals("voice", CallLogNormalizer.medium(row(features = 0)))
        assertEquals("video", CallLogNormalizer.medium(row(features = CallLog.Calls.FEATURES_VIDEO)))
    }

    @Test
    fun `normalizedPhone formats to E164 given a country ISO`() {
        val phone = CallLogNormalizer.normalizedPhone(row(number = "(415) 555-2671", countryIso = "US"))
        assertEquals("+14155552671", phone)
    }

    @Test
    fun `normalizedPhone falls back to the raw number without a country ISO`() {
        val phone = CallLogNormalizer.normalizedPhone(row(number = "+14155552671", countryIso = null))
        assertEquals("+14155552671", phone)
    }

    @Test
    fun `normalizedPhone is null for a blank or missing number`() {
        assertNull(CallLogNormalizer.normalizedPhone(row(number = null)))
        assertNull(CallLogNormalizer.normalizedPhone(row(number = "  ")))
    }

    @Test
    fun `normalizedPhone is null for a withheld or unknown number even when NUMBER holds a placeholder`() {
        // The provider can still populate NUMBER with a non-phone placeholder
        // ("-1", "-2", ...) for these cases — normalizedPhone must not treat
        // it as a real, dialable number regardless.
        for (presentation in listOf(
            CallLog.Calls.PRESENTATION_RESTRICTED,
            CallLog.Calls.PRESENTATION_PAYPHONE,
            CallLog.Calls.PRESENTATION_UNKNOWN,
        )) {
            assertNull(
                "presentation $presentation",
                CallLogNormalizer.normalizedPhone(row(number = "-1", numberPresentation = presentation)),
            )
        }
    }

    @Test
    fun `peerLabel and peerMention never leak a withheld number as an identity`() {
        val restricted = row(number = "-1", cachedName = null, numberPresentation = CallLog.Calls.PRESENTATION_RESTRICTED)
        assertEquals("Private number", CallLogNormalizer.peerLabel(restricted))
        assertNull(CallLogNormalizer.peerMention(restricted))

        val payphone = row(number = "-2", cachedName = null, numberPresentation = CallLog.Calls.PRESENTATION_PAYPHONE)
        assertEquals("Payphone", CallLogNormalizer.peerLabel(payphone))
        assertNull(CallLogNormalizer.peerMention(payphone))
    }

    @Test
    fun `analyticsRow counterparty is a presentation label, not the raw placeholder, for a withheld number`() {
        val withheldRow = row(number = "-1", numberPresentation = CallLog.Calls.PRESENTATION_RESTRICTED)
        val analyticsRow = CallLogNormalizer.analyticsRow(withheldRow)
        assertEquals("Private number", analyticsRow["counterparty"]?.jsonPrimitive?.content)
    }

    @Test
    fun `analyticsRow carries the missed reason only for missed calls`() {
        val missed = CallLogNormalizer.analyticsRow(row(type = CallLog.Calls.MISSED_TYPE, missedReason = 65536))
        assertEquals(65536, missed["missed_reason"]?.jsonPrimitive?.content?.toInt())

        val answered = CallLogNormalizer.analyticsRow(row(type = CallLog.Calls.INCOMING_TYPE, missedReason = null))
        assertTrue(answered["missed_reason"].toString().contains("null"))
    }

    @Test
    fun `analyticsRow direction reflects outgoing vs every other type`() {
        val outgoing = CallLogNormalizer.analyticsRow(row(type = CallLog.Calls.OUTGOING_TYPE))
        assertEquals("outgoing", outgoing["direction"]?.jsonPrimitive?.content)

        val missed = CallLogNormalizer.analyticsRow(row(type = CallLog.Calls.MISSED_TYPE))
        assertEquals("incoming", missed["direction"]?.jsonPrimitive?.content)
    }

    @Test
    fun `buildDayDocument aggregates every call for the day with a self participant`() {
        val rows = listOf(
            row(id = 1, number = "+14155552671", cachedName = "Maya Reeves", type = CallLog.Calls.INCOMING_TYPE, durationSeconds = 120),
            row(id = 2, number = "+442071234567", cachedName = null, type = CallLog.Calls.MISSED_TYPE, durationSeconds = 0, countryIso = "GB"),
        )
        val doc = CallLogNormalizer.buildDayDocument(rows, LocalDate.parse("2026-03-04"), "android", "android-call-log:local")

        assertEquals("call-log:2026-03-04", doc.externalId)
        assertEquals("Calls — 2026-03-04", doc.title)
        assertEquals("call-log", doc.metadata.documentType)
        assertEquals(true, doc.metadata.rollingAggregate)
        assertTrue(doc.content.contains("**Total:** 2 calls, 2m"))
        assertTrue(doc.content.contains("Maya Reeves"))

        val people = doc.metadata.people!!
        assertEquals(1, people.count { it.isSelf == true })
        // 3 total: the self mention plus one per distinct peer — all share role "participant".
        assertEquals(3, people.count { it.role == "participant" })
        assertEquals(2, people.count { it.isSelf != true })
    }

    @Test
    fun `buildDayDocument is deterministic (idempotent re-sync contract)`() {
        val rows = listOf(row(id = 1, type = CallLog.Calls.OUTGOING_TYPE, durationSeconds = 42))
        val date = LocalDate.parse("2026-01-15")
        val first = CallLogNormalizer.buildDayDocument(rows, date, "android", "android-call-log:local")
        val second = CallLogNormalizer.buildDayDocument(rows, date, "android", "android-call-log:local")
        assertEquals(first.contentHash, second.contentHash)
    }
}
