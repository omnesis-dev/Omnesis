// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.photos

import android.content.ContentProvider
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.net.Uri
import android.os.Bundle
import android.os.CancellationSignal
import android.provider.MediaStore

/**
 * A minimal, real-SQLite-backed fake of the `content://media/external/images`
 * provider for Robolectric tests. Android's actual `MediaProvider` isn't
 * shadowed by Robolectric out of the box (the same gap `FakeCallLogProvider`
 * documents for `CallLogProvider`), so [PhotosSourceTest] registers this
 * instead — real SQL against a real in-memory table, so arbitrary
 * `WHERE`/`ORDER BY`/`LIMIT` clauses behave exactly as they would against the
 * genuine provider. `_ID` is `AUTOINCREMENT`, matching the real table: an id
 * is never reused, even once its row is deleted.
 */
class FakePhotosProvider : ContentProvider() {
    private lateinit var helper: SQLiteOpenHelper
    var failSnapshotQuery = false
    var failPageQuery = false

    override fun onCreate(): Boolean {
        helper = object : SQLiteOpenHelper(context, "fake_photos.db", null, 1) {
            override fun onCreate(db: SQLiteDatabase) {
                db.execSQL(
                    """CREATE TABLE images (
                        ${MediaStore.Images.Media._ID} INTEGER PRIMARY KEY AUTOINCREMENT,
                        ${MediaStore.Images.Media.DATE_ADDED} INTEGER,
                        ${MediaStore.Images.Media.DATE_MODIFIED} INTEGER,
                        ${MediaStore.Images.Media.RELATIVE_PATH} TEXT
                    )""",
                )
            }

            override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
        }
        return true
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = if (failSnapshotQuery) null else helper.readableDatabase.query("images", projection, selection, selectionArgs, null, null, sortOrder)

    /**
     * [PhotosSource] queries through this Bundle-based overload (the real
     * `MediaProvider` rejects a `LIMIT` clause embedded in the legacy
     * `sortOrder` string — see `PhotosSource.query`'s doc comment) so the fake
     * mirrors it here rather than relying on `ContentProvider`'s default
     * bridging, which drops `QUERY_ARG_LIMIT` on the floor.
     */
    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        queryArgs: Bundle?,
        cancellationSignal: CancellationSignal?,
    ): Cursor? {
        if (failPageQuery) return null
        val selection = queryArgs?.getString(ContentResolver.QUERY_ARG_SQL_SELECTION)
        val selectionArgs = queryArgs?.getStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS)
        val sortOrder = queryArgs?.getString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER)
        val limit = if (queryArgs?.containsKey(ContentResolver.QUERY_ARG_LIMIT) == true) {
            queryArgs.getInt(ContentResolver.QUERY_ARG_LIMIT).toString()
        } else {
            null
        }
        return helper.readableDatabase.query("images", projection, selection, selectionArgs, null, null, sortOrder, limit)
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri {
        val id = helper.writableDatabase.insert("images", null, values)
        return ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
    }

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        helper.writableDatabase.delete("images", selection, selectionArgs)

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int =
        helper.writableDatabase.update("images", values, selection, selectionArgs)

    override fun getType(uri: Uri): String? = null
}
