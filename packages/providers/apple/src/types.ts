// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { makeCursorValidator } from "@omnesis/source-sdk";

/**
 * Sync cursor for Apple Notes source.
 * Uses the Core Data modification timestamp for incremental sync.
 */
export interface AppleNotesSyncCursor extends Record<string, unknown> {
  /** Last modification timestamp we synced (Core Data format: seconds since 2001-01-01) */
  lastModifiedTimestamp: number;
  /**
   * Z_PK of the last note emitted at `lastModifiedTimestamp`. Forms a
   * composite `(modificationDate, Z_PK)` cursor so a page boundary that
   * falls inside a run of notes sharing the same modificationDate resumes
   * at the next primary key rather than skipping every tied row with
   * `modificationDate > lastModifiedTimestamp`. Absent on legacy cursors
   * (treated as 0, which matches every tied row at the boundary timestamp).
   */
  lastModifiedPk?: number;
  /**
   * Queue size pinned at the start of the current sync cycle, so the
   * progress bar's `total` stays stable across pages within a cycle. Counted
   * once on the first page (rows where modificationDate > cursor) and
   * cleared when the cycle ends with `hasMore: false`.
   */
  cycleQueueTotal?: number;
  /**
   * Signature of the snapshot ID set we last reported to the gateway —
   * `"<count>:<maxModificationDate>"`. The signature query is one cheap
   * COUNT/MAX scan; the full ID enumeration only runs when the signature
   * has actually changed since the previous cycle.
   */
  lastSnapshotSignature?: string;
}

export function isAppleNotesSyncCursor(v: unknown): v is AppleNotesSyncCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (typeof c.lastModifiedTimestamp !== "number") return false;
  if (c.lastModifiedPk !== undefined && typeof c.lastModifiedPk !== "number") return false;
  if (c.cycleQueueTotal !== undefined && typeof c.cycleQueueTotal !== "number") return false;
  if (c.lastSnapshotSignature !== undefined && typeof c.lastSnapshotSignature !== "string")
    return false;
  return true;
}

export const validateAppleNotesSyncCursor = makeCursorValidator(isAppleNotesSyncCursor);

/**
 * Raw note row from the SQLite database (joined query result).
 */
export interface RawNote {
  /** Primary key */
  pk: number;
  /** Note title */
  title: string | null;
  /** Note snippet (first ~200 chars) */
  snippet: string | null;
  /** Unique identifier (UUID) */
  identifier: string;
  /** Creation date (Core Data timestamp) */
  creationDate: number | null;
  /** Modification date (Core Data timestamp) */
  modificationDate: number;
  /** Whether the note is password-protected */
  isLocked: boolean;
  /** Whether the note is pinned */
  isPinned: boolean;
  /** Whether the note is in the trash */
  isTrashed: boolean;
  /** Folder name */
  folderName: string | null;
  /** Account name (e.g. "iCloud") */
  accountName: string | null;
  /** Gzipped protobuf note body (may be null for locked notes) */
  data: Buffer | null;
}

/**
 * Column name mapping for Notes DB — varies across macOS versions.
 * Apple has historically appended generation suffixes when the storage
 * format changes (ZCREATIONDATE → ZCREATIONDATE1 → ZCREATIONDATE3); the
 * provider probes every referenced column once at startup so a new suffix
 * doesn't silently break ingestion.
 */
export interface NotesSchemaColumns {
  /**
   * Set only when the column verifiably exists. A remote deletion (initiated
   * on another device) moves the note into "Recently Deleted" without bumping
   * its modification date; this is the only timestamp that records the move.
   * `null` = absent from this store's schema, and the deletes window falls
   * back to the modification date alone — no guessed name may fabricate
   * tombstones.
   */
  folderModificationDate: string | null;
  creationDate: string;
  modificationDate: string;
  title: string;
  snippet: string;
  folderTitle: string;
  account: string;
  isPasswordProtected: string;
  isPinned: string;
  markedForDeletion: string;
}

/**
 * Info about a discovered Reminders store file and its owning account.
 */
