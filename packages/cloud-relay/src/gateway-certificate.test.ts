// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import {
  publicGatewayCertificateFile,
  publicGatewayPrivateKeyFile,
  publicGatewayOrigin,
} from "./gateway-certificate.js";

test("Google public identity chooses the opt-in SNI certificate without changing direct TLS paths", () => {
  const direct = {
    OMNESIS_TLS_CERT: "/synthetic/direct.pem",
    OMNESIS_ACME_CERT_FILE: "/synthetic/public.pem",
  };
  expect(publicGatewayCertificateFile(direct)).toBe("/synthetic/direct.pem");
  expect(
    publicGatewayCertificateFile({
      ...direct,
      OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/directory",
    }),
  ).toBe("/synthetic/public.pem");
  expect(direct.OMNESIS_TLS_CERT).toBe("/synthetic/direct.pem");
  expect(() =>
    publicGatewayCertificateFile({
      OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/directory",
      OMNESIS_TLS_CERT: direct.OMNESIS_TLS_CERT,
    }),
  ).toThrow();
  expect(() => publicGatewayCertificateFile({})).toThrow();
});

test("public and direct private keys have independent explicit configuration", () => {
  const direct = {
    OMNESIS_TLS_KEY: "/synthetic/direct-key.pem",
    OMNESIS_ACME_KEY_FILE: "/synthetic/public-key.pem",
  };
  expect(publicGatewayPrivateKeyFile(direct)).toBe(direct.OMNESIS_TLS_KEY);
  const enabled = {
    ...direct,
    OMNESIS_ACME_DIRECTORY_URL: "https://ca.example.test/directory",
    OMNESIS_ACME_CERT_FILE: "/synthetic/public.pem",
  };
  expect(publicGatewayPrivateKeyFile(enabled)).toBe(direct.OMNESIS_ACME_KEY_FILE);
  expect(publicGatewayPrivateKeyFile({ ...enabled, OMNESIS_ACME_KEY_FILE: undefined })).toBe(
    "/synthetic/public.pem.key",
  );
  expect(() => publicGatewayPrivateKeyFile({})).toThrow();
  expect(() => publicGatewayPrivateKeyFile({ ...enabled, OMNESIS_ACME_KEY_FILE: "" })).toThrow();
  expect(() =>
    publicGatewayPrivateKeyFile({ OMNESIS_ACME_DIRECTORY_URL: enabled.OMNESIS_ACME_DIRECTORY_URL }),
  ).toThrow();
});

test("cloud routing has an explicit origin without replacing the existing direct MCP issuer", () => {
  const direct = { OMNESIS_PUBLIC_BASE_URL: "https://direct.example.test" };
  expect(publicGatewayOrigin(direct)).toBe("https://direct.example.test");
  expect(
    publicGatewayOrigin({
      ...direct,
      OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: "https://cloud.example.test:443/",
    }),
  ).toBe("https://cloud.example.test");
  expect(direct.OMNESIS_PUBLIC_BASE_URL).toBe("https://direct.example.test");
  for (const origin of [
    "http://cloud.example.test",
    "https://user:password@cloud.example.test",
    "https://cloud.example.test/path",
    "https://127.0.0.1",
  ])
    expect(() =>
      publicGatewayOrigin({ ...direct, OMNESIS_CLOUD_RELAY_GATEWAY_ORIGIN: origin }),
    ).toThrow();
  expect(() => publicGatewayOrigin({})).toThrow();
});
