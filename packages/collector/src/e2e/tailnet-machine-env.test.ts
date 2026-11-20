// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { tailnetFixtureEnv } from "./tailnet-machine-env.js";

test("ambient SDK credentials and forced login cannot bypass local approval or persisted restart", () => {
  const ambient = {
    PATH: "fixture-tool-path",
    OMNESIS_CONFIG_DIR: "fixture-config",
    TS_AUTHKEY: "invented-unused-auth-key",
    ts_auth_key: "invented-unused-auth-key",
    TS_CLIENT_SECRET: "invented-unused-client-secret",
    TS_CLIENT_ID: "invented-unused-client-id",
    TS_ID_TOKEN: "invented-unused-identity",
    TS_AUDIENCE: "fixture-audience",
    TsNet_Force_Login: "1",
    TS_DEBUG_LOG_SIGNIN: "1",
    TS_NO_LOGS_NO_SUPPORT: "false",
  };
  expect(tailnetFixtureEnv(ambient)).toEqual({
    PATH: "fixture-tool-path",
    OMNESIS_CONFIG_DIR: "fixture-config",
    TS_NO_LOGS_NO_SUPPORT: "true",
  });
  expect(ambient.TS_AUTHKEY).toBe("invented-unused-auth-key");
});
