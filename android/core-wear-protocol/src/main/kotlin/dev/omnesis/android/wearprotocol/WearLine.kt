// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.wearprotocol

/**
 * Every fixed line the watch relay shows or speaks, on the watch and in the
 * phone's notifications about it. One table, so both apps read identical
 * sentences. The iOS counterparts are `SiriAskDialog` in `SiriAsk.swift` and
 * the watch app's own status strings.
 */
enum class WearLine(val text: String) {
    // The app's name on its home screen, the button that opens the keyboard
    // for a question, and the tile's label under its microphone.
    APP_NAME("Omnesis"),
    TYPE_A_QUESTION("Type a question"),
    SPEAK("Speak"),

    // What ended a question.
    EMPTY_ANSWER("The agent finished without a spoken answer. Check the conversation in Omnesis."),
    UNEXPLAINED_FAILURE("Sorry, something went wrong while answering. Check the conversation in Omnesis."),
    STILL_WORKING("Still working on it — I'll send you the answer as a notification."),
    PREVIOUS_TURN_RUNNING(
        "Still working on your last question — that answer is on the way. Ask me again in a moment.",
    ),
    NOT_PAIRED("Omnesis isn't paired with a gateway yet. Open the app to pair first."),
    EXPERIMENTAL_OFF("This gateway version doesn't support asking by voice. Update your gateway."),
    UNAUTHORIZED("Omnesis couldn't authenticate. Re-pair with your gateway from the app."),
    UNREACHABLE("Sorry, I couldn't reach your Omnesis gateway."),
    SEND_FAILED("Sorry, I couldn't send that question to your gateway."),
    PHONE_UNREACHABLE("I couldn't reach your phone. Make sure it's nearby and unlocked, then try again."),
    WATCH_LINK_INACTIVE("The watch couldn't open its link to your phone. Try again in a moment."),
    RELAY_FAILED("Sorry, something went wrong reaching your phone."),
    ANSWER_ON_PHONE(
        "I got your answer but couldn't bring it to your watch. It's waiting in Omnesis on your phone.",
    ),
    QUEUED_FOR_PHONE(
        "Your phone didn't respond in time, so I've queued your question. " +
            "The answer will arrive as a notification once your phone picks it up.",
    ),

    // Titles over an outcome.
    STATUS_QUEUED("Queued for phone"),
    STATUS_STILL_WORKING("Still working"),
    COULDNT_ANSWER("Couldn't answer"),

    // Steps of a turn in progress.
    WORKING("Working…"),
    WAKING_PHONE("Waking your phone…"),
    RECEIVED("Received"),
    ASKING("Asking…"),
    THINKING("Thinking…"),
    SEARCHING("Searching…"),
    READING("Reading…"),
    LOOKING_UP_PEOPLE("Looking up people…"),
    CHECKING_RECORDS("Checking records…"),
    TRACING_LINKS("Tracing links…"),
    CHECKING_DATES("Checking dates…"),
    GATHERING_CONTEXT("Gathering context…"),
    NOTING_SOURCES("Noting sources…"),
    LOOKING_DEEPER("Looking deeper…"),
    PLANNING("Planning…"),
    SETTING_UP_WATCH("Setting up a watch…"),

    // The recorder.
    TAP_TO_SPEAK("Tap to speak"),
    OPENING_MICROPHONE("Opening microphone…"),
    LISTENING("Listening"),
    READY_TO_SEND("Ready to send"),
    GOT_IT("Got it."),
    WAITING_FOR_ANSWER("Waiting for your answer…"),
    WORKING_OUT_ROUTE("Working out what you need…"),
    NOTE_ACCEPTED("I'll deal with it."),
    CAPTURE_DEFERRED("Your phone will finish this."),
    COULDNT_RECORD("Couldn't record"),
    COULDNT_RECORD_HINT("Open the phone app. Check microphone access and updates."),

