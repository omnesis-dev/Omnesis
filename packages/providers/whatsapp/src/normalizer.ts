// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  computeContentHash,
  normalizePhone,
  extractEmailsFromText,
  extractPhonesFromText,
  parseSourceKey,
  formatLid,
  WHATSAPP_LID_PLATFORM,
} from "@omnesis/core";
import { ProviderId, SourceId } from "@omnesis/types";
import type {
  DocumentInput,
  ProviderId as ProviderIdType,
  SourceId as SourceIdType,
  PersonMention,
} from "@omnesis/types";
import type { StoredMessage, StoredChat, StoredContact } from "./types.js";

/**
 * Build a reverse index from `<lid>@lid` JID → contact. The primary
 * `contacts` map is keyed by the contact's *primary* JID, which for
 * normal users is the phone JID (`<phone>@s.whatsapp.net`). Messages in
 * groups (and increasingly in 1:1s) arrive with `senderJid = <lid>@lid`,
 * so a direct `contacts.get(senderJid)` misses entries that we *do*
 * already have a real name for under the phone-JID key.
 *
 * Without this, dozens of contacts whose names WhatsApp pushed to us
 * via `contacts.upsert` (Baileys exposes the `lid` field on each
 * contact) render as the opaque `LID xxx…` fallback, and their
 * canonical_name in the gateway's people table reflects that label
 * instead of the real name we already had on disk.
 */
export function buildContactsByLidJid(
  contacts: Map<string, StoredContact>,
): Map<string, StoredContact> {
  const out = new Map<string, StoredContact>();
  for (const c of contacts.values()) {
    if (!c.lid) continue;
    const lidJid = c.lid.endsWith("@lid") ? c.lid : `${c.lid}@lid`;
    out.set(lidJid, c);
  }
  return out;
}

/**
 * Resolve a display name for a JID.
 * Prefers: contact name > chat name > push name > JID-aware fallback.
 *
 * For `@lid` JIDs we additionally consult `contactsByLidJid` because
 * the primary `contacts` map is keyed by phone JID. See
 * `buildContactsByLidJid` for the rationale.
 *
 * JID-aware fallback distinguishes between real phone JIDs
 * (`<digits>@s.whatsapp.net`) and opaque participant LIDs
 * (`<digits>@lid`). LIDs are NOT phone numbers — rendering them as
 * `+<digits>` fabricates a fake phone-shaped string that downstream
 * alias-typing then writes into `person_aliases` as
 * `alias_type='name'`, polluting people-resolution. The lid → real-phone
 * map provided by the source layer (built from Baileys `lid_pn_match`
 * events) is the right resolution path; when it has no entry, fall back
 * to a stable `LID …` label that's clearly not a phone.
 */
export function resolveDisplayName(
  jid: string,
  fromMe: boolean,
  senderName: string,
  contacts: Map<string, StoredContact>,
  chat?: StoredChat,
  lidPhoneMap?: Map<string, string>,
  contactsByLidJid?: Map<string, StoredContact>,
): string {
  if (fromMe) return "You";

  // Direct contact lookup. The user's saved address-book name wins, then the
  // contact's self-set pushName, then the business/verified display name (the
  // only real label a business contact with no saved name carries).
  const direct = contacts.get(jid);
  if (direct?.name) return direct.name;
  if (direct?.pushName) return direct.pushName;
  if (direct?.verifiedName) return direct.verifiedName;

  // Reverse lookup: contact whose `.lid` matches this @lid JID
  if (jid.endsWith("@lid") && contactsByLidJid) {
    const viaLid = contactsByLidJid.get(jid);
    if (viaLid?.name) return viaLid.name;
    if (viaLid?.pushName) return viaLid.pushName;
    if (viaLid?.verifiedName) return viaLid.verifiedName;
  }

  // Use sender's push name from the message
  if (senderName) return senderName;

  // Use chat name for 1:1 chats
  if (chat && !chat.isGroup) return chat.name;

  // JID-aware fallback. Phone JIDs render as `+<digits>` (the digits ARE
  // a real phone). LID JIDs are opaque participant identifiers — render
  // through the lid → phone map when available, otherwise as a stable
  // non-phone-shaped `LID …` label so the gateway doesn't mistype it.
  if (jid.endsWith("@lid")) {
    const lid = jid.split("@")[0];
    const phone = lidPhoneMap?.get(lid);
    if (phone) return phone;
    return lid ? `LID ${lid.slice(0, 8)}…` : jid;
  }
  if (jid.endsWith("@s.whatsapp.net")) {
    const phone = jid.split("@")[0];
    return phone ? `+${phone}` : jid;
  }
  // Unknown JID shape — return the raw JID rather than fabricate a
  // pseudo-phone, so it doesn't leak into people-resolution.
  return jid;
}

