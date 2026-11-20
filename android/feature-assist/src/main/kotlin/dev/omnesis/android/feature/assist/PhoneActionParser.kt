// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.feature.assist

import java.time.DayOfWeek
import java.time.LocalDate

/** Turns a transcribed command into an action of the [PhoneActionKind] catalogue; null when it is none. */
fun interface CommandInterpreter {
    fun interpret(text: String, today: LocalDate): PhoneAction?
}

/**
 * Reads a transcribed command, in Italian or English, by fixed rules:
 *
 * - alarms: “sveglia alle 7 e 30”, “wake me up at 6:45 pm”;
 * - timers: “timer di 10 minuti”, “un'ora e mezza”, “set a timer for 90 seconds”, or a duration alone;
 * - navigation: “naviga verso la stazione”, “portami in via Example 42”, “take me to the airport”;
 * - calls: “chiama Maya”, “telefona a Jamie Lopez”, “call 555 0100”;
 * - opening an app: “apri Spotify”, “open the camera”;
 * - calendar events: “appuntamento dal dentista domani alle 15”, “meeting with Sarah on friday at 3 pm”;
 * - notes and lists: “aggiungi alla lista latte”, “aggiungi pane alla lista”, “take a note buy stamps”;
 * - music: “metti un po' di jazz”, “riproduci l'ultimo album dei Northstar”, “play some piano music”.
 *
 * Anything else is null; nothing is guessed.
 */
object PhoneActionParser : CommandInterpreter {
    override fun interpret(text: String, today: LocalDate): PhoneAction? = parse(text, today)

    fun parse(text: String, today: LocalDate = LocalDate.now()): PhoneAction? {
        val clean = text.trim().trimEnd('.', '!', '?').replace('’', '\'')
        if (clean.isEmpty()) return null
        val lower = clean.lowercase()
        // Lowercasing keeps every index for the scripts spoken here; when it does not, payloads stay lowercase.
        val original = if (lower.length == clean.length) clean else lower
        val tokens = tokenize(lower)
        if (tokens.isEmpty()) return null

        if (tokens.any { it.text in ALARM_WORDS } || (tokens.has("wake") && tokens.has("me"))) return alarm(tokens)
        if (tokens.has("timer")) return timer(tokens)
        span(NAVIGATE, lower, original)?.let { return PhoneAction.Navigate(stripLeading(it, PLACE_PREFIXES)) }
        span(CALL, lower, original)?.let { return PhoneAction.Call(it) }
        span(OPEN_APP, lower, original)?.let { return PhoneAction.OpenApp(stripLeading(it, APP_PREFIXES)) }
        if (tokens.any { it.text in CALENDAR_WORDS }) calendar(tokens, lower, original, today)?.let { return it }
        share(lower, original)?.let { return PhoneAction.ShareText(it) }
        // “metti 10 minuti” is a timer, not music.
        if (tokens.any { it.text in UNITS }) timer(tokens)?.let { return it }
        span(MUSIC, lower, original)?.let { return PhoneAction.PlayMusic(stripLeading(it, MUSIC_PREFIXES)) }
        return timer(tokens)
    }

    // --- tokens -------------------------------------------------------------

    private data class Tok(val text: String, val range: IntRange)

    private fun List<Tok>.has(word: String) = any { it.text == word }

    private fun tokenize(lower: String): List<Tok> =
        Regex("\\d{1,2}[:.]\\d{2}|\\d+|\\p{L}+").findAll(lower).map { Tok(it.value, it.range) }.toList()

    /** What [pattern]'s one group caught, cut from [original]; null when it does not match or caught nothing. */
    private fun span(pattern: Regex, lower: String, original: String): String? {
        val group = pattern.matchEntire(lower)?.groups?.get(1) ?: return null
        return original.substring(group.range).trim().trimEnd(',', ';').takeIf { it.isNotBlank() }
    }