    // Notes.
    NOTE_TITLE("Omnesis note"),
    SENT_TO_PHONE("Sent to your phone."),
    GATEWAY_WILL_TRANSCRIBE("Your gateway will transcribe it."),
    COULDNT_SAVE("Couldn't save"),
    RECORDING_NOT_SAVED("Your recording couldn't be saved. Try again."),
    NOTE_NOT_SENT("A note wasn't sent"),
    NOTES_DROPPED_HINT("They couldn't reach your phone for a week and were removed."),

    // Buttons.
    ASK("Ask"),
    TELL("Tell"),
    SEND("Send"),
    CANCEL("Cancel"),
    DONE("Done"),
    TRY_AGAIN("Try again"),
    ASK_AGAIN("Ask again"),
    NEW_NOTE("New note"),
    SPEAK_ANSWER("Speak answer"),
    STOP("Stop"),
    OK("OK"),

    // Phone notifications about a recording it could not process.
    CAPTURE_NOTICE_TITLE("Check your watch capture"),
    CAPTURE_DELAYED(
        "Your recording is kept for retry. Open Omnesis on your phone and check the gateway connection.",
    ),
    CAPTURE_EXPIRED("Your recording couldn't be processed for a week and was removed. Please record it again."),
    CAPTURE_ASK_INTERRUPTED(
        "Your question's delivery was interrupted. Check the conversation on your phone before asking again.",
    ),
    ;

    companion object {
        /** Past this, a failure reason is a wall of text rather than a sentence naming a condition. */
        private const val MAX_REASON_LENGTH = 160

        /** What the watch shows and speaks for [outcome]. */
        fun forOutcome(outcome: AskOutcome): String = when (outcome) {
            is AskOutcome.Answered -> outcome.text
            is AskOutcome.Failed -> failure(outcome.reason)
            AskOutcome.EmptyAnswer -> EMPTY_ANSWER.text
            AskOutcome.StillWorking -> STILL_WORKING.text
            AskOutcome.PreviousTurnRunning -> PREVIOUS_TURN_RUNNING.text
            AskOutcome.NotPaired -> NOT_PAIRED.text
            AskOutcome.ExperimentalOff -> EXPERIMENTAL_OFF.text
            AskOutcome.Unauthorized -> UNAUTHORIZED.text
            AskOutcome.Unreachable -> UNREACHABLE.text
            AskOutcome.SendFailed -> SEND_FAILED.text
            AskOutcome.PhoneUnreachable -> PHONE_UNREACHABLE.text
            AskOutcome.WatchLinkInactive -> WATCH_LINK_INACTIVE.text
            AskOutcome.RelayFailed -> RELAY_FAILED.text
            AskOutcome.AnswerOnPhone -> ANSWER_ON_PHONE.text
            AskOutcome.QueuedForPhone -> QUEUED_FOR_PHONE.text
        }

        /** The title over a [AskOutcome.Kind.STATUS] outcome: where the question is. */
        fun statusTitle(outcome: AskOutcome): String =
            if (outcome == AskOutcome.QueuedForPhone) STATUS_QUEUED.text else STATUS_STILL_WORKING.text

        /**
         * The line for a turn that died. The gateway's reason is used when its
         * first line is one short sentence, prefixed so the line still opens
         * as an apology; anything else falls back to [UNEXPLAINED_FAILURE].
         */
        fun failure(reason: String?): String {
            val firstLine = reason?.substringBefore('\n')?.trim().orEmpty()
            if (firstLine.isEmpty() || firstLine.codePointCount(0, firstLine.length) > MAX_REASON_LENGTH) {
                return UNEXPLAINED_FAILURE.text
            }
            val sentence = if (firstLine.last() in ".!?") firstLine else "$firstLine."
            return "Sorry — $sentence"
        }

        /** The heading over notes dropped after waiting too long for the phone. */
        fun notesNotSent(count: Int): String =
            if (count == 1) NOTE_NOT_SENT.text else "$count notes weren't sent"
    }
}