export interface RemindersStoreInfo {
  /** SQLite filename (e.g. "Data-BD7F60DC-FD3B-442E-9C30-3052B5CE6794.sqlite") */
  filename: string;
  /** Open SQLite database handle (readonly) */
  db: import("better-sqlite3").Database;
  /** Resolved iCloud email for this store, if available */
  accountEmail?: string;
  /** Account UUID from the store's ZACCOUNTID blob */
  accountUuid?: string;
}

/**
 * Sync cursor for Apple Contacts source.
 */
export interface AppleContactsSyncCursor extends Record<string, unknown> {
  lastModifiedTimestamp: number;
  /**
   * Secondary cursor key paired with `lastModifiedTimestamp` to form a
   * composite `(modificationDate, uniqueId)` watermark. `ZMODIFICATIONDATE`
   * is a Core Data double and bulk writes (iCloud activation, address-book
   * import) commonly land many records on the identical value; a scalar
   * `> timestamp` cursor would drop every tied row past the page boundary.
   * `ZUNIQUEID` is globally unique and stable across source DBs, so it
   * breaks ties deterministically and lets paging resume mid-timestamp.
   */
  lastUniqueId?: string;
  /**
   * Set on page 1 of a multi-page bootstrap; cleared once the cursor
   * advances past the last bootstrap page (`!hasMore`). Drives
   * operation-level log labelling so pages 2+ aren't mislabelled
   * "incremental" when they're really still the bootstrap walk.
   */
  bootstrapInProgress?: boolean;
  /** Queue size pinned at cycle start; cleared when cycle ends. */
  cycleQueueTotal?: number;
  /**
   * Signature of the snapshot ID set we last reported to the gateway —
   * `"<count>:<maxModificationDate>"` joined per source DB with `|`. Cheap
   * scan runs every cycle; the costly multi-DB enumeration only fires when
   * the signature changed since the previous cycle.
   */
  lastSnapshotSignature?: string;
}

export function isAppleContactsSyncCursor(v: unknown): v is AppleContactsSyncCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (typeof c.lastModifiedTimestamp !== "number") return false;
  if (c.lastUniqueId !== undefined && typeof c.lastUniqueId !== "string") return false;
  if (c.bootstrapInProgress !== undefined && typeof c.bootstrapInProgress !== "boolean")
    return false;
  if (c.cycleQueueTotal !== undefined && typeof c.cycleQueueTotal !== "number") return false;
  if (c.lastSnapshotSignature !== undefined && typeof c.lastSnapshotSignature !== "string")
    return false;
  return true;
}

export const validateAppleContactsSyncCursor = makeCursorValidator(isAppleContactsSyncCursor);

/**
 * Raw contact row from the AddressBook database.
 */
export interface RawContact {
  pk: number;
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
  organization: string | null;
  department: string | null;
  jobTitle: string | null;
  nickname: string | null;
  creationDate: number;
  modificationDate: number;
  uniqueId: string;
  isMe: number | null;
}

/**
 * Raw email address from the AddressBook database.
 */
export interface RawContactEmail {
  ownerPk: number;
  address: string;
  label: string | null;
}

/**
 * Raw phone number from the AddressBook database.
 */
export interface RawContactPhone {
  ownerPk: number;
  fullNumber: string;
  label: string | null;
  countryCode?: string | number | null;
}

/**
 * Raw postal address from `ZABCDPOSTALADDRESS`.
 */
export interface RawContactAddress {
  ownerPk: number;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  label: string | null;
}

/**
 * Raw URL from `ZABCDURLADDRESS`.
 */
export interface RawContactUrl {
  ownerPk: number;
  url: string;
  label: string | null;
}

/**
 * Raw social profile from `ZABCDSOCIALPROFILE`.
 */
export interface RawContactSocial {
  ownerPk: number;
  service: string | null;
  username: string | null;
  url: string | null;
  label: string | null;
}

/**
 * Raw date entry from `ZABCDDATE` (birthdays, anniversaries, custom dates).
 */
export interface RawContactDate {
  ownerPk: number;
  /** Core Data timestamp; some versions use date-only formatted as number. */
  value: number | null;
  label: string | null;
}

/**
 * Sync cursor for Apple Reminders source.
 * Uses the Core Data modification timestamp for incremental sync.
 */
