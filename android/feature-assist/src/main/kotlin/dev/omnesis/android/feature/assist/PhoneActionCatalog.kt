// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import android.Manifest
import android.app.SearchManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import java.text.Normalizer
import java.time.ZoneId

/**
 * The standard actions this phone can carry out, and the intent for each:
 * Android's own `AlarmClock`, `geo:`/navigation, play-from-search, launcher,
 * dial/call, calendar insert and share-text intents. Which apps take each one
 * is asked of the system ([apps]); an action no app takes is not offered.
 *
 * Where several apps take an action, the one the user chose ([preferred]) is
 * used, else the only one, else the phone's default; with none of those the
 * action is refused rather than leaving Android to show a chooser nobody sees.
 */
class PhoneActionCatalog(
    private val context: Context,
    private val preferred: (PhoneActionKind) -> String?,
    private val contacts: ContactLookup = ContentResolverContacts(context),
    private val canCall: () -> Boolean = {
        ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED
    },
    private val zone: () -> ZoneId = ZoneId::systemDefault,
    /** The package Android would start for [Intent] without asking; null when it would show its chooser. */
    private val systemDefault: (Intent) -> String? = { intent ->
        context.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
            ?.takeIf { it != ANDROID_RESOLVER }
    },
) {
    data class App(val packageName: String, val label: String)

    sealed interface Built {
        data class Ready(val intent: Intent) : Built

        data class Refused(val reason: String) : Built
    }

    private val pm: PackageManager get() = context.packageManager

    /** The apps that take [kind], by name. */
    fun apps(kind: PhoneActionKind): List<App> =
        pm.queryIntentActivities(probe(kind), 0)
            .map { it.activityInfo.packageName }
            .distinct()
            .filter { it != context.packageName }
            .map { App(it, label(it)) }
            .sortedBy { it.label.lowercase() }

    /** The phone's own default for [kind]; null when Android would ask which app to use. */
    fun defaultApp(kind: PhoneActionKind): App? {
        val resolved = systemDefault(probe(kind)) ?: return null
        return apps(kind).firstOrNull { it.packageName == resolved }
    }

    /** The app that carries out [kind]: the user's choice, else the only one, else the default. */
    fun appFor(kind: PhoneActionKind): App? {
        val apps = apps(kind)
        preferred(kind)?.let { chosen -> apps.firstOrNull { it.packageName == chosen }?.let { return it } }
        return apps.singleOrNull() ?: defaultApp(kind)
    }

    fun intentFor(action: PhoneAction): Built = when (action) {
        is PhoneAction.Timer -> clock(
            Intent(AlarmClock.ACTION_SET_TIMER).putExtra(AlarmClock.EXTRA_LENGTH, action.seconds),
            PhoneActionKind.TIMER,
        )
        is PhoneAction.Alarm -> clock(
            Intent(AlarmClock.ACTION_SET_ALARM)
                .putExtra(AlarmClock.EXTRA_HOUR, action.hour)
                .putExtra(AlarmClock.EXTRA_MINUTES, action.minute),
            PhoneActionKind.ALARM,
        )
        is PhoneAction.Navigate -> withApp(PhoneActionKind.NAVIGATE) { app ->
            val q = Uri.encode(action.destination)
            val uri = if (app.packageName == GOOGLE_MAPS) "google.navigation:q=$q" else "geo:0,0?q=$q"
            Intent(Intent.ACTION_VIEW, Uri.parse(uri))
        }
        is PhoneAction.PlayMusic -> withApp(PhoneActionKind.MUSIC) {
            Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH)
                .putExtra(SearchManager.QUERY, action.query)
                .putExtra(MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*")
        }
        is PhoneAction.OpenApp -> openApp(action.name)
        is PhoneAction.Call -> call(action.who)
        is PhoneAction.CalendarEvent -> withApp(PhoneActionKind.CALENDAR) {
            val begin = action.date.atTime(action.hour ?: 0, action.minute).atZone(zone()).toInstant().toEpochMilli()
            Intent(Intent.ACTION_INSERT, CalendarContract.Events.CONTENT_URI)
                .putExtra(CalendarContract.Events.TITLE, action.title)
                .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin)
                .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, begin + if (action.hour == null) DAY_MS else HOUR_MS)
                .putExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, action.hour == null)
        }
        is PhoneAction.ShareText -> withApp(PhoneActionKind.SHARE) {
            Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, action.text)
        }
    }

    private fun clock(intent: Intent, kind: PhoneActionKind): Built {
        if (apps(kind).isEmpty()) return Built.Refused("no clock app on this phone")
        // The clock app is the system's; with several, the phone's default takes it.
        preferred(kind)?.let(intent::setPackage)
        return Built.Ready(intent.putExtra(AlarmClock.EXTRA_SKIP_UI, true))
    }

    private fun withApp(kind: PhoneActionKind, build: (App) -> Intent): Built {
        val app = appFor(kind) ?: return Built.Refused(missingApp(kind))
        return Built.Ready(build(app).setPackage(app.packageName))
    }

    private fun missingApp(kind: PhoneActionKind): String =
        if (apps(kind).isEmpty()) {
            "no app on this phone handles ${kind.label.lowercase()}"
        } else {
            "choose an app for ${kind.label.lowercase()} in the voice-command settings"
        }

    /** The launchable app whose name is [name]: the same name, else the only one that contains it. */
    private fun openApp(name: String): Built {
        val wanted = normalize(name)
        if (wanted.isEmpty()) return Built.Refused("no app named")
        val apps = apps(PhoneActionKind.OPEN_APP).map { it to normalize(it.label) }
        val match = apps.filter { it.second == wanted }.singleOrNull()
            ?: apps.filter { wanted.length >= 3 && it.second.contains(wanted) }.minByOrNull { it.second.length }
                ?.takeIf { best -> apps.count { it.second == best.second } == 1 }
            ?: apps.filter { it.second.length >= 3 && wanted.contains(it.second) }.maxByOrNull { it.second.length }
        val app = match?.first ?: return Built.Refused("no app called “$name”")
        val launch = pm.getLaunchIntentForPackage(app.packageName) ?: return Built.Refused("${app.label} cannot be opened")
        return Built.Ready(launch)
    }

    private fun call(who: String): Built {
        val digits = who.filter { it.isDigit() || it == '+' }
        val spokenNumber = who.all { it.isDigit() || it in " +-()." } && digits.count(Char::isDigit) >= 3
        val number = if (spokenNumber) {
            digits
        } else {
            when (val found = contacts.find(who)) {
                is ContactMatch.Found -> found.number
                ContactMatch.NotFound -> return Built.Refused("no contact by that name")
                ContactMatch.Ambiguous -> return Built.Refused("more than one contact by that name")
                ContactMatch.NotAllowed -> return Built.Refused("contacts not allowed; allow them in the voice-command settings")
            }
        }
        if (apps(PhoneActionKind.CALL).isEmpty()) return Built.Refused("no phone app on this phone")
        // Without the permission to call, the dialer opens with the number, waiting for a tap.
        val action = if (canCall()) Intent.ACTION_CALL else Intent.ACTION_DIAL
        return Built.Ready(Intent(action, Uri.fromParts("tel", number, null)))
    }

    private fun label(packageName: String): String = try {
        pm.getApplicationLabel(pm.getApplicationInfo(packageName, 0)).toString()
    } catch (_: PackageManager.NameNotFoundException) {
        packageName
    }

    companion object {
        const val GOOGLE_MAPS = "com.google.android.apps.maps"
        private const val ANDROID_RESOLVER = "android"
        private const val HOUR_MS = 3_600_000L
        private const val DAY_MS = 24 * HOUR_MS

        /** The query each kind is offered by. */
        fun probe(kind: PhoneActionKind): Intent = when (kind) {
            PhoneActionKind.TIMER -> Intent(AlarmClock.ACTION_SET_TIMER)
            PhoneActionKind.ALARM -> Intent(AlarmClock.ACTION_SET_ALARM)
            PhoneActionKind.NAVIGATE -> Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=station"))
            PhoneActionKind.MUSIC -> Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH)
            PhoneActionKind.OPEN_APP -> Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            PhoneActionKind.CALL -> Intent(Intent.ACTION_DIAL, Uri.parse("tel:"))
            PhoneActionKind.CALENDAR -> Intent(Intent.ACTION_INSERT).setDataAndType(CalendarContract.Events.CONTENT_URI, CALENDAR_EVENT_TYPE)
            PhoneActionKind.SHARE -> Intent(Intent.ACTION_SEND).setType("text/plain")
        }

        private const val CALENDAR_EVENT_TYPE = "vnd.android.cursor.dir/event"

        /** Lowercase letters and digits only, accents dropped: how spoken and written names are compared. */
        fun normalize(s: String): String =
            Normalizer.normalize(s, Normalizer.Form.NFD).lowercase().filter { it in 'a'..'z' || it in '0'..'9' }
    }
}

