// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Apple provider.
 *
 * Reads from local macOS SQLite databases for Notes, Reminders, iMessage,
 * Contacts, Calendar, Call Log and Voicemail. Most sit behind Full Disk
 * Access, granted to the process running the collector; each helper names the
 * grant its own database needs.
 *
 * Each database is opened independently and its failure recorded on its own
 * helper, so a lock or a corrupt file costs only the source that reads that
 * database. `throwOnOpenFailure` turns such a record into the source's sync
 * error, scoped to the connection rather than the source when the failure is
 * a denial — Full Disk Access is one grant behind all seven databases, so a
 * source reporting a denial is reporting a condition every sibling source
 * shares, whether or not it has hit it yet.
 *
 * `AppleProvider` is a thin façade over eight collaborators:
 *
 * - `AppleAccountResolver` (`account-resolver.ts`) — MobileMeAccounts
 *   plist parsing (plutil-first, defaults fallback) + Reminders
 *   ZACCOUNTID hex parsing.
 * - `NotesDbHelper` (`db-helpers/notes-db.ts`) — Notes DB lifecycle +
 *   PRAGMA-based schema-column probe.
 * - `RemindersDbHelper` (`db-helpers/reminders-db.ts`) — multi-store
 *   `Data-<uuid>.sqlite` lifecycle + `getStoresWithAccounts` correlator.
 * - `IMessageDbHelper` (`db-helpers/imessage-db.ts`) — `chat.db`
 *   lifecycle plus the file-identity check that reopens a replaced database.
 * - `ContactsDbHelper` (`db-helpers/contacts-db.ts`) — per-account
 *   `Sources/<uuid>/AddressBook.abcddb` lifecycle.
 * - `CalendarDbHelper` (`db-helpers/calendar-db.ts`) — `Calendar.sqlitedb`
 *   lifecycle.
 * - `CallLogDbHelper` (`db-helpers/call-log-db.ts`) —
 *   `CallHistory.storedata` lifecycle.
 * - `VoicemailDbHelper` (`db-helpers/voicemail-db.ts`) — Phone.app's
 *   carrier-voicemail store lifecycle and schema probe.
 *
 */

import { createLogger, toErrorMessage } from "@omnesis/core";
import { ProviderId, AccountId, SyncError } from "@omnesis/types";
import {
  NOTES_DB_PATH,
  REMINDERS_DIR,
  IMESSAGE_DB_PATH,
  CONTACTS_DIR,
  CALENDAR_DB_PATH,
  CALL_LOG_DB_PATH,
  VOICEMAIL_DB_PATH,
} from "./paths.js";
import { AppleAccountResolver } from "./account-resolver.js";
import { NotesDbHelper } from "./db-helpers/notes-db.js";
import { RemindersDbHelper } from "./db-helpers/reminders-db.js";
import { IMessageDbHelper } from "./db-helpers/imessage-db.js";
import { ContactsDbHelper, type ContactsStore } from "./db-helpers/contacts-db.js";
import { CalendarDbHelper } from "./db-helpers/calendar-db.js";
import { CallLogDbHelper } from "./db-helpers/call-log-db.js";
import { VoicemailDbHelper } from "./db-helpers/voicemail-db.js";
import type { NotesSchemaColumns, RemindersStoreInfo } from "./types.js";
import type { Provider, SnapshotGap } from "@omnesis/source-sdk";
import type { AppleDbLifecycle, AppleDbOpenFailure, Db } from "./db-helpers/internal.js";

const log = createLogger("provider:apple");

export class AppleProvider implements Provider {
  readonly name = "Apple";

  private readonly resolver: AppleAccountResolver;
  private readonly notes: NotesDbHelper;
  private readonly reminders: RemindersDbHelper;
  private readonly imessage: IMessageDbHelper;
  private readonly contacts: ContactsDbHelper;
  private readonly calendar: CalendarDbHelper;
  private readonly callLog: CallLogDbHelper;
  private readonly voicemail: VoicemailDbHelper;
  private _accountId: AccountId | undefined;
  /**
   * Every Apple database, in the order the startup log lists them, paired with
   * the summary that log line carries.
   */
  private readonly databases: {
    label: string;
    helper: AppleDbLifecycle;
    summarize: () => string;
  }[];