/**
 * True if a string looks like a raw JID rather than a human name. WhatsApp
 * sometimes stores the JID itself as `chat.name` for LID-only contacts
 * that were never given a real name — those should not become titles or
 * display names.
 */
function isJidShaped(s: string): boolean {
  return (
    s.endsWith("@lid") ||
    s.endsWith("@s.whatsapp.net") ||
    s.endsWith("@g.us") ||
    s.endsWith("@broadcast")
  );
}

/**
 * Build the document's `sourceUrl` for a WhatsApp conversation.
 *
 * Only 1:1 chats keyed by a real phone JID (`<digits>@s.whatsapp.net`)
 * get a deep link, via the documented `whatsapp://send?phone=<E.164>`
 * scheme. Groups (`@g.us`), LID-only chats (`@lid`), and broadcasts
 * have no public deep-link form — `whatsapp://chat?jid=…` is not part
 * of WhatsApp's URL scheme and the desktop app silently ignores the
 * `jid` query, opening whatever chat it happened to have focused. We
 * return `undefined` in those cases so the UI hides the "open in
 * source" affordance (or falls back to the in-app document viewer in
 * agent surfaces) instead of producing a misleading link.
 */
export function whatsappSourceUrl(chatJid: string): string | undefined {
  if (!chatJid.endsWith("@s.whatsapp.net")) return undefined;
  const phone = chatJid.slice(0, -"@s.whatsapp.net".length);
  if (!/^\d+$/.test(phone)) return undefined;
  return `whatsapp://send?phone=${phone}`;
}

/**
 * Resolve the best display name for the *other party* in a 1:1 chat.
 * Used for both the document title and the structured PersonMention so
 * the gateway people resolver can match the same person across documents
 * via their LID even when only the group chat carries their human name.
 *
 * Priority: contact name → contact push name → chat.name (only if not
 * JID-shaped) → first non-self message's senderName → JID-aware fallback.
 * Chat names are user-set via WhatsApp's "Edit name" and are more
 * authoritative than the sender's self-reported pushName, but we skip
 * them when they're just the raw JID (Baileys' default for LID-only
 * contacts that were never given a real name).
 */
/**
 * Resolve a fallback display name for a *group* chat when WhatsApp
 * never gave us a real `chat.name` (Baileys stores the JID itself as
 * `name` for groups whose metadata never arrived). Derives a name from
 * the group's participants — top 3 distinct non-self display names plus
 * a `+N` overflow count — so the title reads
 * `Hugo, Eve, Nora +2 (group) — 2026-04-25` instead of
 * `33639980456-1604073028@g.us (group) — 2026-04-25`.
 *
 * Returns chat.name unchanged when it's already a real (non-JID) name.
 */
function resolveGroupFallbackName(
  chatJid: string,
  messages: StoredMessage[],
  chat: StoredChat | undefined,
  contacts: Map<string, StoredContact>,
  lidPhoneMap: Map<string, string>,
  contactsByLidJid: Map<string, StoredContact>,
  isSelfJid: (jid: string) => boolean,
): string {
  if (chat?.name && !isJidShaped(chat.name)) return chat.name;

  // Pick one display name per participant JID. Process messages first
  // (their senderName usually beats the JID-aware fallback we'd get
  // from a roster member with no contact info), then fill in roster
  // members who didn't speak today.
  const byJid = new Map<string, string>();
  const remember = (jid: string, name: string): void => {
    if (!name || name === "You") return;
    if (byJid.has(jid)) return;
    byJid.set(jid, name);
  };
  for (const msg of messages) {
    if (msg.type === "system" || msg.fromMe || isSelfJid(msg.senderJid)) continue;
    remember(
      msg.senderJid,
      resolveDisplayName(
        msg.senderJid,
        false,
        msg.senderName,
        contacts,
        chat,
        lidPhoneMap,
        contactsByLidJid,
      ),
    );
  }
  if (chat?.participants) {
    for (const memberJid of chat.participants) {
      if (isSelfJid(memberJid)) continue;
      remember(
        memberJid,
        resolveDisplayName(memberJid, false, "", contacts, chat, lidPhoneMap, contactsByLidJid),
      );
    }
  }

  // De-dupe by display name (different JIDs occasionally resolve to the
  // same name, e.g. multi-device) and sort alphabetically so the title
  // is stable across days as long as the group membership is — without
  // this, the same group renders dozens of distinct titles depending on
  // who happened to speak that day, which fragments search and inflates
  // index churn.
  const distinct = Array.from(new Set(byJid.values())).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );

  if (distinct.length === 0) return chatJid.split("@")[0];
  const top = distinct.slice(0, 3);
  const rest = distinct.length - top.length;
  return rest > 0 ? `${top.join(", ")} +${rest}` : top.join(", ");
}

