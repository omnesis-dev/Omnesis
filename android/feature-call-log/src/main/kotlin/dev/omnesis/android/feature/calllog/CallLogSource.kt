// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import android.content.ContentResolver
import android.database.Cursor
import android.os.Build
import android.provider.CallLog
import android.util.Log
import dev.omnesis.android.transport.dto.DocumentInputDto
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement

private const val TAG = "Omnesis:calllog"

/**
 * One sync pass' output: new analytics rows, rebuilt day documents, and the
 * full current external-id snapshot.
 *
 * `presentExternalIds` is null when this pass could not read the call log at
 * all. That is not the same as reading it and finding nothing: an empty list
 * is a claim that every day document the gateway holds has been deleted, and
 * the provider must not make that claim on the strength of a query it could
 * not run.
 */
data class CallLogSyncResult(
    val analyticsRows: List<Map<String, JsonElement>>,
    val documents: List<DocumentInputDto>,
    val presentExternalIds: List<String>?,
    val cursor: CallLogCursor,
)

/**
 * Reads Android's native `CallLog.Calls` and produces one `call-log` document
 * per calendar day (aggregating every call that day) alongside one
 * `android_call_log` analytics row per raw call — the Android analogue of
 * `apple-call-log`'s `AppleCallLogSource`.
 *
 * `ContentResolver.query` against `CallLog.Calls` doesn't support aggregate
 * projections (no `MAX()`/`COUNT()`), so this reads a bit differently from
 * the SQL-driven Apple source: there is no rebuild-guard against a cleared
 * call log — `_ID` is a real `AUTOINCREMENT` rowid (unlike Apple's `Z_PK`),
 * so deleting even a single recent call can drop the observed max id without
 * the table having been cleared, making an id-decrease an unreliable clear
 * signal. A genuine clear (or any deletion) is instead handled entirely by
 * the deletion snapshot: every sync pass emits the full current set of
 * distinct dates as `presentExternalIds`, and the gateway records whatever
 * day-documents are no longer backed by it as absent — removing them only once
 * several later snapshots have agreed and its deadline has passed. The deletion
 * snapshot re-derives every distinct calendar date from a single-column,
 * fully-iterated `DATE` query rather than a cheap signature-gated aggregate —
 * acceptable given a device's call history is orders of magnitude smaller
 * than the corpora the SQL-side pattern was built for.
 */
class CallLogSource(private val resolver: ContentResolver) {

    companion object {
        const val SOURCE_TYPE = "android-call-log"
        const val ACCOUNT_ID_LOCAL = "local"
        const val PROVIDER_ID = "android"

        private val PROJECTION_BASE = arrayOf(
            CallLog.Calls._ID,
            CallLog.Calls.NUMBER,
            CallLog.Calls.CACHED_NAME,
            CallLog.Calls.DATE,
            CallLog.Calls.DURATION,
            CallLog.Calls.TYPE,
            CallLog.Calls.COUNTRY_ISO,
            CallLog.Calls.FEATURES,
            CallLog.Calls.NUMBER_PRESENTATION,
        )

        // MISSED_REASON was added in API 31 — requesting it in the projection on
        // an older device throws (the column doesn't exist), so it's appended
        // only when the running OS supports it.
        private val PROJECTION = if (Build.VERSION.SDK_INT >= 31) {
            PROJECTION_BASE + CallLog.Calls.MISSED_REASON
        } else {
            PROJECTION_BASE
        }
    }

    suspend fun sync(cursor: CallLogCursor): CallLogSyncResult = withContext(Dispatchers.IO) {
        val newRows = queryNewRows(cursor)
        val affectedDates = newRows.map { CallLogNormalizer.callDate(it) }.toSet()
        val analyticsRows = newRows.map { CallLogNormalizer.analyticsRow(it) }

        val documents = affectedDates.map { date -> buildDayDocument(date) }
        if (documents.isNotEmpty()) {
            Log.i(TAG, "Rebuilt ${documents.size} call-log day document(s): ${affectedDates.joinToString(", ")}")
        }

        // A null result means the query itself did not run — a revoked
        // permission surfaces as an exception, but a provider that is simply
        // unavailable hands back no cursor at all, and that is indistinguishable
        // from an empty call log unless it is kept distinct here.
        val presentExternalIds = queryDistinctDates()
            ?.map { "call-log:${it.format(DateTimeFormatter.ISO_LOCAL_DATE)}" }
        if (presentExternalIds == null) {
            Log.w(TAG, "Call log could not be enumerated; withholding the snapshot so no day document is swept")
        }

        // newRows is already sorted (DATE ASC, _ID ASC), so its last element
        // carries the new date watermark. The id watermark tracks the MAX id
        // seen across ALL rows ever queried (not just this page) — see
        // queryNewRows's membership clause for why a plain "last row's id"
        // would silently miss a row with a lower date but a new, higher id.
        val newWatermark = newRows.lastOrNull()
        val maxIdSeen = newRows.maxOfOrNull { it.id } ?: cursor.insertIdHighWater
        val nextCursor = CallLogCursor(
            lastDateMillis = newWatermark?.dateMillis ?: cursor.lastDateMillis,
            lastId = newWatermark?.id ?: cursor.lastId,
            insertIdHighWater = maxOf(cursor.insertIdHighWater, maxIdSeen),
        )

        Log.i(TAG, "Sync produced ${analyticsRows.size} call rows, ${documents.size} day docs")

        CallLogSyncResult(
            analyticsRows = analyticsRows,
            documents = documents,
            presentExternalIds = presentExternalIds,
            cursor = nextCursor,
        )
    }