  constructor(opts?: {
    notesDbPath?: string;
    remindersDirPath?: string;
    imessageDbPath?: string;
    contactsDirPath?: string;
    calendarDbPath?: string;
    callLogDbPath?: string;
    voicemailDbPath?: string;
    accountId?: string;
  }) {
    this.resolver = new AppleAccountResolver();
    this.notes = new NotesDbHelper(opts?.notesDbPath ?? NOTES_DB_PATH);
    this.reminders = new RemindersDbHelper(opts?.remindersDirPath ?? REMINDERS_DIR);
    this.imessage = new IMessageDbHelper(opts?.imessageDbPath ?? IMESSAGE_DB_PATH);
    this.contacts = new ContactsDbHelper(opts?.contactsDirPath ?? CONTACTS_DIR);
    this.calendar = new CalendarDbHelper(opts?.calendarDbPath ?? CALENDAR_DB_PATH);
    this.callLog = new CallLogDbHelper(opts?.callLogDbPath ?? CALL_LOG_DB_PATH);
    this.voicemail = new VoicemailDbHelper(opts?.voicemailDbPath ?? VOICEMAIL_DB_PATH);
    this._accountId = opts?.accountId ? AccountId(opts.accountId) : undefined;
    this.databases = [
      { label: "Apple Notes", helper: this.notes, summarize: () => `${this.notes.count()} notes` },
      {
        label: "Apple Reminders",
        helper: this.reminders,
        summarize: () =>
          `${this.reminders.getDbs().size} stores, ${this.reminders.count()} reminders`,
      },
      {
        label: "Apple iMessage",
        helper: this.imessage,
        summarize: () => `${this.imessage.count()} messages`,
      },
      {
        label: "Apple Contacts",
        helper: this.contacts,
        summarize: () =>
          `${this.contacts.getDbs().length} stores, ${this.contacts.count()} contacts`,
      },
      {
        label: "Apple Calendar",
        helper: this.calendar,
        summarize: () => `${this.calendar.count()} events`,
      },
      {
        label: "Apple Call Log",
        helper: this.callLog,
        summarize: () => `${this.callLog.count()} calls`,
      },
      {
        label: "Apple Voicemail",
        helper: this.voicemail,
        summarize: () => `${this.voicemail.count()} voicemails`,
      },
    ];
  }

  // ── Identity ──────────────────────────────────────────────────────

  get id(): ProviderId {
    return ProviderId(this._accountId ? `apple:${this._accountId}` : "apple");
  }

  get accountId(): AccountId | undefined {
    return this._accountId;
  }

  // ── Path getters (kept for callsites that build watchPaths etc.) ──

  get notesDbFilePath(): string {
    return this.notes.path;
  }

  get imessageDbFilePath(): string {
    return this.imessage.path;
  }

  get remindersDirFilePath(): string {
    return this.reminders.dirPath;
  }

  get contactsDbFilePath(): string {
    return this.contacts.dbFilePath;
  }

  get contactsDirFilePath(): string {
    return this.contacts.dirPath;
  }

  get calendarDbFilePath(): string {
    return this.calendar.path;
  }

  get callLogDbFilePath(): string {
    return this.callLog.path;
  }

  get voicemailDbFilePath(): string {
    return this.voicemail.path;
  }