    private fun stripLeading(text: String, prefixes: List<String>): String {
        val lower = text.lowercase()
        val prefix = prefixes.firstOrNull { lower.startsWith(it) && text.length > it.length } ?: return text
        return text.substring(prefix.length).trim()
    }

    // --- timers and alarms --------------------------------------------------

    private fun timer(tokens: List<Tok>): PhoneAction.Timer? {
        val seconds = duration(tokens.map { it.text })
        return if (seconds in 1..MAX_TIMER_SECONDS) PhoneAction.Timer(seconds) else null
    }

    /** The total of every “<number> <unit>” in [tokens], in seconds. */
    private fun duration(tokens: List<String>): Int {
        var total = 0
        var i = 0
        while (i < tokens.size) {
            // “mezz'ora”, “half an hour”, “un quarto d'ora”, “quarter of an hour”
            if (tokens[i] in HALF && tokens.getOrNull(i + 1) in HOUR_WORDS) { total += 1_800; i += 2; continue }
            if (tokens[i] == "half" && tokens.getOrNull(i + 1) in ARTICLES && tokens.getOrNull(i + 2) in HOUR_WORDS) { total += 1_800; i += 3; continue }
            if (tokens[i] == "quarto" && tokens.getOrNull(i + 1) == "d" && tokens.getOrNull(i + 2) in HOUR_WORDS) { total += 900; i += 3; continue }
            if (tokens[i] == "quarter" && tokens.getOrNull(i + 1) == "of" && tokens.getOrNull(i + 3) in HOUR_WORDS) { total += 900; i += 4; continue }
            val number = number(tokens, i)
            if (number == null) { i++; continue }
            val (value, length) = number
            val unit = UNITS[tokens.getOrNull(i + length)]
            if (unit == null) { i += length; continue }
            total += value * unit
            i += length + 1
            // “un'ora e mezza”; “two and a half minutes” is rare enough to leave out.
            if (tokens.getOrNull(i) == "e" && tokens.getOrNull(i + 1) in HALF) { total += unit / 2; i += 2 }
        }
        return total
    }

    private fun alarm(tokens: List<Tok>): PhoneAction.Alarm? {
        val time = time(tokens) ?: return null
        return PhoneAction.Alarm(time.hour, time.minute)
    }

    /** A time of day, and the tokens it took (its anchor word included). */
    private data class TimeOfDay(val hour: Int, val minute: Int, val from: Int, val until: Int)

