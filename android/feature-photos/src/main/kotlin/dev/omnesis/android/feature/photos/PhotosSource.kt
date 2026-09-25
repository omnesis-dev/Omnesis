// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import android.content.ContentResolver
import android.content.ContentUris
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import android.util.Log
import dev.omnesis.android.transport.dto.DocumentInputDto
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val TAG = "Omnesis:photos"
private const val RECENT_WINDOW_DAYS = 30L

/** One sync pass' output: documents to push and the advanced cursor. */
data class PhotosSyncResult(
    val documents: List<DocumentInputDto>,
    val cursor: PhotosCursor,
)

/**
 * Reads Android's `MediaStore.Images` and produces one photo/screenshot
 * document per new or newly-backfilled image — the Android analogue of
 * the iOS `PhotosSource`. Diverges from it in ways driven by real Android
 * capabilities:
 *
 *  - No `StableAssetId` bridging layer — see [PhotoAssetRef].
 *  - No per-asset `AnalyzedAssetStore` — `MediaStore.MediaColumns.DATE_ADDED` gives a
 *    real, monotonic library-insertion watermark (unlike iOS's "Recently
 *    Added" smart-album workaround), so the `.steady`-phase new-arrival
 *    query never re-visits an asset once the watermark has passed it.
 *  - Images only, no video — matches iOS's `PHAsset.fetchAssets(with: .image)` scope.
 *
 * [analyze] is injected so this class is unit-testable without real ML Kit
 * inference (tests substitute a fake fragment-returning function; see
 * `PhotosSourceTest`).
 */