  // ── Provider lifecycle ────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (!this._accountId) {
      this._accountId = this.resolver.resolveICloudEmail();
    }
    log.info(`Apple provider initialized for ${this._accountId ?? "unknown"}`);
    log.debug("Apple provider paths", {
      notesDbPath: this.notes.path,
      remindersDirPath: this.reminders.dirPath,
      imessageDbPath: this.imessage.path,
    });
  }

  /**
   * Open every Apple database present on this host, tolerating each one's
   * failure.
   *
   * The seven databases are independent: Full Disk Access can cover some and
   * not others, one can be mid-write while the rest are idle, and each is read
   * by a different source. Abandoning the pass at the first failure would
   * decide the fate of the databases behind it — including ones no configured
   * source reads — so each failure is left recorded on its helper for the
   * source that reads it to raise at sync time.
   *
   * Authentication fails only when every database this host has was refused.
   * That is a host-wide problem with one remedy, and registering sources that
   * can never read anything would report a working provider instead of it. A
   * lock or an unreadable schema is not that: it belongs to the one source
   * that reads the database, which reports it and stays retryable.
   */
  async authenticate(): Promise<void> {
    let present = 0;
    let opened = 0;
    const denials: AppleDbOpenFailure[] = [];

    for (const { label, helper, summarize } of this.databases) {
      if (!helper.isAvailable()) continue;
      present++;
      helper.open();
      if (helper.hasOpenDb()) {
        opened++;
        log.info(`${label} database opened: ${summarize()}`);
        continue;
      }
      const failure = helper.getLastOpenFailure();
      if (failure?.kind === "denied") denials.push(failure);
    }

    if (present > 0 && opened === 0 && denials.length === present) {
      // Full Disk Access is granted per executable, not per database, so a
      // refusal on every present database is the shared grant missing — every
      // Apple source configured on this host is affected, not just the ones
      // that noticed first.
      throw new SyncError(
        "permission",
        `No Apple database on this Mac could be read. ${denials.map((d) => d.message).join(" ")}`,
        { remediation: denials.find((d) => d.remediation)?.remediation, scope: "connection" },
      );
    }
  }

  async isAuthenticated(): Promise<boolean> {
    if (!this.databases.some(({ helper }) => helper.isAvailable())) {
      log.debug("No Apple databases found");
      return false;
    }

    // A helper records its failures rather than raising them, but this answer
    // gates the collector's whole sync pass — one that rejected here would
    // stop every provider on the host, not just this one. Cheap insurance.
    try {
      for (const { helper } of this.databases) {
        if (helper.isAvailable()) helper.open();
      }
    } catch (err) {
      log.warn(`Opening the Apple databases failed unexpectedly: ${toErrorMessage(err)}`);
    }
    return this.databases.some(({ helper }) => helper.hasOpenDb());
  }

  async disconnect(): Promise<void> {
    this.notes.close();
    this.reminders.close();
    this.imessage.close();
    this.contacts.close();
    this.calendar.close();
    this.callLog.close();
    this.voicemail.close();
  }

  // ── DB getters ────────────────────────────────────────────────────

  getNotesDb(): Db | null {
    return this.notes.getDb();
  }

  /**
   * Why the Notes database is unusable, for the Notes source to raise. Each
   * database reports its own: the sources that read the others are unaffected
   * by this one, and must not be told otherwise.
   */
  getNotesOpenFailure(): AppleDbOpenFailure | null {
    return this.notes.getLastOpenFailure();
  }

  getRemindersDbs(): Map<string, Db> {
    return this.reminders.getDbs();
  }

  getRemindersOpenFailure(): AppleDbOpenFailure | null {
    return this.reminders.getLastOpenFailure();
  }

  getIMessageDb(): Db | null {
    return this.imessage.getDb();
  }

  getIMessageOpenFailure(): AppleDbOpenFailure | null {
    return this.imessage.getLastOpenFailure();
  }

  getContactsDbs(): Db[] {
    return this.contacts.getDbs();
  }

  getContactsOpenFailure(): AppleDbOpenFailure | null {
    return this.contacts.getLastOpenFailure();
  }

  /**
   * Every address book the Contacts scan found, opened or not. The Contacts
   * source needs the unreadable ones as well as the readable ones: a snapshot
   * built from the readable ones alone would delete the rest.
   */
  getContactsStores(): ContactsStore[] {
    return this.contacts.getStores();
  }

  getCalendarDb(): Db | null {
    return this.calendar.getDb();
  }

  getCalendarOpenFailure(): AppleDbOpenFailure | null {
    return this.calendar.getLastOpenFailure();
  }

  getCallLogDb(): Db | null {
    return this.callLog.getDb();
  }

  getCallLogOpenFailure(): AppleDbOpenFailure | null {
    return this.callLog.getLastOpenFailure();
  }

  getVoicemailDb(): Db | null {
    return this.voicemail.getDb();
  }

  getVoicemailOpenFailure(): AppleDbOpenFailure | null {
    return this.voicemail.getLastOpenFailure();
  }

  // ── Has-flags ─────────────────────────────────────────────────────

  get hasNotes(): boolean {
    return this.notes.isAvailable();
  }

  get hasReminders(): boolean {
    return this.reminders.isAvailable();
  }

  get hasIMessage(): boolean {
    return this.imessage.isAvailable();
  }

  get hasContacts(): boolean {
    return this.contacts.isAvailable();
  }

  get hasCalendar(): boolean {
    return this.calendar.isAvailable();
  }

  get hasCallLog(): boolean {
    return this.callLog.isAvailable();
  }

  get hasVoicemail(): boolean {
    return this.voicemail.isAvailable();
  }

  // ── Notes-specific schema probe ───────────────────────────────────

  /**
   * Notes fields whose live column name could not be identified on this macOS
   * version — the source refuses to reconcile deletions while any are listed.
   */
  getNotesUnresolvedSchemaColumns(): string[] {
    return this.notes.getUnresolvedSchemaColumns();
  }

  getNotesSchemaColumns(): NotesSchemaColumns {
    return this.notes.getSchemaColumns();
  }

  // ── Reminders multi-store enumeration ─────────────────────────────

  getRemindersStoresWithAccounts(): RemindersStoreInfo[] {
    return this.reminders.getStoresWithAccounts(this.resolver);
  }

  /**
   * Reminders stores the scan found but could not read. Reported so a partial
   * read is never mistaken for the whole picture.
   */
  getRemindersStoreGaps(): SnapshotGap[] {
    return this.reminders.getSkippedStores();
  }
}
