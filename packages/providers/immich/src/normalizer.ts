// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  cleanPersonName,
  computeContentHash,
  normalizeTimeZone,
  utcOffsetLabel,
} from "@omnesis/core";
import type { DocumentInput, PersonMention, ProviderId, SourceId } from "@omnesis/types";
import type { ImmichAlbumIndex, ImmichAsset } from "./types.js";

/** The longest description carried into a title before it is cut. */
const MAX_TITLE_LEN = 120;
/** Descriptions are typed by hand and rarely long; this bounds a pathological one. */
const MAX_DESCRIPTION_LEN = 8_000;

/** Everything about the account an asset is normalized for. */
export interface ImmichNormalizeContext {
  providerId: ProviderId;
  sourceId: SourceId;
  /** The normalized base URL the deep link is built on. */
  baseUrl: string;
  /** The Immich user id the API key belongs to. */
  userId: string;
  albums?: ImmichAlbumIndex;
}

/** Whether an asset becomes a document at all. */
export function isIndexableAsset(asset: ImmichAsset): boolean {
  // A live photo's motion part is a hidden VIDEO next to its still; the still
  // is the asset the user sees. Locked assets sit behind a PIN in Immich and
  // stay out of search; the API never returns them unasked, and they would
  // not be indexed if it did.
  if (asset.visibility === "hidden" || asset.visibility === "locked") return false;
  return asset.type === "IMAGE" || asset.type === "VIDEO";
}

/** The asset's web page on its server. */
export function assetUrl(baseUrl: string, assetId: string): string {
  return `${baseUrl}/photos/${assetId}`;
}

/** The capture instant, UTC. EXIF when the file carries it, the file's own date otherwise. */
function capturedAt(asset: ImmichAsset): string {
  const exif = asset.exifInfo?.dateTimeOriginal;
  const candidate = exif && Number.isFinite(Date.parse(exif)) ? exif : asset.fileCreatedAt;
  return new Date(candidate).toISOString();
}

/**
 * The capture time as the photographer's clock read it.
 *
 * A named zone renders the instant in that zone. Without one, Immich's
 * `localDateTime` is the wall-clock time written as if it were UTC, so it is
 * rendered in UTC with no zone label rather than in the collector's own zone,
 * which would move a photo taken abroad to the wrong hour.
 */