/** What looking a contact up by name found. */
sealed interface ContactMatch {
    data class Found(val number: String) : ContactMatch

    data object NotFound : ContactMatch

    data object Ambiguous : ContactMatch

    data object NotAllowed : ContactMatch
}

/** Finds a contact's number by the name spoken. */
fun interface ContactLookup {
    fun find(name: String): ContactMatch
}

/**
 * [ContactLookup] on the phone's contacts, read only to find the number to
 * call; nothing is kept or sent. The same name as a contact wins, else the only
 * contact whose name holds every spoken word.
 */
class ContentResolverContacts(private val context: Context) : ContactLookup {
    fun allowed(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

    override fun find(name: String): ContactMatch {
        if (!allowed()) return ContactMatch.NotAllowed
        val entries = mutableListOf<ContactEntry>()
        context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(
                ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                ContactsContract.CommonDataKinds.Phone.NUMBER,
                ContactsContract.CommonDataKinds.Phone.IS_SUPER_PRIMARY,
            ),
            null,
            null,
            null,
        )?.use { c ->
            while (c.moveToNext()) {
                entries += ContactEntry(c.getLong(0), c.getString(1).orEmpty(), c.getString(2).orEmpty(), c.getInt(3) != 0)
            }
        }
        return match(name, entries)
    }

    data class ContactEntry(val contactId: Long, val name: String, val number: String, val primary: Boolean)

    companion object {
        /** The number for [spoken] among [entries]; see [ContentResolverContacts]. */
        fun match(spoken: String, entries: List<ContactEntry>): ContactMatch {
            val wanted = spoken.lowercase().split(Regex("\\s+")).map(PhoneActionCatalog::normalize).filter { it.isNotEmpty() }
            if (wanted.isEmpty()) return ContactMatch.NotFound
            val withNumber = entries.filter { it.number.isNotBlank() }
            val exact = withNumber.filter { PhoneActionCatalog.normalize(it.name) == wanted.joinToString("") }
            val pool = exact.ifEmpty {
                withNumber.filter { e ->
                    val words = e.name.lowercase().split(Regex("\\s+")).map(PhoneActionCatalog::normalize)
                    wanted.all { w -> words.any { it == w } }
                }
            }
            val byContact = pool.groupBy { it.contactId }
            return when (byContact.size) {
                0 -> ContactMatch.NotFound
                1 -> {
                    val numbers = byContact.values.single()
                    ContactMatch.Found((numbers.firstOrNull { it.primary } ?: numbers.first()).number)
                }
                else -> ContactMatch.Ambiguous
            }
        }
    }
}
