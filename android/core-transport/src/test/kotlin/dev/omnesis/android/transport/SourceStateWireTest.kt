// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.transport

import dev.omnesis.android.transport.dto.FailureScope
import dev.omnesis.android.transport.dto.HistoryCoverage
import dev.omnesis.android.transport.dto.QuotaKind
import dev.omnesis.android.transport.dto.StateEnvelope
import dev.omnesis.android.transport.dto.AnalyticsIngestBody
import dev.omnesis.android.transport.dto.IngestDocumentsBody
import dev.omnesis.android.transport.dto.OmnesisJson
import dev.omnesis.android.transport.dto.FallbackNoticeTitles
import dev.omnesis.android.transport.dto.NoticeLevel
import dev.omnesis.android.transport.dto.SourceNotice
import dev.omnesis.android.transport.dto.SourceSyncStatus
import dev.omnesis.android.transport.dto.SyncStateBody
import dev.omnesis.android.transport.dto.QuotaBucket
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * This decoder against the same bytes TypeScript writes.
 *
 * The fixtures under `wire-fixtures/` are generated from the contract's own
 * definitions and checked in, precisely so this suite does not restate them.
 * Restating them is the failure mode: a decoder tested against its own idea of
 * the wire passes forever while the wire moves.
 */
class SourceStateWireTest {

    private val json = OmnesisJson

    /**
     * Read a fixture from the test classpath.
     *
     * The corpus is generated into this module's test resources rather than
     * read from the repository root: the native dispatcher rsyncs `android/`
     * alone, so anything above it does not exist on the build host at all.
     */
    private fun fixture(name: String): String {
        val stream = javaClass.getResourceAsStream("/wire-fixtures/$name.json")
        assertNotNull("missing wire-fixtures/$name.json — run `npm run wire-fixtures`", stream)
        return stream!!.bufferedReader().use { it.readText() }
    }

    @Test
    fun `source status keeps supported progress when newer warning fields arrive`() {
        val status = json.decodeFromString<SourceSyncStatus>(fixture("sync-status-partial-warning"))
        assertEquals("fixture:workspace:demo", status.sourceId)
        assertEquals("completed", status.state)
        assertEquals("incremental", status.progress?.phase)
        assertEquals(40, status.progress?.processed)
        // This DTO does not yet render coverage or issues. Tolerating them is
        // compatibility, not evidence that the Android UI displays warnings.
        assertNull(status.errorMessage)
    }

    @Test
    fun `notices decode per member and the aggregate of a shared source carries none`() {
        val status = json.decodeFromString<SourceSyncStatus>(fixture("sync-status-notices-members"))
        assertNull(status.notices)
        assertEquals(emptyList<SourceNotice>(), status.displayNotices)

        val a = status.forDevice("fixture-device-a")!!
        assertEquals(listOf("Only recent history is reachable"), a.displayNotices.map { it.title })
        assertEquals(NoticeLevel.INFO, a.displayNotices.single().level)

        val b = status.forDevice("fixture-device-b")!!.displayNotices
        assertEquals(3, b.size)
        val failed = b[0]
        assertEquals("error", failed.kind)
        assertEquals(NoticeLevel.ERROR, failed.level)
        assertEquals("Connection refused", failed.detail)
        assertEquals(listOf("Check the network connection.", "Sync again."), failed.steps)
        assertEquals("2030-01-01T00:00:00.000Z", failed.since)
        // A kind and severity from a newer gateway still decode; the severity reads as a warning.
        assertEquals("fixture-future-kind", b[2].kind)
        assertEquals(NoticeLevel.WARNING, b[2].level)
    }

    @Test
    fun `a status without notices decodes to none when nothing failed`() {
        val status = json.decodeFromString<SourceSyncStatus>(fixture("sync-status-partial-warning"))
        assertNull(status.notices)
        // Issues and coverage are the gateway's to word; the client derives nothing from them.
        assertEquals(emptyList<SourceNotice>(), status.displayNotices)
    }

    private fun status(body: String) = json.decodeFromString<SourceSyncStatus>(body)

    @Test
    fun `one malformed notice is skipped and the rest of the status survives`() {
        val s = status(
            """{"sourceId":"fixture:local","state":"completed","lastSyncAt":"2030-01-01T00:00:00.000Z",
               "notices":[{"kind":"sync-issue","severity":"warning","title":"One folder could not be read","steps":["Check access.",null]},
                          {"kind":"sync-issue","severity":"warning"},
                          {"kind":"sync-issue","severity":"warning","title":null},
                          {"kind":"sync-issue","severity":"warning","title":"   "},
                          "not a notice"]}""",
        )
        assertEquals("2030-01-01T00:00:00.000Z", s.lastSyncAt)
        val notice = s.displayNotices.single()
        assertEquals("One folder could not be read", notice.title)
        assertEquals(listOf("Check access."), notice.steps)
    }