function describeWhen(asset: ImmichAsset): { text: string; timeZone?: string } {
  const instant = new Date(capturedAt(asset));
  const zone = normalizeTimeZone(asset.exifInfo?.timeZone);
  const format = (date: Date, timeZone: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  if (zone) {
    return {
      text: `${format(instant, zone)} (${zone}, UTC${utcOffsetLabel(instant, zone)})`,
      timeZone: zone,
    };
  }
  const local = asset.localDateTime && Date.parse(asset.localDateTime);
  if (local) return { text: format(new Date(local), "UTC") };
  return { text: `${format(instant, "UTC")} (UTC)` };
}

function shortDate(asset: ImmichAsset): string {
  const zone = normalizeTimeZone(asset.exifInfo?.timeZone);
  const local = asset.localDateTime ? Date.parse(asset.localDateTime) : NaN;
  const [date, timeZone] = zone
    ? [new Date(capturedAt(asset)), zone]
    : Number.isFinite(local)
      ? [new Date(local), "UTC"]
      : [new Date(capturedAt(asset)), "UTC"];
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

/** Hand-typed text: each line's spacing tidied, blank runs collapsed, line breaks kept. */
function cleanText(value: string | null | undefined): string | undefined {
  const text = value
    ?.split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? text : undefined;
}

// See #622 — planned: places as language-neutral entities; Immich names them in English.
function placeOf(asset: ImmichAsset): string | undefined {
  const exif = asset.exifInfo;
  const parts = [clean(exif?.city), clean(exif?.state), clean(exif?.country)].filter(
    (part): part is string => Boolean(part),
  );
  // "Example City, Example City, Exampleland" reads like a bug; drop the repeat.
  return [...new Set(parts)].join(", ") || undefined;
}

/** Named, visible people on the asset, once each. */
function namedPeople(asset: ImmichAsset): Array<{ id: string; name: string }> {
  const seen = new Set<string>();
  const out: Array<{ id: string; name: string }> = [];
  for (const person of asset.people ?? []) {
    if (!person || typeof person.id !== "string" || person.isHidden) continue;
    const name = cleanPersonName(person.name);
    if (!name || seen.has(person.id)) continue;
    seen.add(person.id);
    out.push({ id: person.id, name });
  }
  return out;
}

function albumNames(asset: ImmichAsset, albums: ImmichAlbumIndex | undefined): string[] {
  const ids = albums?.byAsset[asset.id] ?? [];
  const names = ids
    .map((id) => clean(albums?.names[id]))
    .filter((name): name is string => Boolean(name));
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

function describeDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(h > 0 ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}

/**
 * The lid a face cluster is known by, namespaced by the Immich user whose
 * clusters it belongs to — the asset's owner — as well as by the source. Face
 * clusters and their names belong to each user, so the same person in two
 * members' libraries is two clusters, and the people graph's merge
 * suggestions, not this source, decide they are one person.
 */
export function personLid(userId: string, personId: string): string {
  return `immich:${userId}/${personId}`;
}

/**
 * One Immich asset as a searchable document: the description first, then
 * when, where, who, which albums, and the camera. Text and metadata only —
 * the image itself never leaves the server.
 */
export function assetToDocument(asset: ImmichAsset, ctx: ImmichNormalizeContext): DocumentInput {
  const isVideo = asset.type === "VIDEO";
  const kind = isVideo ? "Video" : "Photo";
  const description = cleanText(asset.exifInfo?.description)?.slice(0, MAX_DESCRIPTION_LEN);
  const when = describeWhen(asset);
  const place = placeOf(asset);
  const people = namedPeople(asset);
  const albums = albumNames(asset, ctx.albums);
  const exif = asset.exifInfo;
  const camera = [clean(exif?.make), clean(exif?.model)].filter(Boolean).join(" ") || undefined;
  const lens = clean(exif?.lensModel);
  const durationMs =
    isVideo && typeof asset.duration === "number" && asset.duration > 0
      ? asset.duration
      : undefined;
  const fileName = clean(asset.originalFileName);

  const lines: string[] = [];
  if (description) lines.push(description, "");
  lines.push(`**${kind}** taken ${when.text}`);
  if (place) lines.push(`**Where:** ${place}`);
  if (people.length > 0) lines.push(`**People:** ${people.map((p) => p.name).join(", ")}`);
  if (albums.length > 0) lines.push(`**Albums:** ${albums.join(", ")}`);
  if (camera || lens) lines.push(`**Camera:** ${[camera, lens].filter(Boolean).join(" · ")}`);
  if (durationMs) lines.push(`**Duration:** ${describeDuration(durationMs)}`);
  const flags = [
    asset.isFavorite ? "favorite" : undefined,
    asset.isArchived ? "archived" : undefined,
  ];
  if (flags.some(Boolean)) lines.push(`**Marked:** ${flags.filter(Boolean).join(", ")}`);
  if (fileName) lines.push(`**File:** ${fileName}`);
  const content = lines.join("\n");

  const titleBase = description?.split("\n")[0];
  const title = titleBase
    ? titleBase.length > MAX_TITLE_LEN
      ? `${titleBase.slice(0, MAX_TITLE_LEN - 1)}…`
      : titleBase
    : [kind, place?.split(", ")[0], shortDate(asset)].filter(Boolean).join(" · ");

  // The source indexes only the key's own user's assets.
  const mentions: PersonMention[] = [{ role: "owner", isSelf: true }];
  for (const person of people) {
    mentions.push({
      role: "participant",
      name: person.name,
      identifiers: [{ kind: "lid", value: personLid(ctx.userId, person.id) }],
    });
  }

  const latitude = typeof exif?.latitude === "number" ? exif.latitude : undefined;
  const longitude = typeof exif?.longitude === "number" ? exif.longitude : undefined;
  const takenAt = capturedAt(asset);

  return {
    providerId: ctx.providerId,
    sourceId: ctx.sourceId,
    externalId: asset.id,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: isVideo ? "video" : "photo",
      sourceUrl: assetUrl(ctx.baseUrl, asset.id),
      people: mentions,
      extra: {
        takenAt,
        ...(when.timeZone ? { timeZone: when.timeZone } : {}),
        ...(clean(exif?.city) ? { city: clean(exif?.city) } : {}),
        ...(clean(exif?.state) ? { state: clean(exif?.state) } : {}),
        ...(clean(exif?.country) ? { country: clean(exif?.country) } : {}),
        ...(latitude !== undefined && longitude !== undefined ? { latitude, longitude } : {}),
        albums,
        people: people.map((p) => p.name),
        isFavorite: asset.isFavorite === true,
        isArchived: asset.isArchived === true || asset.visibility === "archive",
        ...(clean(exif?.make) ? { cameraMake: clean(exif?.make) } : {}),
        ...(clean(exif?.model) ? { cameraModel: clean(exif?.model) } : {}),
        ...(lens ? { lensModel: lens } : {}),
        ...(fileName ? { originalFileName: fileName } : {}),
        ...(durationMs ? { durationMs } : {}),
        ...(asset.checksum ? { checksum: asset.checksum } : {}),
        ownerId: asset.ownerId,
      },
    },
    sourceCreatedAt: takenAt,
    sourceUpdatedAt: new Date(asset.updatedAt).toISOString(),
  };
}