export interface AppleRemindersSyncCursor extends Record<string, unknown> {
  /** Last modification timestamp we synced (Core Data format: seconds since 2001-01-01) */
  lastModifiedTimestamp: number;
  /**
   * Composite tiebreaker: the Z_PK of the last reminder emitted at exactly
   * `lastModifiedTimestamp`. Pagination is a keyset walk over
   * `(ZLASTMODIFIEDDATE, Z_PK)`, so a page boundary that lands in the middle
   * of a run of reminders sharing one identical `ZLASTMODIFIEDDATE` resumes
   * from this PK instead of `> timestamp` (which would skip every tied row
   * past the page slice). Absent / 0 means "no tied row consumed at this
   * timestamp yet" — the next page starts at the first PK.
   */
  lastModifiedPk?: number;
  /** Queue size pinned at cycle start; cleared when cycle ends. */
  cycleQueueTotal?: number;
}

export function isAppleRemindersSyncCursor(v: unknown): v is AppleRemindersSyncCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (typeof c.lastModifiedTimestamp !== "number") return false;
  if (c.lastModifiedPk !== undefined && typeof c.lastModifiedPk !== "number") return false;
  if (c.cycleQueueTotal !== undefined && typeof c.cycleQueueTotal !== "number") return false;
  return true;
}

export const validateAppleRemindersSyncCursor = makeCursorValidator(isAppleRemindersSyncCursor);

/**
 * Raw reminder row from the SQLite database (joined query result).
 */
export interface RawReminder {
  /** Unique identifier (hex-encoded UUID blob) */
  identifier: string;
  /** Reminder title */
  title: string | null;
  /** Reminder notes/body */
  notes: string | null;
  /** Whether completed (0 or 1) */
  completed: number;
  /** Whether flagged (0 or 1) */
  flagged: number;
  /** Priority (0 = none, 1 = high, 5 = medium, 9 = low) */
  priority: number;
  /** Creation date (Core Data timestamp) */
  creationDate: number;
  /** Last modification date (Core Data timestamp) */
  lastModifiedDate: number;
  /** Due date (Core Data timestamp, may be null) */
  dueDate: number | null;
  /** Completion date (Core Data timestamp, may be null) */
  completionDate: number | null;
  /** Whether the due date is all-day */
  allDay: number;
  /** List name */
  listName: string | null;
  /** Whether marked for deletion */
  markedForDeletion: number;
  /** Reminder primary key — used internally to fetch joined hashtag rows. */
  pk: number;
}

/**
 * Sync cursor for Apple Calendar source.
 *
 * A row is picked up when EITHER its modification key advanced past the
 * watermark OR its ROWID is above the insertion high-water mark. The
 * second clause exists because Calendar.app routinely inserts rows with
 * past-valued `last_modified` stamps — subscribed feeds carry a constant
 * pre-2001 (negative Core Data) sentinel, and CalDAV imports copy the
 * server-side LAST-MODIFIED — so a pure modification watermark would
 * never see them. `CalendarItem.ROWID` is AUTOINCREMENT (never reused),
 * which makes the high-water mark sound.
 */