    /**
     * The time in [tokens]: after “alle”/“at”/“per le”/“for”, or, unless
     * [anchored], at the first number that is not an article. Null when there
     * is none.
     */
    private fun time(tokens: List<Tok>, anchored: Boolean = false): TimeOfDay? {
        val words = tokens.map { it.text }
        words.indexOfFirst { it in NOON_MIDNIGHT }.takeIf { it >= 0 }?.let { at ->
            val from = if (words.getOrNull(at - 1) in TIME_ANCHORS || words.getOrNull(at - 1) == "a") at - 1 else at
            return TimeOfDay(NOON_MIDNIGHT.getValue(words[at]), 0, from, at + 1)
        }
        val anchor = words.indices.firstOrNull { words[it] in TIME_ANCHORS && startsTime(words, it + 1) } ?: -1
        if (anchored && anchor < 0) return null
        var start = if (anchor >= 0) {
            anchor + 1
        } else {
            words.indexOfFirst { TIME.matches(it) || (it !in INDEFINITE && number(listOf(it), 0) != null) }
        }
        if (anchor >= 0 && words.getOrNull(start) == "le") start++
        if (start < 0 || start >= words.size) return null
        var hour: Int
        var minute = 0
        var i: Int
        val clock = TIME.matchEntire(words[start])
        if (clock != null) {
            hour = clock.groupValues[1].toInt()
            minute = clock.groupValues[2].toInt()
            i = start + 1
        } else {
            val (h, length) = number(words, start) ?: return null
            hour = h
            i = start + length
            when {
                words.getOrNull(i) == "e" && words.getOrNull(i + 1) in HALF -> { minute = 30; i += 2 }
                words.getOrNull(i) == "e" && words.getOrNull(i + 1) == "un" && words.getOrNull(i + 2) == "quarto" -> { minute = 15; i += 3 }
                words.getOrNull(i) == "meno" && words.getOrNull(i + 1) == "un" && words.getOrNull(i + 2) == "quarto" -> {
                    hour = (hour + 23) % 24; minute = 45; i += 3
                }
                words.getOrNull(i) == "e" -> number(words, i + 1)?.let { (m, l) -> minute = m; i += 1 + l }
                else -> number(words, i)?.let { (m, l) -> if (m in 0..59) { minute = m; i += l } }
            }
        }
        when {
            words.getOrNull(i) == "pm" -> { if (hour in 1..11) hour += 12; i++ }
            words.getOrNull(i) == "p" && words.getOrNull(i + 1) == "m" -> { if (hour in 1..11) hour += 12; i += 2 }
            words.getOrNull(i) == "am" -> { if (hour == 12) hour = 0; i++ }
            words.getOrNull(i) == "a" && words.getOrNull(i + 1) == "m" -> { if (hour == 12) hour = 0; i += 2 }
        }
        // “di sera”, “del pomeriggio”, “in the evening”, “tonight”
        val partOfDay = words.drop(i).take(3).indexOfFirst { it in EVENING || it in MORNING }
        if (partOfDay >= 0) {
            if (words[i + partOfDay] in EVENING && hour in 1..11) hour += 12
            i += partOfDay + 1
        }
        if (hour !in 0..23 || minute !in 0..59) return null
        return TimeOfDay(hour, minute, if (anchor >= 0) anchor else start, i)
    }

    private fun startsTime(words: List<String>, at: Int): Boolean {
        val next = if (words.getOrNull(at) == "le") at + 1 else at
        val w = words.getOrNull(next) ?: return false
        return TIME.matches(w) || number(words, next) != null || w in NOON_MIDNIGHT
    }

    /** The number starting at [i] and how many tokens it took, or null. */
    private fun number(tokens: List<String>, i: Int): Pair<Int, Int>? {
        val t = tokens.getOrNull(i) ?: return null
        t.toIntOrNull()?.let { return it to 1 }
        val value = WORDS[t] ?: return null
        // “twenty five”, “venti cinque”
        val next = tokens.getOrNull(i + 1)?.let(WORDS::get)
        if (value % 10 == 0 && value >= 20 && next != null && next in 1..9) return value + next to 2
        return value to 1
    }

    // --- calendar -----------------------------------------------------------

    /**
     * An event needs a day or a time: a time alone is today, a day alone is an
     * all-day event. Its title is what remains once the verb, the calendar
     * phrase, the day and the time are taken out.
     */
    private fun calendar(tokens: List<Tok>, lower: String, original: String, today: LocalDate): PhoneAction.CalendarEvent? {
        val words = tokens.map { it.text }
        val cut = mutableListOf<IntRange>()

        var date: LocalDate? = null
        var evening = false
        for ((i, w) in words.withIndex()) {
            val offset = RELATIVE_DAYS[w]
            val weekday = WEEKDAYS[w]
            if (offset == null && weekday == null) continue
            date = if (offset != null) {
                today.plusDays(offset.toLong())
            } else {
                val ahead = (weekday!!.value - today.dayOfWeek.value + 7) % 7
                today.plusDays(if (ahead == 0) 7L else ahead.toLong())
            }
            val from = if (words.getOrNull(i - 1) in DAY_LEADERS) i - 1 else i
            cut += tokens[from].range.first..tokens[i].range.last
            evening = w in EVENING
            break
        }
        DAY_AFTER_TOMORROW.find(lower)?.let { m ->
            date = today.plusDays(2)
            cut.clear()
            cut += m.range
        }

        val time = time(tokens, anchored = true)
            ?.takeIf { t -> t.from < t.until && tokens.size >= t.until }
            // “stasera alle 8” is 20:00.
            ?.let { t -> if (evening && t.hour in 1..11) t.copy(hour = t.hour + 12) else t }
        if (time != null) cut += tokens[time.from].range.first..tokens[time.until - 1].range.last
        if (date == null && time == null) return null

        CALENDAR_PHRASE.find(lower)?.let { cut += it.range }
        CALENDAR_VERB.find(lower)?.let { cut += it.range }

        val title = buildString {
            var at = 0
            for (r in cut.sortedBy { it.first }) {
                if (r.first > at) append(original, at, r.first)
                at = maxOf(at, r.last + 1)
            }
            if (at < original.length) append(original, at, original.length)
        }.replace(Regex("\\s+"), " ").trim().trim(',', ';', ':').trim()

        return PhoneAction.CalendarEvent(
            title = title.ifEmpty { "Event" }.replaceFirstChar { it.uppercaseChar() },
            date = date ?: today,
            hour = time?.hour,
            minute = time?.minute ?: 0,
        )
    }