    @Test
    fun `an older gateway's needs-auth reads as needs sign-in`() {
        val n = status("""{"sourceId":"f","state":"needs-auth","errorMessage":"needs reauth: token revoked"}""").displayNotices.single()
        assertEquals(FallbackNoticeTitles.NEEDS_AUTH, n.title)
        assertEquals("token revoked", n.detail)
        assertEquals(NoticeLevel.ERROR, n.level)
    }

    @Test
    fun `an older gateway's rate limit reads as an info pause`() {
        val n = status("""{"sourceId":"f","state":"rate-limited","errorMessage":"rate-limited: retry in 5m"}""").displayNotices.single()
        assertEquals(FallbackNoticeTitles.RATE_LIMITED, n.title)
        assertEquals("retry in 5m", n.detail)
        assertEquals(NoticeLevel.INFO, n.level)
    }

    @Test
    fun `an older gateway's error reads as the last sync failed`() {
        val n = status("""{"sourceId":"f","state":"error","errorMessage":"Disk unavailable"}""").displayNotices.single()
        assertEquals(FallbackNoticeTitles.ERROR, n.title)
        assertEquals("Disk unavailable", n.detail)
        assertEquals(NoticeLevel.ERROR, n.level)
    }

    @Test
    fun `an older gateway's stale hint reads as no new data`() {
        val n = status("""{"sourceId":"f","state":"stale","staleHint":"Open the app."}""").displayNotices.single()
        assertEquals(FallbackNoticeTitles.STALE, n.title)
        assertEquals("Open the app.", n.detail)
        assertEquals(NoticeLevel.WARNING, n.level)
        assertEquals(emptyList<SourceNotice>(), status("""{"sourceId":"f","state":"stale"}""").displayNotices)
    }

    @Test
    fun `an older gateway's expiring consent names the date`() {
        val n = status("""{"sourceId":"f","state":"auth-expiring","consentExpiresAt":"2026-07-15T12:00:00Z"}""").displayNotices.single()
        assertEquals("Connection expires on Jul 15, 2026", n.title)
        assertEquals(NoticeLevel.WARNING, n.level)
        assertEquals(emptyList<SourceNotice>(), status("""{"sourceId":"f","state":"auth-expiring"}""").displayNotices)
    }

    @Test
    fun `a healthy older status has no fallback notice even with a leftover message`() {
        assertEquals(
            emptyList<SourceNotice>(),
            status("""{"sourceId":"f","state":"synced","errorMessage":"old failure"}""").displayNotices,
        )
    }

    @Test
    fun `an explicit empty notice list is not second-guessed from the error message`() {
        val status = json.decodeFromString<SourceSyncStatus>(
            """{"sourceId":"fixture:local","state":"error","errorMessage":"Disk unavailable","notices":[]}""",
        )
        assertEquals(emptyList<SourceNotice>(), status.displayNotices)
    }

    @Test
    fun `an older gateway's shared source falls back per member`() {
        val status = json.decodeFromString<SourceSyncStatus>(
            """{"sourceId":"fixture:local","state":"error","errorMessage":"One device failed",
               "members":[{"sourceId":"fixture:local","deviceId":"a","state":"error","errorMessage":"Disk unavailable"},
                          {"sourceId":"fixture:local","deviceId":"b","state":"completed"}]}""",
        )
        assertEquals(emptyList<SourceNotice>(), status.displayNotices)
        assertEquals("Disk unavailable", status.forDevice("a")!!.displayNotices.single().detail)
        assertEquals(emptyList<SourceNotice>(), status.forDevice("b")!!.displayNotices)
    }

    @Test
    fun `sync-state family decodes without guessing identity from an account extension`() {
        val body = json.decodeFromString<SyncStateBody>(fixture("source-account-family"))
        assertEquals(JsonObject(emptyMap()), body.cursor)
        assertEquals("Fixture source", body.family?.label)
        assertEquals("folder", body.family?.icon)
        assertNull(body.label)
        // Account/tenant metadata and family colors are forward extensions to
        // this phone's write DTO, not fields it promises to round-trip.
    }

    @Test
    fun `document decoder accepts partition extensions without losing document fields`() {
        val body = json.decodeFromString<IngestDocumentsBody>(fixture("documents-partition-claims"))
        val document = body.documents.single()
        assertEquals("fixture:workspace:demo", document.sourceId)
        assertEquals("note-1", document.externalId)
        assertEquals("Fixture note", document.title)
        assertEquals("Fictional content", document.content)
        assertEquals("fixture-hash", document.contentHash)
        assertEquals("2030-01-01T00:00:00.000Z", document.sourceUpdatedAt)
        // Mobile sends member-scoped snapshots, not collector partition claims;
        // this test only pins compatibility of the supported document subset.
    }

