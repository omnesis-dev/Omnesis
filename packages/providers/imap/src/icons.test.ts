// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { genericImapIcon, imapIconForHost } from "./icons.js";
import definition from "./index.js";

describe("IMAP host visuals", () => {
  it("uses Fastmail's hosted mark for Fastmail's exact IMAP host", () => {
    const icon = imapIconForHost("IMAP.FASTMAIL.COM");

    expect(icon.url).toBe("https://www.fastmail.com/apple-touch-icon.png");
    expect(icon.imageDataUri).toBeUndefined();
  });

  it("uses a generic cloud glyph for iCloud Mail without Apple's app icon", () => {
    const icon = imapIconForHost("imap.mail.me.com");

    expect(icon.url).toBeUndefined();
    expect(icon.sfSymbol).toBe("icloud.fill");
    expect(icon.imageDataUri).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("keeps an unknown provider on the generic IMAP icon", () => {
    expect(imapIconForHost("mail.example.org")).toEqual(genericImapIcon);
  });

  it("gives the generic icon a tinted Lucide mail glyph as a data URI", () => {
    expect(genericImapIcon.imageDataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(
      genericImapIcon.imageDataUri!.slice("data:image/svg+xml;base64,".length),
      "base64",
    ).toString("utf8");
    // lucide `mail`'s envelope flap, tinted to the IMAP accent.
    expect(svg).toContain('d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7"');
    expect(svg).toContain('stroke="#5865F2"');
    expect(svg).not.toContain("currentColor");
  });

  it("publishes the account host's icon through the source instance", async () => {
    const source = definition.sources[0]!;
    const instance = await source.create!(
      {
        accountId: "account@example.com",
        sourceId: SourceId("imap:account@example.com"),
        providerId: ProviderId("imap:account@example.com"),
      },
      {
        accountId: "account@example.com",
        credentials: {
          host: "imap.fastmail.com",
          username: "account@example.com",
          password: "invented-app-password",
        },
      },
    );

    expect(instance.icon?.url).toBe("https://www.fastmail.com/apple-touch-icon.png");
    await instance.dispose?.();
  });
});