function resolveOneToOnePartyName(
  chatJid: string,
  messages: StoredMessage[],
  chat: StoredChat | undefined,
  contacts: Map<string, StoredContact>,
  lidPhoneMap: Map<string, string>,
  contactsByLidJid: Map<string, StoredContact>,
): string {
  const direct = contacts.get(chatJid);
  if (direct?.name) return direct.name;
  if (direct?.pushName) return direct.pushName;
  if (direct?.verifiedName) return direct.verifiedName;
  if (chatJid.endsWith("@lid")) {
    const viaLid = contactsByLidJid.get(chatJid);
    if (viaLid?.name) return viaLid.name;
    if (viaLid?.pushName) return viaLid.pushName;
    if (viaLid?.verifiedName) return viaLid.verifiedName;
  }
  if (chat?.name && !isJidShaped(chat.name)) return chat.name;
  for (const msg of messages) {
    if (!msg.fromMe && msg.type !== "system" && msg.senderName) return msg.senderName;
  }
  return resolveDisplayName(chatJid, false, "", contacts, undefined, lidPhoneMap, contactsByLidJid);
}

/**
 * Format a timestamp as HH:MM for display in chat content.
 */
function formatTime(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  return d.toTimeString().slice(0, 5); // HH:MM
}

/**
 * Render a single message as a markdown line.
 */
function renderMessage(
  msg: StoredMessage,
  contacts: Map<string, StoredContact>,
  chat?: StoredChat,
  lidPhoneMap?: Map<string, string>,
  contactsByLidJid?: Map<string, StoredContact>,
): string {
  const sender = resolveDisplayName(
    msg.senderJid,
    msg.fromMe,
    msg.senderName,
    contacts,
    chat,
    lidPhoneMap,
    contactsByLidJid,
  );
  const time = formatTime(msg.timestamp);

  // Handle quoted/reply messages
  let quoteLine = "";
  if (msg.quotedText) {
    const quoteSender = msg.quotedSender
      ? resolveDisplayName(msg.quotedSender, false, "", contacts, chat, undefined, contactsByLidJid)
      : "someone";
    quoteLine = `> _${quoteSender}: ${msg.quotedText.split("\n")[0]}_\n`;
  }

  switch (msg.type) {
    case "text":
      return `${quoteLine}**${time}** ${sender}: ${msg.text}`;

    case "image": {
      const caption = msg.text ? ` ${msg.text}` : "";
      const filename = msg.media?.filename ?? "photo";
      return `${quoteLine}**${time}** ${sender}: [Image: ${filename}]${caption}`;
    }

    case "video": {
      const caption = msg.text ? ` ${msg.text}` : "";
      const duration = msg.media?.seconds
        ? ` ${Math.floor(msg.media.seconds / 60)}:${String(msg.media.seconds % 60).padStart(2, "0")}`
        : "";
      return `${quoteLine}**${time}** ${sender}: [Video${duration}]${caption}`;
    }

    case "audio": {
      const duration = msg.media?.seconds
        ? `${Math.floor(msg.media.seconds / 60)}:${String(msg.media.seconds % 60).padStart(2, "0")}`
        : "?";
      const label = msg.media?.isVoiceNote ? "Voice note" : "Audio";
      // A transcribed voice note renders its spoken text after the placeholder,
      // so it becomes part of the indexed/searchable conversation content. An
      // empty transcript (no speech detected) keeps just the placeholder.
      const transcript = msg.transcript?.trim();
      if (transcript) {
        return `${quoteLine}**${time}** ${sender}: [${label}, ${duration}]: ${transcript}`;
      }
      // Terminal download failure (audio gone from the CDN/phone, no transcript)
      // — say so explicitly instead of a bare placeholder that looks identical to
      // a note still awaiting transcription.
      const suffix = msg.mediaState === "unavailable" ? " — audio unavailable" : "";
      return `${quoteLine}**${time}** ${sender}: [${label}, ${duration}${suffix}]`;
    }

    case "document": {
      const filename = msg.media?.filename ?? "file";
      return `${quoteLine}**${time}** ${sender}: [Document: ${filename}]`;
    }

    case "sticker":
      return `**${time}** ${sender}: [Sticker]`;

    case "media": {
      // A media message whose specific kind we can't determine (a newer media
      // type, or media whose file is no longer downloaded — e.g. expired or
      // view-once). Render a generic placeholder plus any caption.
      const caption = msg.text ? ` ${msg.text}` : "";
      return `${quoteLine}**${time}** ${sender}: [Media]${caption}`;
    }

    case "location":
      return `${quoteLine}**${time}** ${sender}: [Location] ${msg.text}`;

    case "contact":
      return `${quoteLine}**${time}** ${sender}: [Contact] ${msg.text}`;

    case "reaction":
      return `**${time}** ${sender}: ${msg.reactionEmoji} _(reaction)_`;

    case "system":
      return `**${time}** _${msg.text}_`;

    default:
      return msg.text
        ? `${quoteLine}**${time}** ${sender}: ${msg.text}`
        : `**${time}** ${sender}: [${msg.type}]`;
  }
}

