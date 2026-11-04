// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Microsoft Recognizers-Text date-time model, shared by every reader of
 * natural-language dates: the document date extractor and the search query's
 * temporal-intent parser.
 *
 * Library note: `@microsoft/recognizers-text-date-time` ships CommonJS/UMD
 * only. The recognizer class is a named member of what `require` returns (its
 * `default` is the namespace object, not the class).
 */

import { lazyRequire } from "@omnesis/core";
import type { DateCulture } from "./language-route.js";

// The library loads with the first model built, not with this module: it is
// reached from code shared by every worker thread, and only the threads that
// read dates need it (see `lazyRequire`).
const recognizers = lazyRequire<typeof import("@microsoft/recognizers-text-date-time")>(
  import.meta.url,
  "@microsoft/recognizers-text-date-time",
);

/** The recognizer's result shape (its shipped typings are loose — narrow here). */
export interface RtResolutionValue {
  timex?: string;
  type?: string;
  value?: string;
  start?: string;
  end?: string;
  Mod?: string;
}
export interface RtModelResult {
  start: number;
  /** Index of the LAST matched char (inclusive). */
  end: number;
  text: string;
  /** e.g. "datetimeV2.date", "datetimeV2.daterange", "datetimeV2.duration". */
  typeName: string;
  resolution?: { values?: RtResolutionValue[] };
}
interface RtModel {
  parse(query: string, referenceDate?: Date): RtModelResult[];
}

// Build one recognizer model per culture per thread, lazily — each is a few
// MB and stateless; `parse(text, reference)` takes the reference date per
// call, so one model per culture serves every caller.
const models = new Map<DateCulture, RtModel>();

/** The date-time model for one culture, built on first use. */
export function dateTimeModel(culture: DateCulture): RtModel {
  let m = models.get(culture);
  if (!m) {
    // fallbackToDefaultCulture=false: a culture missing from the JS build
    // must throw loudly here, never silently parse with English.
    const { DateTimeRecognizer } = recognizers();
    m = new DateTimeRecognizer(culture).getDateTimeModel(culture, false) as unknown as RtModel;
    models.set(culture, m);
  }
  return m;
}