    /** Re-read every call for [date] (UTC) and rebuild that day's aggregate document. */
    private suspend fun buildDayDocument(date: LocalDate): DocumentInputDto {
        val dayStart = date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
        val dayEnd = date.plusDays(1).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli() - 1
        val rows = queryRange(dayStart, dayEnd)
        return CallLogNormalizer.buildDayDocument(
            rows = rows,
            date = date,
            providerId = PROVIDER_ID,
            sourceId = "$SOURCE_TYPE:$ACCOUNT_ID_LOCAL",
        )
    }

    // A row qualifies if its date has moved the watermark forward, if it's a
    // same-date tie-break, OR if its own _ID is newer than every id already
    // seen — this last clause is what catches a row whose DATE doesn't track
    // insertion order (a backfilled/imported call landing with an
    // older-than-watermark timestamp), mirroring apple-call-log's own
    // insertion high-water-mark membership clause.
    private suspend fun queryNewRows(cursor: CallLogCursor): List<RawCallRow> = query(
        selection = "(${CallLog.Calls.DATE} > ?) OR (${CallLog.Calls.DATE} = ? AND ${CallLog.Calls._ID} > ?) OR (${CallLog.Calls._ID} > ?)",
        selectionArgs = arrayOf(
            cursor.lastDateMillis.toString(),
            cursor.lastDateMillis.toString(),
            cursor.lastId.toString(),
            cursor.insertIdHighWater.toString(),
        ),
        sortOrder = "${CallLog.Calls.DATE} ASC, ${CallLog.Calls._ID} ASC",
    )

    private suspend fun queryRange(startMillis: Long, endMillis: Long): List<RawCallRow> = query(
        selection = "${CallLog.Calls.DATE} >= ? AND ${CallLog.Calls.DATE} <= ?",
        selectionArgs = arrayOf(startMillis.toString(), endMillis.toString()),
        sortOrder = "${CallLog.Calls.DATE} ASC",
    )

    /** Every distinct UTC calendar date currently present in the call log. */
    /** Every day the call log holds, or null when the query could not be run. */
    private suspend fun queryDistinctDates(): Set<LocalDate>? = withContext(Dispatchers.IO) {
        val dates = mutableSetOf<LocalDate>()
        val cursor = resolver.query(CallLog.Calls.CONTENT_URI, arrayOf(CallLog.Calls.DATE), null, null, null)
            ?: return@withContext null
        cursor.use { c ->
            val dateIdx = c.getColumnIndexOrThrow(CallLog.Calls.DATE)
            while (c.moveToNext()) {
                dates += Instant.ofEpochMilli(c.getLong(dateIdx)).atZone(ZoneOffset.UTC).toLocalDate()
            }
        }
        dates
    }

    private suspend fun query(
        selection: String?,
        selectionArgs: Array<String>?,
        sortOrder: String?,
    ): List<RawCallRow> = withContext(Dispatchers.IO) {
        val rows = mutableListOf<RawCallRow>()
        resolver.query(CallLog.Calls.CONTENT_URI, PROJECTION, selection, selectionArgs, sortOrder)?.use { c ->
            val idIdx = c.getColumnIndexOrThrow(CallLog.Calls._ID)
            val numberIdx = c.getColumnIndexOrThrow(CallLog.Calls.NUMBER)
            val nameIdx = c.getColumnIndexOrThrow(CallLog.Calls.CACHED_NAME)
            val dateIdx = c.getColumnIndexOrThrow(CallLog.Calls.DATE)
            val durationIdx = c.getColumnIndexOrThrow(CallLog.Calls.DURATION)
            val typeIdx = c.getColumnIndexOrThrow(CallLog.Calls.TYPE)
            val countryIdx = c.getColumnIndexOrThrow(CallLog.Calls.COUNTRY_ISO)
            val featuresIdx = c.getColumnIndexOrThrow(CallLog.Calls.FEATURES)
            val presentationIdx = c.getColumnIndexOrThrow(CallLog.Calls.NUMBER_PRESENTATION)
            val missedReasonIdx = if (Build.VERSION.SDK_INT >= 31) {
                c.getColumnIndex(CallLog.Calls.MISSED_REASON)
            } else {
                -1
            }
            while (c.moveToNext()) {
                rows += c.toRawCallRow(idIdx, numberIdx, nameIdx, dateIdx, durationIdx, typeIdx, countryIdx, featuresIdx, presentationIdx, missedReasonIdx)
            }
        }
        rows
    }

    private fun Cursor.toRawCallRow(
        idIdx: Int,
        numberIdx: Int,
        nameIdx: Int,
        dateIdx: Int,
        durationIdx: Int,
        typeIdx: Int,
        countryIdx: Int,
        featuresIdx: Int,
        presentationIdx: Int,
        missedReasonIdx: Int,
    ): RawCallRow = RawCallRow(
        id = getLong(idIdx),
        number = if (isNull(numberIdx)) null else getString(numberIdx),
        cachedName = if (isNull(nameIdx)) null else getString(nameIdx),
        dateMillis = getLong(dateIdx),
        durationSeconds = getLong(durationIdx),
        type = getInt(typeIdx),
        countryIso = if (isNull(countryIdx)) null else getString(countryIdx),
        features = if (isNull(featuresIdx)) 0 else getInt(featuresIdx),
        numberPresentation = if (isNull(presentationIdx)) CallLog.Calls.PRESENTATION_ALLOWED else getInt(presentationIdx),
        missedReason = if (missedReasonIdx < 0 || isNull(missedReasonIdx)) null else getInt(missedReasonIdx),
    )
}
