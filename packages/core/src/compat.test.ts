// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { CONFIG_SCHEMA_VERSION } from "@omnesis/config";
import { buildCompatManifest, HTTP_API_COMPAT } from "./compat.js";
import { PROTOCOL_VERSION } from "./ws-messages.js";
import { PAIRING_PROTOCOL_MIN_VERSION, PAIRING_PROTOCOL_VERSION } from "./pairing-protocol.js";
import {
  PUSH_RELAY_PROTOCOL_MAX_VERSION,
  PUSH_RELAY_PROTOCOL_MIN_VERSION,
  PUSH_RELAY_PROTOCOL_VERSION,
} from "./push/enrolment.js";

describe("buildCompatManifest", () => {
  const manifest = buildCompatManifest({ productVersion: "1.2.3", mainDbSchemaVersion: 30 });

  test("carries the supplied product version and main-DB schema head", () => {
    expect(manifest.productVersion).toBe("1.2.3");
    expect(manifest.stores.mainDb).toEqual({ policy: "numbered-migrations", version: 30 });
  });

  test("classifies every persisted store", () => {
    expect(manifest.stores.indexDb).toEqual({ policy: "derivable", version: null });
    expect(manifest.stores.analyticsDb).toEqual({ policy: "source-schema-evolved", version: null });
    expect(manifest.stores.config).toEqual({ policy: "in-place", version: CONFIG_SCHEMA_VERSION });
    expect(manifest.stores.cursors).toEqual({ policy: "provider-owned", version: null });
  });

  test("reflects the live wire-protocol constants (not a hardcoded copy)", () => {
    expect(manifest.protocols.ws).toBe(PROTOCOL_VERSION);
    expect(manifest.protocols.pairing).toBe(PAIRING_PROTOCOL_VERSION);
    expect(manifest.protocols.pairingAccepted).toEqual({
      min: PAIRING_PROTOCOL_MIN_VERSION,
      max: PAIRING_PROTOCOL_VERSION,
    });
    expect(manifest.protocols.pushRelay).toEqual({
      current: PUSH_RELAY_PROTOCOL_VERSION,
      min: PUSH_RELAY_PROTOCOL_MIN_VERSION,
      max: PUSH_RELAY_PROTOCOL_MAX_VERSION,
    });
  });

  test("declares the unversioned additive HTTP-API policy", () => {
    expect(manifest.httpApi).toBe(HTTP_API_COMPAT);
    expect(HTTP_API_COMPAT.policy).toBe("additive-within-minor");
    expect(HTTP_API_COMPAT.breakingOnlyOn).toBe("major");
    expect(HTTP_API_COMPAT.versionedUrl).toBeNull();
  });

  test("the schema head feeds straight through to mainDb.version", () => {
    const other = buildCompatManifest({ productVersion: "0.0.1", mainDbSchemaVersion: 7 });
    expect(other.stores.mainDb.version).toBe(7);
  });
});
