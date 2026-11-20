// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import android.app.Application
import android.app.SearchManager
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.ResolveInfo
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import dev.omnesis.android.feature.assist.ContentResolverContacts.ContactEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowSettings
import java.time.LocalDate
import java.time.ZoneOffset

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PhoneActionCatalogTest {
    private val app = ApplicationProvider.getApplicationContext<Application>()
    private val pm = shadowOf(app.packageManager)
    private val chosen = mutableMapOf<PhoneActionKind, String>()
    private var contact: ContactMatch = ContactMatch.NotFound
    private var canCall = false
    private val defaults = mutableMapOf<String, String>()

    private val catalog = PhoneActionCatalog(
        context = app,
        preferred = { chosen[it] },
        contacts = { contact },
        canCall = { canCall },
        zone = { ZoneOffset.UTC },
        systemDefault = { intent -> defaults[intent.action] },
    )

    /** An app called [label] that takes [kind]. */
    private fun install(packageName: String, label: String, vararg kinds: PhoneActionKind) {
        pm.installPackage(
            PackageInfo().apply {
                this.packageName = packageName
                applicationInfo = ApplicationInfo().apply {
                    this.packageName = packageName
                    nonLocalizedLabel = label
                }
            },
        )
        for (kind in kinds) {
            pm.addResolveInfoForIntent(
                PhoneActionCatalog.probe(kind),
                ResolveInfo().apply {
                    activityInfo = ActivityInfo().apply {
                        this.packageName = packageName
                        name = "$packageName.Main"
                        applicationInfo = ApplicationInfo().apply { this.packageName = packageName }
                    }
                },
            )
        }
    }

    private fun ready(action: PhoneAction): Intent =
        (catalog.intentFor(action) as PhoneActionCatalog.Built.Ready).intent

    private fun refused(action: PhoneAction): String =
        (catalog.intentFor(action) as PhoneActionCatalog.Built.Refused).reason

    @Test fun onlyTheAppsThatTakeAnActionAreOffered() {
        install("com.example.maps", "Atlas", PhoneActionKind.NAVIGATE)
        install("com.example.drive", "Roadie", PhoneActionKind.NAVIGATE)
        assertEquals(listOf("Atlas", "Roadie"), catalog.apps(PhoneActionKind.NAVIGATE).map { it.label })
        assertTrue(catalog.apps(PhoneActionKind.MUSIC).isEmpty())
        assertTrue(refused(PhoneAction.PlayMusic("jazz")).startsWith("no app on this phone"))
    }

    @Test fun withSeveralAppsAndNoChoiceTheActionWaitsForOne() {
        install("com.example.maps", "Atlas", PhoneActionKind.NAVIGATE)
        install("com.example.drive", "Roadie", PhoneActionKind.NAVIGATE)
        assertNull(catalog.appFor(PhoneActionKind.NAVIGATE))
        assertTrue(refused(PhoneAction.Navigate("stazione")).startsWith("choose an app"))

        // The phone's default is used when the user chose none…
        defaults[Intent.ACTION_VIEW] = "com.example.maps"
        assertEquals("com.example.maps", ready(PhoneAction.Navigate("stazione")).`package`)

        // …and the user's choice wins over it.
        chosen[PhoneActionKind.NAVIGATE] = "com.example.drive"
        val intent = ready(PhoneAction.Navigate("stazione centrale"))
        assertEquals("com.example.drive", intent.`package`)
        assertEquals("geo:0,0?q=stazione%20centrale", intent.dataString)
    }

    @Test fun googleMapsStartsTurnByTurnNavigation() {
        install(PhoneActionCatalog.GOOGLE_MAPS, "Maps", PhoneActionKind.NAVIGATE)
        val intent = ready(PhoneAction.Navigate("42 Example Street"))
        assertEquals(PhoneActionCatalog.GOOGLE_MAPS, intent.`package`)
        assertEquals("google.navigation:q=42%20Example%20Street", intent.dataString)
    }

    @Test fun musicPlaysFromSearchInTheOnlyMusicApp() {
        install("com.example.tunes", "Tunes", PhoneActionKind.MUSIC)
        val intent = ready(PhoneAction.PlayMusic("jazz"))
        assertEquals(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH, intent.action)
        assertEquals("jazz", intent.getStringExtra(SearchManager.QUERY))
        assertEquals("com.example.tunes", intent.`package`)
    }

    @Test fun anAppIsOpenedByItsName() {
        install("com.example.camera", "Fotocamera", PhoneActionKind.OPEN_APP)
        install("com.example.sound", "Stellar Sound", PhoneActionKind.OPEN_APP)
        pm.addActivityIfNotPresent(ComponentName("com.example.sound", "com.example.sound.Main"))
        pm.addIntentFilterForActivity(
            ComponentName("com.example.sound", "com.example.sound.Main"),
            android.content.IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_LAUNCHER) },
        )
        assertEquals("com.example.sound", ready(PhoneAction.OpenApp("stellar sound")).component?.packageName)
        assertTrue(refused(PhoneAction.OpenApp("Northstar")).contains("Northstar"))
    }

    @Test fun aSpokenNumberIsDialedAndANameNeedsTheContacts() {
        install("com.example.phone", "Phone", PhoneActionKind.CALL)
        val dial = ready(PhoneAction.Call("555 0100"))
        assertEquals(Intent.ACTION_DIAL, dial.action)
        assertEquals("tel:5550100", dial.dataString)

        contact = ContactMatch.NotAllowed
        assertTrue(refused(PhoneAction.Call("Maya Reeves")).startsWith("contacts not allowed"))

        contact = ContactMatch.Found("+15550100123")
        canCall = true
        val call = ready(PhoneAction.Call("Maya Reeves"))
        assertEquals(Intent.ACTION_CALL, call.action)
        assertEquals("tel:+15550100123", call.data!!.toString().replace("%2B", "+"))

        contact = ContactMatch.Ambiguous
        assertTrue(refused(PhoneAction.Call("Maya")).startsWith("more than one"))
    }

    @Test fun aCalendarEventOpensPrefilled() {
        install("com.example.cal", "Calendar", PhoneActionKind.CALENDAR)
        val timed = ready(PhoneAction.CalendarEvent("Dentist", LocalDate.of(2026, 11, 21), 15, 30))
        assertEquals(Intent.ACTION_INSERT, timed.action)
        assertEquals("Dentist", timed.getStringExtra(CalendarContract.Events.TITLE))
        val begin = LocalDate.of(2026, 11, 21).atTime(15, 30).toInstant(ZoneOffset.UTC).toEpochMilli()
        assertEquals(begin, timed.getLongExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, 0))
        assertEquals(begin + 3_600_000, timed.getLongExtra(CalendarContract.EXTRA_EVENT_END_TIME, 0))
        assertFalse(timed.getBooleanExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, true))

        val allDay = ready(PhoneAction.CalendarEvent("Trip", LocalDate.of(2026, 11, 22), null))
        assertTrue(allDay.getBooleanExtra(CalendarContract.EXTRA_EVENT_ALL_DAY, false))
    }

    @Test fun textIsSharedOnlyToTheChosenApp() {
        install("com.example.notes", "Notes", PhoneActionKind.SHARE)
        install("com.example.chat", "Chat", PhoneActionKind.SHARE)
        assertTrue(refused(PhoneAction.ShareText("latte")).startsWith("choose an app"))
        chosen[PhoneActionKind.SHARE] = "com.example.notes"
        val intent = ready(PhoneAction.ShareText("latte"))
        assertEquals(Intent.ACTION_SEND, intent.action)
        assertEquals("latte", intent.getStringExtra(Intent.EXTRA_TEXT))
        assertEquals("com.example.notes", intent.`package`)
    }

    @Test fun timersGoToTheClockWithoutShowingIt() {
        assertTrue(refused(PhoneAction.Timer(60)).startsWith("no clock app"))
        install("com.example.clock", "Clock", PhoneActionKind.TIMER, PhoneActionKind.ALARM)
        val timer = ready(PhoneAction.Timer(300))
        assertEquals(AlarmClock.ACTION_SET_TIMER, timer.action)
        assertEquals(300, timer.getIntExtra(AlarmClock.EXTRA_LENGTH, 0))
        assertTrue(timer.getBooleanExtra(AlarmClock.EXTRA_SKIP_UI, false))
    }

    @Test fun theRunnerStartsTheAppOnlyWithTheOverlayPermission() {
        install("com.example.clock", "Clock", PhoneActionKind.TIMER)
        val runner = PhoneActionRunner(app, catalog, today = { LocalDate.of(2026, 11, 20) })
        ShadowSettings.setCanDrawOverlays(false)
        assertTrue(runner.run("timer di 5 minuti") is AssistOutcome.Failed)
        assertNull(shadowOf(app).nextStartedActivity)

        ShadowSettings.setCanDrawOverlays(true)
        assertTrue(runner.run("timer di 5 minuti") is AssistOutcome.Done)
        assertEquals(AlarmClock.ACTION_SET_TIMER, shadowOf(app).nextStartedActivity.action)
        assertTrue(runner.run("che tempo fa") is AssistOutcome.NotUnderstood)
    }

    @Test fun contactsAreMatchedByTheWholeNameElseByEveryWord() {
        val entries = listOf(
            ContactEntry(1, "Maya Reeves", "+1 555 0100 001", primary = false),
            ContactEntry(1, "Maya Reeves", "+1 555 0100 002", primary = true),
            ContactEntry(2, "Jamie Lopez", "+1 555 0100 003", primary = false),
            ContactEntry(3, "Jamie Lin", "+1 555 0100 004", primary = false),
            ContactEntry(4, "Sarah Méndez", "+1 555 0100 005", primary = false),
        )
        assertEquals(ContactMatch.Found("+1 555 0100 002"), ContentResolverContacts.match("maya reeves", entries))
        assertEquals(ContactMatch.Found("+1 555 0100 002"), ContentResolverContacts.match("Maya", entries))
        assertEquals(ContactMatch.Ambiguous, ContentResolverContacts.match("Jamie", entries))
        assertEquals(ContactMatch.Found("+1 555 0100 003"), ContentResolverContacts.match("Jamie Lopez", entries))
        assertEquals(ContactMatch.Found("+1 555 0100 005"), ContentResolverContacts.match("sarah mendez", entries))
        assertEquals(ContactMatch.NotFound, ContentResolverContacts.match("David Lin", entries))
    }
}