class PhotosSource(
    private val resolver: ContentResolver,
    private val analyze: suspend (PhotoAssetRef, AnalysisTier) -> PhotoAnalysisFragment,
) {
    companion object {
        const val SOURCE_TYPE = "photos"
        const val ACCOUNT_ID_LOCAL = "local"
        const val PROVIDER_ID = "photos"

        private val PROJECTION = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DATE_ADDED,
            MediaStore.Images.Media.DATE_MODIFIED,
            MediaStore.Images.Media.RELATIVE_PATH,
        )

        private fun isScreenshotPath(relativePath: String?): Boolean {
            val path = relativePath?.lowercase() ?: return false
            return path.contains("screenshots")
        }
    }

    /** One bounded sync pass: a page of the current backfill phase, or a page of new arrivals once STEADY. */
    suspend fun sync(
        cursor: PhotosCursor,
        pageLimit: Int = 200,
        clock: () -> Instant = Instant::now,
    ): PhotosSyncResult = withContext(Dispatchers.IO) {
        if (cursor.phase == PhotosPhase.STEADY) {
            return@withContext syncNewArrivals(cursor, pageLimit)
        }
        syncBackfillPage(cursor, pageLimit, clock)
    }

    /**
     * Every asset id currently present — the whole-library snapshot for the
     * periodic reconcile pass — or null when the query could not be run.
     *
     * Null is not an empty library. A provider that hands back no cursor is a
     * normal Android outcome, distinct from the exception a revoked permission
     * throws: the provider may be restarting, or belong to a profile this
     * process cannot currently see. This snapshot is the only deletion
     * mechanism Photos has, so an empty list built from a query that did not
     * run asserts the whole library was deleted — and because the reconcile is
     * throttled, a persistently unavailable provider produces exactly the
     * spaced, repeated, self-corroborating snapshots the gateway's absence
     * policy is built to act on.
     */
    suspend fun fetchAllExternalIds(): List<String>? = withContext(Dispatchers.IO) {
        val ids = mutableListOf<String>()
        val cursor = resolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            arrayOf(MediaStore.Images.Media._ID),
            null,
            null,
            null,
        ) ?: return@withContext null
        cursor.use { c ->
            val idIdx = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            while (c.moveToNext()) ids += c.getLong(idIdx).toString()
        }
        ids
    }

    private suspend fun syncNewArrivals(cursor: PhotosCursor, pageLimit: Int): PhotosSyncResult {
        val after = resumePoint(cursor)
        val assets = query(
            selection = afterSelection(after),
            selectionArgs = afterArgs(after).toTypedArray(),
            sortOrder = "${MediaStore.Images.Media.DATE_ADDED} ASC, ${MediaStore.Images.Media._ID} ASC",
            limit = pageLimit,
        )
        val documents = assets.map { asset ->
            PhotosDocumentBuilder.build(
                asset = asset,
                providerId = PROVIDER_ID,
                sourceId = "$SOURCE_TYPE:$ACCOUNT_ID_LOCAL",
                fragment = analyze(asset, AnalysisTier.NEW),
            )
        }
        if (documents.isNotEmpty()) {
            Log.i(TAG, "Synced ${documents.size} new arrival(s)")
        }
        val last = assets.lastOrNull()
        val nextCursor = if (last != null) {
            cursor.copy(lastAssetId = last.id, lastAssetDateAddedSec = last.dateAddedSec)
        } else {
            cursor
        }
        return PhotosSyncResult(documents, nextCursor)
    }

    private suspend fun syncBackfillPage(cursor: PhotosCursor, pageLimit: Int, clock: () -> Instant): PhotosSyncResult {
        // The RECENT/BACKFILL boundary is fixed the moment RECENT first
        // runs — see PhotosCursor.recentCutoffSec's doc comment.
        val recentCutoffSec = cursor.recentCutoffSec
            ?: clock().minus(RECENT_WINDOW_DAYS, ChronoUnit.DAYS).epochSecond
        val effectiveCursor = if (cursor.phase == PhotosPhase.RECENT && cursor.recentCutoffSec == null) {
            cursor.copy(recentCutoffSec = recentCutoffSec)
        } else {
            cursor
        }

        val after = resumePoint(effectiveCursor)
        val selection = StringBuilder(afterSelection(after))
        val args = afterArgs(after).toMutableList()
        when (effectiveCursor.phase) {
            PhotosPhase.SCREENSHOTS -> {
                selection.append(" AND ${screenshotClause(true)}")
            }
            PhotosPhase.RECENT -> {
                selection.append(" AND ${screenshotClause(false)} AND ${MediaStore.Images.Media.DATE_ADDED} >= ?")
                args += recentCutoffSec.toString()
            }
            PhotosPhase.BACKFILL -> {
                selection.append(" AND ${screenshotClause(false)} AND ${MediaStore.Images.Media.DATE_ADDED} < ?")
                args += recentCutoffSec.toString()
            }
            PhotosPhase.STEADY -> error("unreachable — steady is handled by syncNewArrivals")
        }

        val assets = query(
            selection = selection.toString(),
            selectionArgs = args.toTypedArray(),
            sortOrder = "${MediaStore.Images.Media.DATE_ADDED} ASC, ${MediaStore.Images.Media._ID} ASC",
            limit = pageLimit,
        )
        val tier = if (effectiveCursor.preserveRichAnalysis) AnalysisTier.NEW else AnalysisTier.BACKFILL
        val documents = assets.map { asset ->
            PhotosDocumentBuilder.build(
                asset = asset,
                providerId = PROVIDER_ID,
                sourceId = "$SOURCE_TYPE:$ACCOUNT_ID_LOCAL",
                fragment = analyze(asset, tier),
            )
        }
        if (documents.isNotEmpty()) {
            Log.i(TAG, "Backfilled ${documents.size} asset(s) in phase ${effectiveCursor.phase}")
        }

        val (maxDate, maxId) = maxSeen(effectiveCursor, assets)

        // A page cut short (fewer rows than the limit) means this phase is
        // exhausted — advance to the next phase, resetting the WITHIN-PHASE
        // watermark (each phase is a differently-filtered query starting
        // fresh) but carrying [maxDate]/[maxId] forward regardless, since
        // that becomes STEADY's own starting watermark once BACKFILL drains
        // — see `PhotosCursor.maxSeenDateAddedSec`'s doc comment for why a
        // null/reset watermark there would be wrong.
        val nextCursor = if (assets.size < pageLimit) {
            val nextPhase = effectiveCursor.phase.next
            effectiveCursor.copy(
                phase = nextPhase,
                lastAssetId = if (nextPhase == PhotosPhase.STEADY) maxId else null,
                lastAssetDateAddedSec = if (nextPhase == PhotosPhase.STEADY) maxDate else null,
                maxSeenDateAddedSec = maxDate,
                maxSeenId = maxId,
                backfillCompletedAt = if (nextPhase == PhotosPhase.STEADY) clock().toString() else effectiveCursor.backfillCompletedAt,
                preserveRichAnalysis = if (nextPhase == PhotosPhase.STEADY) false else effectiveCursor.preserveRichAnalysis,
            )
        } else {
            val last = assets.last()
            effectiveCursor.copy(
                lastAssetId = last.id,
                lastAssetDateAddedSec = last.dateAddedSec,
                maxSeenDateAddedSec = maxDate,
                maxSeenId = maxId,
            )
        }
        return PhotosSyncResult(documents, nextCursor)
    }

    /** The running `(DATE_ADDED, _ID)` maximum across [cursor]'s prior phases and this page. */
    private fun maxSeen(cursor: PhotosCursor, page: List<PhotoAssetRef>): Pair<Long?, String?> {
        var maxDate = cursor.maxSeenDateAddedSec
        var maxId = cursor.maxSeenId
        for (asset in page) {
            val isNewer = maxDate == null ||
                asset.dateAddedSec > maxDate ||
                (asset.dateAddedSec == maxDate && (maxId == null || asset.id.toLong() > maxId.toLong()))
            if (isNewer) {
                maxDate = asset.dateAddedSec
                maxId = asset.id
            }
        }
        return maxDate to maxId
    }

    private fun resumePoint(cursor: PhotosCursor): Pair<Long, String>? {
        val date = cursor.lastAssetDateAddedSec ?: return null
        val id = cursor.lastAssetId ?: return null
        return date to id
    }

    /**
     * Same-timestamp ties break on `_ID` (a real `AUTOINCREMENT` rowid, so
     * higher always means "inserted later") rather than depending on
     * enumeration order — the `OR (DATE_ADDED = ? AND _ID > ?)` clause
     * mirrors `CallLogSource`'s own watermark membership clause.
     */
    private fun afterSelection(after: Pair<Long, String>?): String = if (after == null) {
        "1=1"
    } else {
        "((${MediaStore.Images.Media.DATE_ADDED} > ?) OR (${MediaStore.Images.Media.DATE_ADDED} = ? AND ${MediaStore.Images.Media._ID} > ?))"
    }

    private fun afterArgs(after: Pair<Long, String>?): List<String> = if (after == null) {
        emptyList()
    } else {
        listOf(after.first.toString(), after.first.toString(), after.second)
    }

    private fun screenshotClause(isScreenshot: Boolean): String {
        val op = if (isScreenshot) "LIKE" else "NOT LIKE"
        // Matches both the AOSP convention (Pictures/Screenshots) and the
        // common OEM one (DCIM/Screenshots, e.g. Samsung) — checking only
        // one would under-detect on real devices.
        return "(${MediaStore.Images.Media.RELATIVE_PATH} $op '%Screenshots%')"
    }

    private fun query(
        selection: String,
        selectionArgs: Array<String>,
        sortOrder: String,
        limit: Int,
    ): List<PhotoAssetRef> {
        val refs = mutableListOf<PhotoAssetRef>()
        // The real on-device MediaProvider validates the legacy `sortOrder`
        // string against a strict column-ref/ASC/DESC grammar and rejects a
        // raw `LIMIT` clause appended to it ("Invalid token LIMIT") — a
        // restriction Robolectric's SQLite-backed test fake doesn't
        // replicate. QUERY_ARG_LIMIT via the Bundle-based query overload
        // (API 26+) is the sanctioned way to express a limit.
        val queryArgs = Bundle().apply {
            putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection)
            putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, selectionArgs)
            putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, sortOrder)
            putInt(ContentResolver.QUERY_ARG_LIMIT, limit)
        }
        resolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            PROJECTION,
            queryArgs,
            null,
        ).let { checkNotNull(it) { "Photo library page is temporarily unavailable" } }.use { c ->
            val idIdx = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val dateAddedIdx = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
            val dateModifiedIdx = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_MODIFIED)
            val pathIdx = c.getColumnIndexOrThrow(MediaStore.Images.Media.RELATIVE_PATH)
            while (c.moveToNext()) {
                refs += c.toPhotoAssetRef(idIdx, dateAddedIdx, dateModifiedIdx, pathIdx)
            }
        }
        return refs
    }

    private fun Cursor.toPhotoAssetRef(idIdx: Int, dateAddedIdx: Int, dateModifiedIdx: Int, pathIdx: Int): PhotoAssetRef {
        val id = getLong(idIdx)
        val uri: Uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
        return PhotoAssetRef(
            id = id.toString(),
            dateAddedSec = getLong(dateAddedIdx),
            dateModifiedSec = if (isNull(dateModifiedIdx)) getLong(dateAddedIdx) else getLong(dateModifiedIdx),
            isScreenshot = isScreenshotPath(if (isNull(pathIdx)) null else getString(pathIdx)),
            uri = uri.toString(),
        )
    }
}