/**
 * Build a document title from chat info and date. Callers pass a
 * resolved chat name (1:1 other-party name or derived group name) so
 * titles read e.g. `Anton — 2026-04-23` or
 * `Hugo, Eve, Nora +2 (group) — 2026-04-25` instead of leaking
 * raw JIDs when WhatsApp's `chat.name` is unset or stored as the JID
 * itself.
 */
function buildTitle(
  chat: StoredChat | undefined,
  chatJid: string,
  date: string,
  resolvedChatName?: string,
): string {
  const chatName = resolvedChatName ?? chat?.name ?? chatJid.split("@")[0];
  const suffix = chat?.isGroup ? " (group)" : "";
  return `${chatName}${suffix} — ${date}`;
}

/**
 * Normalize a set of messages from one chat on one day into a DocumentInput.
 */
export function normalizeDayChat(
  chatJid: string,
  date: string,
  messages: StoredMessage[],
  chat: StoredChat | undefined,
  contacts: Map<string, StoredContact>,
  providerId: ProviderIdType = ProviderId("whatsapp"),
  sourceId: SourceIdType = SourceId("whatsapp-messages"),
  lidPhoneMap: Map<string, string> = new Map(),
  // Optional pre-built `<lid>@lid → contact` index. The caller builds it once
  // per sync page (it depends only on `contacts`, which is invariant across the
  // page) to avoid paying O(totalContacts) per day-chat — important now that
  // resync / backfill re-render the whole archive in 200-day-chat pages.
  prebuiltContactsByLidJid?: Map<string, StoredContact>,
): DocumentInput {
  // Classify the chat by JID shape — used in several places below
  // (self-JID handling, 1:1 other-party resolution, group seeding).
  const isGroupJid = chatJid.endsWith("@g.us") || chatJid.endsWith("@broadcast");
  const isOneToOneJid =
    !isGroupJid && (chatJid.endsWith("@s.whatsapp.net") || chatJid.endsWith("@lid"));

  // A `<lid>@lid → contact` reverse index, reused by every resolveDisplayName
  // call below so messages from a contact whose LID we already know render with
  // their real name instead of the opaque `LID xxx…` label.
  const contactsByLidJid = prebuiltContactsByLidJid ?? buildContactsByLidJid(contacts);

  // Pre-compute self detection. Needed both for the roster pass below
  // and for the group title fallback (which excludes self when deriving
  // a name from participants).
  const accountIdEarly = parseSourceKey(String(sourceId)).accountId;
  const selfPhoneEarly = accountIdEarly ? (normalizePhone(accountIdEarly) ?? undefined) : undefined;
  const selfBareJid = selfPhoneEarly
    ? `${selfPhoneEarly.replace(/^\+/, "")}@s.whatsapp.net`
    : undefined;
  const selfLidJids = new Set<string>();
  if (selfPhoneEarly) {
    for (const [lid, phone] of lidPhoneMap) {
      if (phone === selfPhoneEarly) selfLidJids.add(`${lid}@lid`);
    }
  }
  const isSelfJid = (jid: string) => jid === selfBareJid || selfLidJids.has(jid);

  // Resolve the chat name shown in the title. For 1:1 chats: contact
  // name → first non-self senderName → chat.name → JID-aware label.
  // For groups whose chat.name is JID-shaped (Baileys default for
  // groups whose metadata never arrived): top 3 participant names with
  // overflow count.
  const resolvedChatName = isOneToOneJid
    ? resolveOneToOnePartyName(chatJid, messages, chat, contacts, lidPhoneMap, contactsByLidJid)
    : isGroupJid
      ? resolveGroupFallbackName(
          chatJid,
          messages,
          chat,
          contacts,
          lidPhoneMap,
          contactsByLidJid,
          isSelfJid,
        )
      : undefined;

  const title = buildTitle(chat, chatJid, date, resolvedChatName);

  // Collect unique participants. For groups with a known roster, seed from
  // the full member list so people who didn't speak that day still appear.
  const participantSet = new Set<string>();
  if (chat?.isGroup && chat.participants) {
    for (const memberJid of chat.participants) {
      const name = isSelfJid(memberJid)
        ? "You"
        : resolveDisplayName(memberJid, false, "", contacts, chat, lidPhoneMap, contactsByLidJid);
      participantSet.add(name);
    }
  }
  for (const msg of messages) {
    if (msg.type === "system") continue;
    const name = resolveDisplayName(
      msg.senderJid,
      msg.fromMe,
      msg.senderName,
      contacts,
      chat,
      lidPhoneMap,
      contactsByLidJid,
    );
    participantSet.add(name);
  }

  // Separate reactions from regular messages
  const regularMessages = messages.filter((m) => m.type !== "reaction");
  const reactions = messages.filter((m) => m.type === "reaction");

  // Render content
  const lines = [`# ${title}`, ""];

  for (const msg of regularMessages) {
    lines.push(renderMessage(msg, contacts, chat, lidPhoneMap, contactsByLidJid));
  }

  // Append reactions as a summary if there are any
  if (reactions.length > 0) {
    lines.push("");
    for (const r of reactions) {
      lines.push(renderMessage(r, contacts, chat, lidPhoneMap, contactsByLidJid));
    }
  }

  const content = lines.join("\n");
  const contentHash = computeContentHash(content);

  // Use first message timestamp as sourceCreatedAt, last as sourceUpdatedAt
  const firstTs = messages[0].timestamp;
  const lastTs = messages[messages.length - 1].timestamp;

  // Count media messages
  const mediaCount = messages.filter((m) =>
    ["image", "video", "audio", "document", "sticker"].includes(m.type),
  ).length;

  // Build people array from participants
  const participantPhones = new Set<string>();
  const people: PersonMention[] = [];
  const seenJids = new Set<string>();

  // Helper to add a participant by JID
  const addParticipant = (senderJid: string, fromMe: boolean, senderName: string) => {
    if (seenJids.has(senderJid)) return;
    seenJids.add(senderJid);

    const name = resolveDisplayName(
      senderJid,
      fromMe,
      senderName,
      contacts,
      chat,
      lidPhoneMap,
      contactsByLidJid,
    );

    let phoneValue: string | undefined;
    let lidValue: string | undefined;

    if (senderJid.endsWith("@s.whatsapp.net")) {
      const jidPhone = senderJid.split("@")[0];
      phoneValue = normalizePhone("+" + jidPhone) ?? undefined;
    } else if (senderJid.endsWith("@lid")) {
      lidValue = senderJid.split("@")[0];
      phoneValue = lidPhoneMap.get(lidValue);
      // Fall back to the contact's phoneNumber field (Baileys populates
      // this on `contacts.upsert` for known LID-mapped contacts) when
      // the lid_pn_match-driven map hasn't seen this LID yet. This also
      // lets the gateway people resolver merge LID-only mentions with
      // phone-based people from other sources (iMessage etc).
      if (!phoneValue) {
        const viaLid = contactsByLidJid.get(senderJid);
        const phoneJid = viaLid?.jid;
        if (phoneJid?.endsWith("@s.whatsapp.net")) {
          phoneValue = normalizePhone("+" + phoneJid.split("@")[0]) ?? undefined;
        }
      }
    }

    // For self, fall back to account phone from sourceId
    if (fromMe && !phoneValue) {
      const { accountId } = parseSourceKey(String(sourceId));
      if (accountId) phoneValue = normalizePhone(accountId) ?? undefined;
    }

    if (phoneValue) participantPhones.add(phoneValue);

    people.push({
      role: "participant",
      name,
      phones: phoneValue ? [phoneValue] : undefined,
      // Namespaced on the way out only: `lidValue` is also the key of the
      // LID→phone map above, which is keyed by the raw JID local part.
      lids: lidValue ? [formatLid(WHATSAPP_LID_PLATFORM, lidValue)] : undefined,
    });
  };

  // Always add self as participant
  const selfPhone = selfPhoneEarly;
  people.push({
    role: "participant",
    name: "You",
    phones: selfPhone ? [selfPhone] : undefined,
  });
  if (selfPhone) participantPhones.add(selfPhone);
  // In groups, fromMe messages carry the user's own JID as senderJid
  // (`msg.key.participant`), which may include a device suffix not in
  // selfLidJids — mark it as seen so we don't add self twice. In 1:1
  // chats Baileys reports `senderJid = remoteJid = chatJid` for fromMe
  // messages — i.e. the OTHER party's JID — so the same logic would
  // silently drop the other participant. Skip it for non-groups.
  if (isGroupJid) {
    for (const msg of messages) {
      if (msg.fromMe) {
        seenJids.add(msg.senderJid);
        break;
      }
    }
  }
  // Roster JIDs use bare form (no device suffix) — guard against re-adding self
  // under their phone number when seeding from the group roster.
  if (selfBareJid) seenJids.add(selfBareJid);
  for (const lidJid of selfLidJids) seenJids.add(lidJid);

  // For 1:1 chats, add the other party from the chat JID, using the
  // pre-resolved name so the structured PersonMention carries "Anton"
  // (from message senderName) rather than the chat row's stored JID.
  if (isOneToOneJid) {
    addParticipant(chatJid, false, resolvedChatName ?? "");
  }

  // For groups with a known roster, seed all members before iterating messages
  // so people who didn't speak that day still appear as participants.
  if (chat?.isGroup && chat.participants) {
    for (const memberJid of chat.participants) {
      addParticipant(memberJid, false, "");
    }
  }

  // Add participants from messages. Skip fromMe — self is preadded as
  // "You" above and `msg.senderJid` for fromMe messages is unreliable
  // (Baileys reports `chatJid` for non-groups and may carry a
  // device-suffixed JID for groups), so re-running addParticipant on it
  // either drops the other party (1:1) or fabricates a duplicate self
  // entry under a phone-shaped name.
  for (const msg of messages) {
    if (msg.type === "system") continue;
    if (msg.fromMe) continue;
    addParticipant(msg.senderJid, msg.fromMe, msg.senderName);
  }

  // Extract mentioned emails and phones from content. Drop any mention
  // whose identifier (email or phone) already appears on a participant
  // — the participant entry is canonical and the redundant `mentioned`
  // would just be UI noise and an extra DB row pointing at the same
  // person.
  const participantEmails = new Set(people.flatMap((p) => p.emails ?? []));
  const mentionedEmails = extractEmailsFromText(content);
  for (const email of mentionedEmails) {
    if (participantEmails.has(email)) continue;
    people.push({ role: "mentioned", emails: [email] });
    participantEmails.add(email);
  }
  const mentionedPhones = extractPhonesFromText(content);
  for (const phone of mentionedPhones) {
    if (participantPhones.has(phone)) continue;
    people.push({ role: "mentioned", phones: [phone], allowPersonCreation: false });
    participantPhones.add(phone);
  }

  return {
    providerId,
    sourceId: sourceId,
    externalId: `${chatJid}:${date}`,
    title,
    content,
    contentHash,
    metadata: {
      sourceUrl: whatsappSourceUrl(chatJid),
      tags: chat?.isGroup ? ["group"] : [],
      documentType: "conversation",
      people,
      extra: {
        chatJid,
        chatName: chat?.name,
        isGroup: chat?.isGroup ?? false,
        messageCount: regularMessages.length,
        mediaCount,
        participants: Array.from(participantSet),
        date,
      },
    },
    sourceCreatedAt: new Date(firstTs * 1000).toISOString(),
    sourceUpdatedAt: new Date(lastTs * 1000).toISOString(),
  };
}
