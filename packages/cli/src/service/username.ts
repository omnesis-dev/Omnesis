// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { userInfo } from "node:os";

/**
 * The account this CLI runs as, by name. `os.userInfo()` reads the password
 * database, and an account without an entry in it — a container started with
 * a numeric `user:` its image never created — makes it throw
 * `uv_os_get_passwd returned ENOENT` instead of answering. The login
 * environment names the account just as well, and the numeric id is what such
 * an account has in place of a name.
 */
export function currentUsername(
  lookup: () => string = () => userInfo().username,
  env: NodeJS.ProcessEnv = process.env,
  uid: number | undefined = process.getuid?.(),
): string {
  try {
    return lookup();
  } catch {
    return env.USER || env.LOGNAME || (uid === undefined ? "unknown" : String(uid));
  }
}
