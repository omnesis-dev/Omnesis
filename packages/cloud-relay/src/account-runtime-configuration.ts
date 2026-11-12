// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { dirname, join } from "node:path";
import { z } from "zod";
import { loadAccountEnrollmentAuthority } from "./account-authority-key.js";
import { AppAssociations } from "./app-associations.js";
import { readPrivateJson } from "./google-credentials.js";
import { bindingOrigin } from "./gateway-binding.js";
import { signupPolicySchema } from "./gateway-signup.js";
import { configuredConnectShortUrl } from "./connect-short-url.js";
import type { AccountSignInConfiguration } from "./account-services.js";
import type { IdentityProvider } from "./identity.js";

/** Account coordination is opt-in and keeps its signing key independent from the routing session root. */
export async function accountRuntimeConfiguration(options: {
  env: NodeJS.ProcessEnv;
  origin?: string;
  database: string;
  nativeGoogleIdentity?: IdentityProvider;
}): Promise<AccountSignInConfiguration | undefined> {
  if (options.env.OMNESIS_CLOUD_RELAY_ENABLED !== "1") return undefined;
  // A routing-only relay does not need an account authority or a browser origin.
  if (options.origin === undefined) {
    if (
      options.env.OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE !== undefined ||
      options.env.OMNESIS_CLOUD_RELAY_APP_ASSOCIATIONS_FILE !== undefined ||
      options.env.OMNESIS_CLOUD_RELAY_SIGNUP_POLICY !== undefined ||
      options.env.OMNESIS_CLOUD_RELAY_CONNECT_SHORT_URL !== undefined
    )
      throw new Error("Account sign-in requires the relay's public HTTPS origin");
    return undefined;
  }
  const origin = bindingOrigin(options.origin).origin;
  const paths = z
    .object({
      OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE: z.string().trim().min(1).optional(),
      OMNESIS_CLOUD_RELAY_APP_ASSOCIATIONS_FILE: z.string().trim().min(1).optional(),
      OMNESIS_CLOUD_RELAY_SIGNUP_POLICY: signupPolicySchema.default("invitation"),
      OMNESIS_CLOUD_RELAY_SIGNUP_ALLOWLIST_FILE: z.string().trim().min(1).optional(),
    })
    .parse(options.env);
  if (
    paths.OMNESIS_CLOUD_RELAY_SIGNUP_POLICY === "allowlist" &&
    !paths.OMNESIS_CLOUD_RELAY_SIGNUP_ALLOWLIST_FILE
  )
    throw new Error(
      "The allowlist signup policy requires OMNESIS_CLOUD_RELAY_SIGNUP_ALLOWLIST_FILE",
    );
  const connectShortUrl = configuredConnectShortUrl(
    options.env.OMNESIS_CLOUD_RELAY_CONNECT_SHORT_URL,
  );
  const associations = paths.OMNESIS_CLOUD_RELAY_APP_ASSOCIATIONS_FILE
    ? new AppAssociations(await readPrivateJson(paths.OMNESIS_CLOUD_RELAY_APP_ASSOCIATIONS_FILE))
    : undefined;
  const enrollmentAuthority = await loadAccountEnrollmentAuthority(
    origin,
    paths.OMNESIS_CLOUD_RELAY_ACCOUNT_KEY_FILE ??
      join(dirname(options.database), "account-authority.pem"),
  );
  return {
    associations,
    enrollmentAuthority,
    nativeGoogleIdentity: options.nativeGoogleIdentity,
    ...(connectShortUrl ? { connectShortUrl } : {}),
    signup: {
      policy: paths.OMNESIS_CLOUD_RELAY_SIGNUP_POLICY,
      allowlistFile: paths.OMNESIS_CLOUD_RELAY_SIGNUP_ALLOWLIST_FILE,
    },
  };
}