    // --- notes and lists ----------------------------------------------------

    private fun share(lower: String, original: String): String? =
        SHARE.firstNotNullOfOrNull { span(it, lower, original) }

    // --- vocabulary ---------------------------------------------------------

    private val NAVIGATE = Regex(
        "^(?:naviga(?:re)?|naviga verso|portami|guidami|indicazioni|percorso|navigate|take me|drive me|drive|directions|get me)" +
            "\\s+(?:(?:verso|fino|per|a|to|towards)\\s+)?(.+)$",
    )
    private val CALL = Regex("^(?:chiama(?:mi)?|telefona(?:re)?(?: a)?|fai una (?:telefonata|chiamata) a|call|phone|ring|dial)\\s+(.+)$")
    private val OPEN_APP = Regex("^(?:apri|avvia|lancia|open|launch|start)\\s+(.+)$")
    private val MUSIC = Regex("^(?:metti|riproduci|suona|fammi sentire|fai partire|play|put on)\\s+(.+)$")
    private val SHARE = listOf(
        Regex("^(?:aggiungi|metti|segna|scrivi|annota)\\s+(?:alla|nella|sulla)\\s+(?:mia\\s+)?lista(?:\\s+della\\s+spesa)?\\s+(.+)$"),
        Regex("^(?:aggiungi|metti|segna|scrivi)\\s+(.+?)\\s+(?:alla|nella|sulla)\\s+(?:mia\\s+)?lista(?:\\s+della\\s+spesa)?$"),
        Regex("^(?:add|put)\\s+(.+?)\\s+(?:to|on)\\s+(?:my\\s+|the\\s+)?(?:shopping\\s+)?list$"),
        Regex("^(?:prendi nota|annota|scrivi una nota|nota|take a note|make a note|note|write down)\\s*(?:che|di|:|that|to)?\\s+(.+)$"),
    )

    /** Leading words that are not part of the place: “portami alla stazione” goes to “stazione”. */
    private val PLACE_PREFIXES = listOf(
        "all'", "alla ", "allo ", "agli ", "alle ", "ai ", "al ", "a ",
        "in ", "dalla ", "dallo ", "dal ", "dai ", "da ", "l'", "la ", "lo ", "il ", "the ",
    )
    private val APP_PREFIXES = listOf("l'app ", "la app ", "l'applicazione ", "app ", "the app ", "the ", "l'", "la ", "lo ", "il ")
    private val MUSIC_PREFIXES = listOf(
        "un po' di ", "un po di ", "la musica di ", "musica di ", "la canzone ", "some ", "music by ", "songs by ", "the song ",
    )

