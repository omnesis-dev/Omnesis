// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Worker thread that reads a PDF's native text, page by page. `pdf-pages.ts`
 * owns its lifecycle; nothing else runs here.
 *
 * pdf.js runs its own "worker" in-process under Node, and on a corrupt file it
 * leaves promises behind that reject after the document has been given up:
 * `Catalog.getPageDict` prefetches every top-level page object in parallel and
 * never awaits the ones it no longer needs, so a misplaced page object rejects
 * with nobody listening. In the collector's main thread that is an unhandled
 * rejection that takes the process down. In this thread, which holds nothing
 * but the parser, it concerns no one, so it is recorded and the worker keeps
 * serving the next file.
 */

import { parentPort } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";
import { createLogger } from "@omnesis/core";
import { joinPageTextItems, type PdfTextItem } from "./pdf-text-joiner.js";

const log = createLogger("attachments:pdf-worker");

export interface PdfPagesRequest {
  id: number;
  data: Uint8Array;
}

export type PdfPagesReply =
  | { id: number; ok: true; pages: string[]; failedPages: number }
  | { id: number; ok: false; message: string };

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

process.on("unhandledRejection", (reason) => {
  log.debug(`Contained a rejection pdf.js left behind: ${messageOf(reason)}`);
});

/**
 * One entry per page: its joined native text, or "" for a page with none. A
 * page that fails to parse is also "" and counted in `failedPages`, so one bad
 * page costs that page and not the whole document — and, being empty, it is
 * offered to OCR like an image-only page.
 */
async function readPages(data: Uint8Array): Promise<{ pages: string[]; failedPages: number }> {
  const pdf = await getDocumentProxy(data);
  try {
    const pages: string[] = [];
    let failedPages = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      try {
        const content = await (await pdf.getPage(pageNumber)).getTextContent();
        const items: PdfTextItem[] = [];
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const [, , c = 0, d = 0, x = 0, y = 0] = item.transform as number[];
          items.push({ str: item.str, x, y, width: item.width, fontSize: Math.hypot(c, d) });
        }
        pages.push(joinPageTextItems(items).trim());
      } catch (err) {
        failedPages++;
        pages.push("");
        log.debug(`PDF page ${pageNumber} unreadable: ${messageOf(err)}`);
      }
    }
    return { pages, failedPages };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

parentPort?.on("message", (request: PdfPagesRequest) => {
  readPages(request.data).then(
    (result) =>
      parentPort?.postMessage({ id: request.id, ok: true, ...result } satisfies PdfPagesReply),
    (err: unknown) =>
      parentPort?.postMessage({
        id: request.id,
        ok: false,
        message: messageOf(err),
      } satisfies PdfPagesReply),
  );
});