    @Test
    fun `analytics decoder does not reinterpret typed tuple keys as legacy string ids`() {
        val body = json.decodeFromString<AnalyticsIngestBody>(fixture("analytics-tuple-keys"))
        assertEquals("fixture:workspace:demo", body.sourceId)
        assertEquals("fixture_rows", body.tableName)
        assertEquals(emptyList<Map<String, kotlinx.serialization.json.JsonElement>>(), body.records)
        assertNull(body.deletedIds)
        assertNull(body.deleteKeyColumn)
        // Typed tuple keys are not emitted by this mobile DTO. Ignoring them
        // must not silently coerce composite booleans/numbers into string IDs.
    }

    @Test
    fun `an envelope at the current version decodes with its state intact`() {
        val envelope = json.decodeFromString<StateEnvelope>(fixture("state-envelope-current"))
        assertEquals(1, envelope.envelope)
        assertEquals(2, envelope.version)
        assertEquals("things:local", envelope.sourceId)
        assertEquals("12", envelope.state["offset"]?.jsonPrimitive?.content)
    }

    @Test
    fun `a minor version is read without disturbing the state`() {
        // A decoder that did not know `m` would either fail or drop the
        // envelope; it must do neither, because a minor bump is by definition
        // one an older reader is meant to tolerate.
        val envelope = json.decodeFromString<StateEnvelope>(fixture("state-envelope-with-minor"))
        assertEquals(3, envelope.minorVersion)
        assertEquals("12", envelope.state["offset"]?.jsonPrimitive?.content)
    }

    @Test
    fun `an envelope from a newer build is legible enough to be refused`() {
        // The point is not that this build understands the state — it cannot —
        // but that it can read the version and know to leave the value alone.
        // Discarding it would overwrite a bookmark the newer build still uses.
        val envelope = json.decodeFromString<StateEnvelope>(fixture("state-envelope-from-newer-build"))
        assertEquals(99, envelope.version)
    }

    @Test
    fun `a pre-envelope cursor is not an envelope`() {
        // Legacy values carry no `e`, and telling them apart from an envelope
        // is what stops one being migrated twice or read as corrupt.
        val raw = json.decodeFromString<JsonObject>(fixture("state-legacy-raw"))
        assertNull(raw["e"])
        assertNotNull(raw["offset"])
    }

    @Test
    fun `every failure scope on the wire has a name here`() {
        assertEquals(FailureScope.ITEM, scopeOf(fixture("failure-item")))
        assertEquals(FailureScope.CONNECTION, scopeOf(fixture("failure-connection")))
        assertEquals(FailureScope.SOURCE, scopeOf(fixture("failure-rate-limit-app-quota")))
    }

    @Test
    fun `an application quota is distinguishable from an account one`() {
        // Backing off one account against an application-wide limit spends the
        // same budget from another direction, so this distinction has to
        // survive the wire.
        val body = json.decodeFromString<JsonObject>(fixture("failure-rate-limit-app-quota"))
        val quota = body["quota"] as JsonObject
        val decoded = json.decodeFromString<QuotaBucket>(quota.toString())
        assertEquals(QuotaKind.APP, decoded.kind)
        assertEquals(
            QuotaKind.APP,
            json.decodeFromString<QuotaKind>("\"${quota["kind"]!!.jsonPrimitive.content}\""),
        )
    }

    @Test
    fun `a limit that names no budget says so by omission`() {
        val body = json.decodeFromString<JsonObject>(fixture("failure-rate-limit-unattributed"))
        assertNull("an absent quota must stay absent, not become a default", body["quota"])
    }

    @Test
    fun `unknown coverage is its own answer, and absent is a fourth`() {
        assertEquals(HistoryCoverage.COMPLETE, coverageOf(fixture("coverage-complete")))
        assertEquals(HistoryCoverage.PARTIAL, coverageOf(fixture("coverage-partial")))
        assertEquals(HistoryCoverage.UNKNOWN, coverageOf(fixture("coverage-unknown")))
        // Absent is not `unknown` and not `complete`: the question does not
        // apply to that source, and a client shows nothing rather than a
        // warning.
        assertNull(
            (json.decodeFromString<JsonObject>(fixture("coverage-absent")))["coverage"],
        )
    }

    private fun scopeOf(body: String): FailureScope {
        val obj = json.decodeFromString<JsonObject>(body)
        return json.decodeFromString<FailureScope>("\"${obj["scope"]!!.jsonPrimitive.content}\"")
    }

    private fun coverageOf(body: String): HistoryCoverage {
        val obj = json.decodeFromString<JsonObject>(body)
        return json.decodeFromString<HistoryCoverage>("\"${obj["coverage"]!!.jsonPrimitive.content}\"")
    }
}
