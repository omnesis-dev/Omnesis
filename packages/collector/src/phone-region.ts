// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { countryNameToISO2 } from "@omnesis/core";
import type { DocumentIngestionContext } from "@omnesis/types";

export interface PhoneRegionDetectionDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  runtimeLocale?: () => string | undefined;
  readMacOsLocale?: () => string | undefined;
}

function cleanLocale(value: string | undefined): string | undefined {
  const raw = value
    ?.trim()
    .replace(/^['"]|['"]$/g, "")
    .split(/[.@]/, 1)[0];
  if (!raw || raw === "C" || raw === "POSIX") return undefined;
  return raw.replace("_", "-");
}

function regionFromLocale(locale: string | undefined): string | undefined {
  const cleaned = cleanLocale(locale);
  if (!cleaned) return undefined;
  try {
    const region = new Intl.Locale(cleaned).region;
    return countryNameToISO2(region);
  } catch {
    return undefined;
  }
}

function defaultMacOsLocaleReader(): string | undefined {
  try {
    return execFileSync("defaults", ["read", "-g", "AppleLocale"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
  } catch {
    return undefined;
  }
}

/** Detect the source device's phone parsing context without operator setup. */
export function detectDocumentIngestionContext(
  deps: PhoneRegionDetectionDeps = {},
): DocumentIngestionContext {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const runtimeLocale =
    deps.runtimeLocale ?? (() => Intl.DateTimeFormat().resolvedOptions().locale);
  const runtime = cleanLocale(runtimeLocale());

  const override = countryNameToISO2(env.OMNESIS_PHONE_REGION);
  if (override) {
    return { locale: runtime, phoneRegion: override, phoneRegionSource: "override" };
  }

  if (platform === "darwin") {
    const osLocale = cleanLocale((deps.readMacOsLocale ?? defaultMacOsLocaleReader)());
    const region = regionFromLocale(osLocale);
    if (region) return { locale: osLocale, phoneRegion: region, phoneRegionSource: "os" };
  }

  const environmentCandidates = [env.LC_TELEPHONE, env.LC_ALL, env.LANG];
  for (const candidate of environmentCandidates) {
    const region = regionFromLocale(candidate);
    if (region) {
      return {
        locale: cleanLocale(candidate) ?? runtime,
        phoneRegion: region,
        phoneRegionSource: "environment",
      };
    }
  }

  const runtimeRegion = regionFromLocale(runtime);
  if (runtimeRegion) {
    return { locale: runtime, phoneRegion: runtimeRegion, phoneRegionSource: "runtime" };
  }
  return { locale: runtime, phoneRegion: "US", phoneRegionSource: "fallback" };
}