export interface AppleCalendarSyncCursor extends Record<string, unknown> {
  /**
   * Modification watermark (Core Data seconds; may be negative for
   * pre-2001 stamps). The key is `COALESCE(last_modified, creation_date,
   * start_date, 0)`. Promoted to the highest key emitted when a cycle
   * completes.
   */
  lastModifiedTimestamp: number;
  /**
   * ROWID tie-breaker paired with `lastModifiedTimestamp`, so rows
   * sharing the watermark key are not matched again.
   */
  lastModifiedRowId?: number;
  /**
   * Insertion high-water mark: the per-cycle ROWID ceiling of the last
   * completed cycle. Rows above it are swept regardless of their
   * modification key. A regression of the table's AUTOINCREMENT sequence
   * below this value means Calendar.sqlitedb was rebuilt — the source
   * resets to a fresh bootstrap when it detects that.
   */
  insertRowIdHighWater?: number;
  /**
   * ROWID ceiling pinned when the in-flight cycle started (`MAX(ROWID)`
   * over the table). Every page is bounded to `ROWID <= ceiling`, so the
   * cycle's universe is immutable: a row inserted mid-walk — possibly
   * behind the page position, where the walk would never revisit it — is
   * excluded from this cycle and deterministically swept next cycle once
   * `insertRowIdHighWater` is promoted to this value. Present only while
   * `hasMore`.
   */
  cycleRowIdCeiling?: number;
  /**
   * Page position of an in-flight multi-page cycle: the `(modKey, ROWID)`
   * of the last row emitted. Present only while `hasMore`; the membership
   * watermarks above stay pinned for the whole cycle while this advances
   * per page.
   */
  pageModKey?: number;
  pageRowId?: number;
  /**
   * A full re-walk of the filtered set is queued. Scheduled when the
   * snapshot signature's modification-key sum moved while its other
   * components held still — an in-place edit stamped with a past-valued
   * `last_modified` that the watermark cannot see (e.g. CalDAV copying a
   * server-side LAST-MODIFIED that trails the watermark). Cleared when
   * the rescan cycle completes.
   */
  rescanPending?: boolean;
  /**
   * Set on page 1 of a multi-page bootstrap; cleared once the cursor
   * advances past the last bootstrap page (`!hasMore`). Keeps progress
   * labelling honest — pages 2+ are still the bootstrap walk, not
   * "incremental".
   */
  bootstrapInProgress?: boolean;
  /** Queue size pinned at cycle start; cleared when cycle ends. */
  cycleQueueTotal?: number;
  /**
   * Signature of the snapshot ID set we last reported to the gateway —
   * `"<count>:<maxModKey>:<maxRowId>:<sumModKey>"`. The signature query is
   * one cheap aggregate scan; the full ID enumeration only runs when the
   * signature has actually changed since the previous cycle. Each component
   * catches a change class the others miss: count (adds/removes), max key
   * (ordinary edits), max ROWID (equal-count feed swaps — replaced rows get
   * fresh AUTOINCREMENT ROWIDs while their modification keys sit at the
   * same constant sentinel), and key sum (in-place edits stamped with a
   * past-valued `last_modified`, which trigger the one-shot rescan).
   */
  lastSnapshotSignature?: string;
}

export function isAppleCalendarSyncCursor(v: unknown): v is AppleCalendarSyncCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (typeof c.lastModifiedTimestamp !== "number") return false;
  for (const key of [
    "lastModifiedRowId",
    "insertRowIdHighWater",
    "cycleRowIdCeiling",
    "pageModKey",
    "pageRowId",
    "cycleQueueTotal",
  ]) {
    if (c[key] !== undefined && typeof c[key] !== "number") return false;
  }
  for (const key of ["rescanPending", "bootstrapInProgress"]) {
    if (c[key] !== undefined && typeof c[key] !== "boolean") return false;
  }
  if (c.lastSnapshotSignature !== undefined && typeof c.lastSnapshotSignature !== "string")
    return false;
  return true;
}

export const validateAppleCalendarSyncCursor = makeCursorValidator(isAppleCalendarSyncCursor);

/**
 * Raw event row from the Calendar database (joined query result).
 */
export interface RawCalendarEvent {
  /** Primary key (CalendarItem.ROWID) */
  pk: number;
  /** Stable per-event identifier (CalendarItem.UUID) */
  uuid: string;
  /** Event title */
  summary: string | null;
  /** Event notes/description */
  description: string | null;
  /** Start date (Core Data timestamp) */
  startDate: number | null;
  /** Start timezone (IANA name, or "_float" for floating times) */
  startTz: string | null;
  /** End date (Core Data timestamp) */
  endDate: number | null;
  /** End timezone */
  endTz: string | null;
  /** Whether the event is all-day (0 or 1) */
  allDay: number;
  /** Event status */
  status: number;
  /** URL attached to the event */
  url: string | null;
  /** Conference URL (explicit field) */
  conferenceUrl: string | null;
  /** Conference URL detected from the event body */
  conferenceUrlDetected: string | null;
  /** ROWID of the series master when this row is a detached occurrence */
  origItemId: number;
  /** RFC 5545 iCal UID (CalendarItem.unique_identifier) */
  iCalUid: string | null;
  /** Creation date (Core Data timestamp; NULL for subscribed-feed events) */
  creationDate: number | null;
  /** Modification key — COALESCE(last_modified, creation_date, start_date, 0) */
  modKey: number;
  /** Owning calendar identifier (Calendar.UUID) */
  calendarUuid: string | null;
  /** Owning calendar title */
  calendarTitle: string | null;
  /** Owning store/account name (e.g. "iCloud") */
  storeName: string | null;
  /** Owning store type (0 local, 2 iCloud/CalDAV, 4 subscribed, …) */
  storeType: number;
  /** Location title */
  locationTitle: string | null;
  /** Location address */
  locationAddress: string | null;
  /** Organizer email (Participant.email) */
  organizerEmail: string | null;
  /** Organizer phone (Participant.phone_number) */
  organizerPhone: string | null;
  /** Organizer display name (Identity.display_name) */
  organizerName: string | null;
  /** Organizer identity address (often a `mailto:` URI) */
  organizerAddress: string | null;
}

