// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import dev.omnesis.android.feature.assist.PhoneAction.Alarm
import dev.omnesis.android.feature.assist.PhoneAction.CalendarEvent
import dev.omnesis.android.feature.assist.PhoneAction.Call
import dev.omnesis.android.feature.assist.PhoneAction.Navigate
import dev.omnesis.android.feature.assist.PhoneAction.OpenApp
import dev.omnesis.android.feature.assist.PhoneAction.PlayMusic
import dev.omnesis.android.feature.assist.PhoneAction.ShareText
import dev.omnesis.android.feature.assist.PhoneAction.Timer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate

class PhoneActionParserTest {
    /** A Friday. */
    private val today = LocalDate.of(2026, 11, 20)

    private fun parse(text: String) = PhoneActionParser.parse(text, today)

    @Test fun italianTimers() {
        assertEquals(Timer(600), parse("Imposta un timer di 10 minuti"))
        assertEquals(Timer(600), parse("timer dieci minuti"))
        assertEquals(Timer(1_500), parse("timer di venticinque minuti"))
        assertEquals(Timer(1_680), parse("timer di ventotto minuti"))
        assertEquals(Timer(1_800), parse("timer di mezz'ora"))
        assertEquals(Timer(5_400), parse("un'ora e mezza"))
        assertEquals(Timer(3_690), parse("timer di un'ora un minuto e trenta secondi"))
        assertEquals(Timer(900), parse("un quarto d'ora"))
        assertEquals(Timer(45), parse("45 secondi"))
    }

    @Test fun englishTimers() {
        assertEquals(Timer(300), parse("Set a timer for 5 minutes."))
        assertEquals(Timer(300), parse("set a 5 minute timer"))
        assertEquals(Timer(60), parse("timer for a minute"))
        assertEquals(Timer(1_500), parse("timer for twenty five minutes"))
        assertEquals(Timer(1_800), parse("half an hour"))
        assertEquals(Timer(5_400), parse("timer for 1 hour 30 minutes"))
    }

    @Test fun italianAlarms() {
        assertEquals(Alarm(7, 0), parse("sveglia alle 7"))
        assertEquals(Alarm(7, 30), parse("Sveglia alle 7:30"))
        assertEquals(Alarm(7, 30), parse("svegliami alle sette e trenta"))
        assertEquals(Alarm(6, 30), parse("sveglia alle 6 e mezza"))
        assertEquals(Alarm(8, 15), parse("sveglia alle otto e un quarto"))
        assertEquals(Alarm(7, 45), parse("sveglia alle otto meno un quarto"))
        assertEquals(Alarm(19, 0), parse("metti una sveglia per le 7 di sera"))
        assertEquals(Alarm(1, 0), parse("sveglia all'una"))
        assertEquals(Alarm(12, 0), parse("sveglia a mezzogiorno"))
    }

    @Test fun englishAlarms() {
        assertEquals(Alarm(6, 45), parse("Set an alarm for 6:45"))
        assertEquals(Alarm(18, 45), parse("wake me up at 6:45 pm"))
        assertEquals(Alarm(0, 30), parse("alarm at 12:30 am"))
        assertEquals(Alarm(7, 30), parse("alarm at 7 30"))
        assertEquals(Alarm(0, 0), parse("alarm at midnight"))
    }

    @Test fun navigation() {
        assertEquals(Navigate("stazione centrale"), parse("Naviga verso la stazione centrale"))
        assertEquals(Navigate("stazione"), parse("portami alla stazione"))
        assertEquals(Navigate("via Example 42"), parse("portami in via Example 42"))
        assertEquals(Navigate("Riverside Estate"), parse("indicazioni per Riverside Estate"))
        assertEquals(Navigate("airport"), parse("take me to the airport"))
        assertEquals(Navigate("42 Example Street"), parse("navigate to 42 Example Street."))
    }

    @Test fun music() {
        assertEquals(PlayMusic("jazz"), parse("metti un po' di jazz"))
        assertEquals(PlayMusic("l'ultimo album dei Northstar"), parse("riproduci l'ultimo album dei Northstar"))
        assertEquals(PlayMusic("piano music"), parse("play some piano music"))
    }

    @Test fun openingAnApp() {
        assertEquals(OpenApp("fotocamera"), parse("apri la fotocamera"))
        assertEquals(OpenApp("Stellar Sound"), parse("apri l'app Stellar Sound"))
        assertEquals(OpenApp("camera"), parse("open the camera"))
    }

    @Test fun calls() {
        assertEquals(Call("Maya Reeves"), parse("chiama Maya Reeves"))
        assertEquals(Call("Jamie Lopez"), parse("telefona a Jamie Lopez"))
        assertEquals(Call("555 0100"), parse("call 555 0100"))
    }

    @Test fun calendarEvents() {
        assertEquals(
            CalendarEvent("Appuntamento dal dentista", today.plusDays(1), 15, 0),
            parse("appuntamento dal dentista domani alle 15"),
        )
        assertEquals(
            CalendarEvent("Meeting with Sarah", LocalDate.of(2026, 11, 27), 15, 0),
            parse("meeting with Sarah on friday at 3 pm"),
        )
        assertEquals(
            CalendarEvent("Cena con Maya", LocalDate.of(2026, 11, 21), null),
            parse("aggiungi al calendario cena con Maya sabato"),
        )
        assertEquals(
            CalendarEvent("Riunione con 3 colleghi", today, 9, 30),
            parse("riunione con 3 colleghi alle 9:30"),
        )
        assertEquals(CalendarEvent("Evento cena", today, 20, 0), parse("evento cena stasera alle 8"))
        assertEquals(CalendarEvent("Visita", today.plusDays(2), 11, 0), parse("visita dopodomani alle 11"))
        // No day and no time: not an event.
        assertNull(parse("aggiungi al calendario cena con Maya"))
    }

    @Test fun notesAndLists() {
        assertEquals(ShareText("latte"), parse("aggiungi alla lista latte"))
        assertEquals(ShareText("pane e burro"), parse("aggiungi pane e burro alla lista della spesa"))
        assertEquals(ShareText("stamps"), parse("add stamps to my shopping list"))
        assertEquals(ShareText("buy stamps"), parse("take a note buy stamps"))
        assertEquals(ShareText("domani piove"), parse("prendi nota che domani piove"))
    }

    @Test fun timersAndAlarmsWinOverTheWiderRules() {
        assertEquals(Alarm(7, 0), parse("metti la sveglia alle 7"))
        assertEquals(Timer(600), parse("metti un timer di 10 minuti"))
        assertEquals(Timer(600), parse("metti 10 minuti"))
        assertEquals(Timer(300), parse("start a timer for 5 minutes"))
    }

    @Test fun anythingElseIsNotGuessed() {
        assertNull(parse(""))
        assertNull(parse("turn on the kitchen lights"))
        assertNull(parse("che tempo fa domani"))
        assertNull(parse("timer"))
        assertNull(parse("set an alarm"))
        assertNull(parse("alarm at 25:00"))
        assertNull(parse("timer for 30 hours"))
    }
}
