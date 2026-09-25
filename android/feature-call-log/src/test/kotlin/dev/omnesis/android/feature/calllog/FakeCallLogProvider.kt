// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.calllog

import android.content.ContentProvider
import android.content.ContentUris
import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.net.Uri
import android.provider.CallLog

/**
 * A minimal, real-SQLite-backed fake of the `content://call_log/calls`
 * provider for Robolectric tests. Android's actual `CallLogProvider` isn't
 * shadowed by Robolectric out of the box (unlike `ContactsContract`), so
 * [CallLogSourceTest] registers this instead — real SQL against a real
 * in-memory table (via Robolectric's own working SQLite implementation), not
 * a hand-rolled row matcher, so arbitrary `WHERE`/`ORDER BY`/`LIMIT` clauses
 * behave exactly as they would against the genuine provider. `_ID` is
 * declared `AUTOINCREMENT`, matching AOSP's real `calls` table: an id is
 * never reused, even once its row is deleted.
 */
class FakeCallLogProvider : ContentProvider() {
    private lateinit var helper: SQLiteOpenHelper

    override fun onCreate(): Boolean {
        helper = object : SQLiteOpenHelper(context, "fake_call_log.db", null, 1) {
            override fun onCreate(db: SQLiteDatabase) {
                db.execSQL(
                    """CREATE TABLE calls (
                        ${CallLog.Calls._ID} INTEGER PRIMARY KEY AUTOINCREMENT,
                        ${CallLog.Calls.NUMBER} TEXT,
                        ${CallLog.Calls.CACHED_NAME} TEXT,
                        ${CallLog.Calls.DATE} INTEGER,
                        ${CallLog.Calls.DURATION} INTEGER,
                        ${CallLog.Calls.TYPE} INTEGER,
                        ${CallLog.Calls.COUNTRY_ISO} TEXT,
                        ${CallLog.Calls.FEATURES} INTEGER,
                        ${CallLog.Calls.NUMBER_PRESENTATION} INTEGER DEFAULT ${CallLog.Calls.PRESENTATION_ALLOWED},
                        missed_reason INTEGER
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
    ): Cursor = helper.readableDatabase.query("calls", projection, selection, selectionArgs, null, null, sortOrder)

    override fun insert(uri: Uri, values: ContentValues?): Uri {
        val id = helper.writableDatabase.insert("calls", null, values)
        return ContentUris.withAppendedId(CallLog.Calls.CONTENT_URI, id)
    }

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
        helper.writableDatabase.delete("calls", selection, selectionArgs)

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int =
        helper.writableDatabase.update("calls", values, selection, selectionArgs)

    override fun getType(uri: Uri): String? = null
}