/**
 * Raw attendee row from the Participant table (batched per page).
 */
export interface RawCalendarParticipant {
  /** CalendarItem.ROWID this participant belongs to */
  ownerId: number;
  /** Attendee email */
  email: string | null;
  /** Attendee phone number */
  phone: string | null;
  /** Display name from the joined Identity row */
  displayName: string | null;
  /** Identity address (often a `mailto:` URI) */
  address: string | null;
}

/**
 * Raw recurrence rule row from the Recurrence table (batched per page).
 */
export interface RawCalendarRecurrence {
  /** CalendarItem.ROWID of the series master */
  ownerId: number;
  /** Frequency (1 daily, 2 weekly, 3 monthly, 4 yearly) */
  frequency: number;
  /** Interval between occurrences (e.g. 2 = every 2 weeks) */
  repeatInterval: number | null;
  /** Max number of occurrences (0/NULL = unbounded) */
  repeatCount: number | null;
  /** Series end date (Core Data timestamp, NULL = unbounded) */
  endDate: number | null;
}

/**
 * Sync cursor for the Apple Call Log source.
 *
 * `CallHistory.storedata` has no delete tombstone column (calls aren't
 * user-editable the way Notes/Reminders are), so — like Apple Calendar —
 * deletion detection rides pure snapshot reconciliation, and rows can
 * arrive with a past-valued `ZDATE` (iCloud call-history sync backfilling
 * an offline period), so membership needs an insertion high-water mark on
 * `Z_PK` in addition to the modification watermark.
 *
 * Day documents reconcile in a bounded keyset walk after analytics paging.
 * A streamed content signature detects changes that neither watermark sees.
 * Legacy `affectedDates` cursors remain readable and receive a canonical walk.
 */
export interface AppleCallLogSyncCursor extends Record<string, unknown> {
  /** Modification watermark — Core Data `ZDATE` (seconds since 2001-01-01). */
  lastModifiedTimestamp: number;
  /** Z_PK tie-breaker paired with `lastModifiedTimestamp`. */
  lastModifiedRowId?: number;
  /**
   * Insertion high-water mark: the per-cycle Z_PK ceiling of the last
   * completed cycle. Rows above it are swept regardless of `ZDATE`,
   * catching backdated/backfilled call-history-sync rows the
   * modification watermark alone would miss.
   */
  insertRowIdHighWater?: number;
  /** Z_PK ceiling pinned when the in-flight cycle started. */
  cycleRowIdCeiling?: number;
  /** Page position of an in-flight multi-page cycle: `(ZDATE, Z_PK)` of the last row emitted. */
  pageModKey?: number;
  pageRowId?: number;
  bootstrapInProgress?: boolean;
  /** Queue size pinned at cycle start; cleared when cycle ends. */
  cycleQueueTotal?: number;
  /**
   * Content signature at the last completed day reconciliation. Legacy
   * count/max/sum signatures remain accepted and force a canonical walk.
   */
  lastSnapshotSignature?: string;
  /** Legacy in-flight day list; accepted but replaced by a bounded keyset walk. */
  affectedDates?: string[];
  /** Completed a canonical day rebuild, including summaries written by older cursors. */
  dayReconciliationComplete?: boolean;
  /** Bounded keyset walk: no per-day signatures or pending document bodies in the cursor. */
  dayReconciliation?: {
    afterDay: string;
    signature: string;
  };
}