    private val CALENDAR_WORDS = setOf(
        "appuntamento", "evento", "riunione", "incontro", "calendario", "visita",
        "appointment", "event", "meeting", "calendar",
    )
    private val CALENDAR_PHRASE = Regex("\\b(?:al|nel|in|sul)\\s+(?:mio\\s+)?calendario\\b|\\b(?:to|in|on)\\s+(?:my\\s+|the\\s+)?calendar\\b")
    private val CALENDAR_VERB = Regex("^(?:aggiungi|crea|metti|segna|fissa|add|create|schedule|put|set up)\\s+(?:un\\s+|una\\s+|uno\\s+|an?\\s+)?")
    private val DAY_AFTER_TOMORROW = Regex("\\b(?:the\\s+)?day\\s+after\\s+tomorrow\\b")
    private val RELATIVE_DAYS = mapOf("oggi" to 0, "today" to 0, "stasera" to 0, "tonight" to 0, "domani" to 1, "tomorrow" to 1, "dopodomani" to 2)
    private val WEEKDAYS: Map<String, DayOfWeek> = buildMap {
        listOf("lunedì", "martedì", "mercoledì", "giovedì", "venerdì").forEachIndexed { i, w ->
            put(w, DayOfWeek.of(i + 1))
            put(w.dropLast(1) + "i", DayOfWeek.of(i + 1))
        }
        put("sabato", DayOfWeek.SATURDAY)
        put("domenica", DayOfWeek.SUNDAY)
        DayOfWeek.entries.forEach { put(it.name.lowercase(), it) }
    }
    private val DAY_LEADERS = setOf("il", "on", "next", "this", "prossimo", "questo", "questa", "prossima")

    private val TIME = Regex("(\\d{1,2})[:.](\\d{2})")
    private val TIME_ANCHORS = setOf("alle", "all", "at", "per", "for")
    private val INDEFINITE = setOf("a", "an", "un", "una", "uno")
    private val ALARM_WORDS = setOf("sveglia", "svegliami", "allarme", "alarm")
    private val EVENING = setOf("sera", "pomeriggio", "evening", "afternoon", "tonight", "stasera")
    private val MORNING = setOf("mattina", "mattino", "morning")
    private val NOON_MIDNIGHT = mapOf("mezzogiorno" to 12, "noon" to 12, "mezzanotte" to 0, "midnight" to 0)
    private val HALF = setOf("mezza", "mezzo", "mezz")
    private val ARTICLES = setOf("a", "an")
    private val HOUR_WORDS = setOf("ora", "hour")
    private val UNITS = mapOf(
        "ora" to 3_600, "ore" to 3_600, "hour" to 3_600, "hours" to 3_600, "hr" to 3_600, "h" to 3_600,
        "minuto" to 60, "minuti" to 60, "minute" to 60, "minutes" to 60, "min" to 60,
        "secondo" to 1, "secondi" to 1, "second" to 1, "seconds" to 1, "sec" to 1,
    )

    private const val MAX_TIMER_SECONDS = 24 * 3_600

    private val WORDS: Map<String, Int> = buildMap {
        val itUnits = listOf("uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove")
        listOf(
            "zero", "uno", "due", "tre", "quattro", "cinque", "sei", "sette", "otto", "nove", "dieci",
            "undici", "dodici", "tredici", "quattordici", "quindici", "sedici", "diciassette", "diciotto", "diciannove",
        ).forEachIndexed { n, w -> put(w, n) }
        put("un", 1); put("una", 1)
        for ((w, n) in listOf("venti" to 20, "trenta" to 30, "quaranta" to 40, "cinquanta" to 50, "sessanta" to 60)) {
            put(w, n)
            if (n == 60) continue
            itUnits.forEachIndexed { u, unit ->
                val stem = if (unit.first() in "aeiou") w.dropLast(1) else w
                put(stem + unit, n + u + 1)
            }
            put("${w}tré", n + 3)
        }
        listOf(
            "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
            "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
        ).forEachIndexed { n, w -> put(w, n) }
        put("a", 1); put("an", 1)
        for ((w, n) in listOf("twenty" to 20, "thirty" to 30, "forty" to 40, "fifty" to 50, "sixty" to 60)) put(w, n)
    }
}
