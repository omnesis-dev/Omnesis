// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Launch the configured browser without interpreting the URL as shell syntax. */
export function browserInvocation(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    const script = `Start-Process -FilePath '${url.replaceAll("'", "''")}'`;
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
    };
  }
  return { command: platform === "darwin" ? "open" : "xdg-open", args: [url] };
}