export function isAppleCallLogSyncCursor(v: unknown): v is AppleCallLogSyncCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  if (typeof c.lastModifiedTimestamp !== "number") return false;
  for (const key of [
    "lastModifiedRowId",
    "insertRowIdHighWater",
    "cycleRowIdCeiling",
    "pageModKey",
    "pageRowId",
    "cycleQueueTotal",
  ]) {
    if (c[key] !== undefined && typeof c[key] !== "number") return false;
  }
  if (c.bootstrapInProgress !== undefined && typeof c.bootstrapInProgress !== "boolean")
    return false;
  if (c.lastSnapshotSignature !== undefined && typeof c.lastSnapshotSignature !== "string")
    return false;
  if (c.affectedDates !== undefined) {
    if (!Array.isArray(c.affectedDates) || !c.affectedDates.every((d) => typeof d === "string"))
      return false;
  }
  if (c.dayReconciliationComplete !== undefined && typeof c.dayReconciliationComplete !== "boolean")
    return false;
  if (c.dayReconciliation !== undefined) {
    if (!c.dayReconciliation || typeof c.dayReconciliation !== "object") return false;
    const scan = c.dayReconciliation as Record<string, unknown>;
    if (
      typeof scan.afterDay !== "string" ||
      (scan.afterDay !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(scan.afterDay)) ||
      typeof scan.signature !== "string"
    )
      return false;
  }
  return true;
}

export const validateAppleCallLogSyncCursor = makeCursorValidator(isAppleCallLogSyncCursor);

export interface AppleVoicemailSyncCursor extends Record<string, unknown> {
  /** Normalized-output hash per UTC day in the last complete snapshot. */
  daySignatures: Record<string, string>;
}

export function isAppleVoicemailSyncCursor(value: unknown): value is AppleVoicemailSyncCursor {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).daySignatures === "object" &&
    (value as Record<string, unknown>).daySignatures !== null &&
    Object.values((value as AppleVoicemailSyncCursor).daySignatures).every(
      (signature) => typeof signature === "string",
    )
  );
}

export const validateAppleVoicemailSyncCursor = makeCursorValidator(isAppleVoicemailSyncCursor);

/** Raw carrier voicemail from Phone.app's ZSTOREDMESSAGE table. */
export interface RawVoicemailRecord {
  pk: number;
  isRead: number;
  dateCreated: number;
  dateModified: number;
  duration: number;
  caller: string | null;
  recordUuid: Buffer;
  transcriptData: Buffer | null;
}

/**
 * Raw call row from `ZCALLRECORD` (macOS 26.3.1 schema — column names and
 * semantics verified empirically; see `call-log.ts` for the
 * `ZANSWERED`/`ZORIGINATED` classification nuance).
 */
export interface RawCallRecord {
  /** Primary key (ZCALLRECORD.Z_PK) */
  pk: number;
  /** Stable per-call identifier (ZCALLRECORD.ZUNIQUE_ID) */
  uniqueId: string;
  /** Peer identifier — phone number or Apple ID email, plaintext */
  address: string | null;
  isoCountryCode?: string | null;
  /** Cached counterparty display name, if Apple had one at call time */
  name: string | null;
  /** Call date (Core Data timestamp, seconds since 2001-01-01) */
  date: number;
  /** Duration in seconds (0 for missed/unanswered/undialed calls) */
  duration: number;
  /** 1 = outgoing (self-placed), 0 = incoming */
  originated: number;
  /**
   * 1 = picked up. Only meaningful for incoming calls (`originated = 0`) —
   * verified empirically to be unreliable for outgoing calls (0 despite
   * nonzero duration). See `call-log.ts`'s `isConnected`.
   */
  answered: number;
  /**
   * `ZCALLRECORD.ZDISCONNECTED_CAUSE`, NULL when the store's schema predates
   * the column (the source selects NULL then). Incoming calls answered on a
   * different Apple device show `1` with ~zero duration; calls answered with
   * real talk time carry NULL. See `call-log.ts`'s `isAnsweredElsewhere`.
   */
  disconnectedCause: number | null;
  /** `com.apple.Telephony` | `com.apple.FaceTime` (only two values observed) */
  serviceProvider: string | null;
  /** Voice=1; FaceTime video/audio variants observed as 16/8 */
  callType: number | null;
  callCategory: number | null;
}
