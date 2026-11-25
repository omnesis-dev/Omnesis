// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { dirname } from "node:path";
import { pack, type Pack, type Header } from "tar-stream";
import { ForbiddenError, HttpError, ServiceUnavailableError } from "../errors.js";
import {
  artifactUnavailable,
  catalogArtifactPlans,
  openArtifactFile,
  verifyArtifactFile,
  type ArtifactCatalogItem,
  type ArtifactKind,
  type ArtifactPlan,
} from "./artifact-files.js";
import {
  requireReadableExport,
  prepareReadableExport,
  authenticateReadableExport,
  decryptPinnedExport,
} from "./readable-export.js";
import type { FileHandle } from "node:fs/promises";

export interface ArtifactDownloadAuthority {
  /** Stable credential/session identity, used only for in-memory admission. */
  caller: string;
  stillAuthorized(): boolean;
}
interface ActiveDownload {
  caller: string;
  stop(): void;
  done: Promise<void>;
}
export interface ArtifactDownloadOptions {
  /** Existing scoped key only; never creates a key and never used for backup downloads. */
  readExportRootKey?: () => Promise<string | null>;
  backupRoot?: string;
  exportRoot?: string;
  /** Operational ceilings; no store or writer lease is held by a download. */
  maxConcurrent?: number;
  maxBytes?: number;
  maxDurationMs?: number;
  idleTimeoutMs?: number;
}

const BUFFER_BYTES = 64 * 1024;
const STREAM_ERROR = "The artifact download could not finish. Refresh the list and try again.";

/** Stored downloads preserve ciphertext; readable exports require their separate consent route. */
export class ArtifactDownloadService {
  private readonly active = new Set<ActiveDownload>();
  private closed = false;
  private readonly lifetime = new AbortController();
  private readonly inventories = new Set<Promise<ArtifactPlan[]>>();
  private readonly preparations = new Set<Promise<void>>();
  constructor(private readonly options: ArtifactDownloadOptions) {}

  async list(kind: ArtifactKind | undefined, signal: AbortSignal): Promise<ArtifactCatalogItem[]> {
    const plans = await this.plans(kind, signal);
    return plans
      .map((plan) => plan.item)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  private plans(
    kind: ArtifactKind | undefined,
    requestSignal: AbortSignal,
  ): Promise<ArtifactPlan[]> {
    if (this.closed) throw new ServiceUnavailableError("Artifact downloads are stopping.");
    if (this.inventories.size >= 2)
      throw new HttpError(
        429,
        "ARTIFACT_CATALOG_BUSY",
        "The artifact list is busy. Try again shortly.",
      );
    const signal = AbortSignal.any([requestSignal, this.lifetime.signal]);
    const task = this.scan(kind, signal);
    this.inventories.add(task);
    void task.finally(() => this.inventories.delete(task)).catch(() => {});
    return task;
  }

  private async scan(kind: ArtifactKind | undefined, signal: AbortSignal): Promise<ArtifactPlan[]> {
    signal.throwIfAborted();
    const out: ArtifactPlan[] = [];
    for (const candidate of ["backup", "export"] as const) {
      const root = candidate === "backup" ? this.options.backupRoot : this.options.exportRoot;
      if (root && (!kind || candidate === kind))
        out.push(...(await catalogArtifactPlans(root, candidate, signal)));
      signal.throwIfAborted();
      if (this.closed) throw new ServiceUnavailableError("Artifact downloads are stopping.");
    }
    return out;
  }

  async download(
    id: string,
    authority: ArtifactDownloadAuthority,
    requestSignal: AbortSignal,
  ): Promise<Response> {
    return this.startDownload(id, authority, requestSignal, false);
  }

  async readableExport(
    id: string,
    authority: ArtifactDownloadAuthority,
    requestSignal: AbortSignal,
  ): Promise<Response> {
    return this.startDownload(id, authority, requestSignal, true);
  }

  private async startDownload(
    id: string,
    authority: ArtifactDownloadAuthority,
    requestSignal: AbortSignal,
    readable: boolean,
  ): Promise<Response> {
    if (this.closed) throw new ServiceUnavailableError("Artifact downloads are stopping.");
    const settled = Promise.withResolvers<void>();
    this.preparations.add(settled.promise);
    try {
      return await this.prepareDownload(id, authority, requestSignal, readable);
    } finally {
      this.preparations.delete(settled.promise);
      settled.resolve();
    }
  }

  private async prepareDownload(
    id: string,
    authority: ArtifactDownloadAuthority,
    requestSignal: AbortSignal,
    readable: boolean,
  ): Promise<Response> {
    if (!authority.stillAuthorized())
      throw new ForbiddenError("Artifact download permission is no longer active.");
    const plan = (await this.plans(undefined, requestSignal)).find(
      (candidate) => candidate.item.id === id,
    );
    if (!plan) throw artifactUnavailable();
    if (readable) {
      requireReadableExport(plan);
      if (!this.options.readExportRootKey)
        throw new ServiceUnavailableError(
          "Readable exports are unavailable. Save the stored copy instead.",
        );
    }
    if (plan.item.bytes > (this.options.maxBytes ?? 1024 ** 4)) {
      throw new HttpError(
        413,
        "ARTIFACT_DOWNLOAD_SIZE_LIMIT",
        "This artifact exceeds the download size limit. Choose a smaller backup or export.",
      );
    }
    if (
      this.active.size >= (this.options.maxConcurrent ?? 2) ||
      [...this.active].some((entry) => entry.caller === authority.caller)
    ) {
      throw new HttpError(
        429,
        "ARTIFACT_DOWNLOAD_BUSY",
        "Another artifact download is still running. Finish or cancel it first.",
      );
    }
    const first = plan.files[0];
    if (!first) throw artifactUnavailable();
    let firstHandle: FileHandle | undefined = await openArtifactFile(plan, first);
    if (this.closed || requestSignal.aborted) {
      await firstHandle.close();
      requestSignal.throwIfAborted();
      throw new ServiceUnavailableError("Artifact downloads are stopping.");
    }
    // Reserve only after metadata validation. There is no await between the
    // second admission check and registration of this stream.
    if (
      this.active.size >= (this.options.maxConcurrent ?? 2) ||
      [...this.active].some((entry) => entry.caller === authority.caller)
    ) {
      await firstHandle.close();
      throw new HttpError(
        429,
        "ARTIFACT_DOWNLOAD_BUSY",
        "Another artifact download is still running. Finish or cancel it first.",
      );
    }
    const abort = new AbortController();
    const archive = pack();
    // The async iterator consumes stream errors; this listener also covers a
    // consumer that cancels before its first pull.
    archive.on("error", () => {});
    const iterator = archive[Symbol.asyncIterator]();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let lastAuthorizationCheck = 0;
    let lastReadableActivity = 0;
    const ensureActive = (force = false): void => {
      abort.signal.throwIfAborted();
      // Authentication can legitimately read a large file before emitting its first
      // plaintext byte. Backpressure stops this activity when a consumer stalls.
      if (readable && Date.now() - lastReadableActivity >= 1000) {
        touch();
        lastReadableActivity = Date.now();
      }
      if (force || Date.now() - lastAuthorizationCheck >= 1000) {
        if (!authority.stillAuthorized())
          throw new ForbiddenError("Artifact download permission is no longer active.");
        lastAuthorizationCheck = Date.now();
      }
    };
    const finished = Promise.withResolvers<void>();
    const terminate = (): void => {
      if (abort.signal.aborted) return;
      abort.abort();
      archive.destroy(new Error(STREAM_ERROR));
      void finished.promise.then(() => release());
    };
    const touch = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(terminate, this.options.idleTimeoutMs ?? 60_000);
      idleTimer.unref();
    };
    const onRequestAbort = (): void => terminate();
    requestSignal.addEventListener("abort", onRequestAbort, { once: true });
    const deadline = setTimeout(terminate, this.options.maxDurationMs ?? 6 * 60 * 60 * 1000);
    deadline.unref();
    touch();
    const active: ActiveDownload = {
      caller: authority.caller,
      stop: terminate,
      done: finished.promise,
    };
    this.active.add(active);
    const prefix = `Omnesis-${plan.item.kind}-${plan.item.id.slice(0, 12)}`;
    const produce = async (): Promise<void> => {
      try {
        if (readable) {
          const key = await this.options.readExportRootKey!();
          ensureActive(true);
          if (!key)
            throw new ServiceUnavailableError(
              "Unlock the library key before saving a readable export.",
            );
          await streamReadableExport(archive, plan, key, prefix, abort.signal, ensureActive);
          ensureActive(true);
          archive.finalize();
          return;
        }
        const directories = new Set([
          prefix,
          ...plan.directories.map((name) => `${prefix}/${name}`),
        ]);
        for (const file of plan.files) {
          let parent = dirname(`${prefix}/${file.name}`);
          while (parent !== ".") {
            directories.add(parent);
            parent = dirname(parent);
          }
        }
        for (const directory of [...directories].sort(
          (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
        )) {
          ensureActive();
          await entry(
            archive,
            {
              name: directory,
              type: "directory",
              mode: 0o700,
              size: 0,
              mtime: new Date(plan.item.createdAt),
            },
            Buffer.alloc(0),
          );
        }
        for (const [index, file] of plan.files.entries()) {
          ensureActive();
          const handle =
            index === 0 && firstHandle ? firstHandle : await openArtifactFile(plan, file);
          firstHandle = undefined;
          try {
            await verifyArtifactFile(handle, file);
            const completed = Promise.withResolvers<void>();
            // Handle a sink failure immediately even when the file read is
            // still pending; awaiting the same promise below retains failure.
            void completed.promise.catch(() => {});
            const sink = archive.entry(
              {
                name: `${prefix}/${file.name}`,
                type: "file",
                mode: 0o600,
                size: file.bytes,
                mtime: new Date(file.modifiedAt),
                uid: 0,
                gid: 0,
                uname: "",
                gname: "",
              },
              (error) => (error ? completed.reject(error) : completed.resolve()),
            );
            sink.on("error", () => {});
            let offset = 0;
            while (offset < file.bytes) {
              ensureActive();
              const buffer = Buffer.alloc(Math.min(BUFFER_BYTES, file.bytes - offset));
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
              if (!bytesRead) throw artifactUnavailable();
              offset += bytesRead;
              if (!sink.write(buffer.subarray(0, bytesRead))) await drained(sink, abort.signal);
            }
            await verifyArtifactFile(handle, file);
            sink.end(Buffer.alloc(0));
            await completed.promise;
          } finally {
            await handle.close();
          }
        }
        ensureActive(true);
        archive.finalize();
      } catch {
        terminate();
      } finally {
        await firstHandle?.close().catch(() => {});
        firstHandle = undefined;
        // Keep admission until the consumer drains the finalized archive.
        finished.resolve();
      }
    };
    void produce();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(deadline);
      requestSignal.removeEventListener("abort", onRequestAbort);
      this.active.delete(active);
    };
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          touch();
          try {
            ensureActive();
            const next = await iterator.next();
            if (next.done) {
              controller.close();
              release();
              return;
            }
            if (!(next.value instanceof Uint8Array)) throw new Error(STREAM_ERROR);
            controller.enqueue(next.value);
          } catch {
            terminate();
            controller.error(new Error(STREAM_ERROR));
            await finished.promise;
            release();
          }
        },
        async cancel() {
          terminate();
          await finished.promise;
          release();
        },
      },
      { highWaterMark: BUFFER_BYTES, size: (chunk) => chunk.byteLength },
    );
    const filename = `Omnesis-${plan.item.kind}${readable ? "-readable" : ""}-${plan.item.createdAt.replace(/[^0-9TZ.-]/gu, "-")}.tar`;
    return new Response(body, {
      headers: {
        "Content-Type": "application/x-tar",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    const inventories = [...this.inventories];
    const preparations = [...this.preparations];
    const active = [...this.active];
    for (const download of active) download.stop();
    await Promise.allSettled([
      ...inventories,
      ...preparations,
      ...active.map((download) => download.done),
    ]);
  }
}

function entry(
  archive: Pack,
  header: Partial<Header> & Pick<Header, "name">,
  bytes: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    archive.entry(header, bytes, (error) => (error ? reject(error) : resolve()));
  });
}
function drained(sink: ReturnType<Pack["entry"]>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      cleanup();
      resolve();
    };
    const failed = (): void => {
      cleanup();
      reject(new Error(STREAM_ERROR));
    };
    const cleanup = (): void => {
      sink.off("drain", done);
      sink.off("error", failed);
      sink.off("close", failed);
      signal.removeEventListener("abort", failed);
    };
    sink.once("drain", done);
    sink.once("error", failed);
    sink.once("close", failed);
    signal.addEventListener("abort", failed, { once: true });
    if (signal.aborted || sink.destroyed) failed();
  });
}

async function streamReadableExport(
  archive: Pack,
  plan: ArtifactPlan,
  rootKey: string,
  prefix: string,
  signal: AbortSignal,
  ensureActive: () => void,
): Promise<void> {
  const prepared = await prepareReadableExport(plan, rootKey, signal, ensureActive);
  await entry(
    archive,
    { name: prefix, type: "directory", mode: 0o700, size: 0, mtime: new Date(plan.item.createdAt) },
    Buffer.alloc(0),
  );
  await entry(
    archive,
    {
      name: `${prefix}/manifest.json`,
      type: "file",
      mode: 0o600,
      size: prepared.manifest.length,
      mtime: new Date(plan.item.createdAt),
      uid: 0,
      gid: 0,
      uname: "",
      gname: "",
    },
    prepared.manifest,
  );
  for (const file of prepared.files) {
    ensureActive();
    const handle = await openArtifactFile(plan, file.stored);
    try {
      const bytes = await authenticateReadableExport(
        handle,
        file.stored,
        rootKey,
        file.scope,
        signal,
        ensureActive,
      );
      const completed = Promise.withResolvers<void>();
      void completed.promise.catch(() => {});
      const sink = archive.entry(
        {
          name: `${prefix}/${file.name}`,
          type: "file",
          mode: 0o600,
          size: bytes,
          mtime: new Date(file.stored.modifiedAt),
          uid: 0,
          gid: 0,
          uname: "",
          gname: "",
        },
        (error) => (error ? completed.reject(error) : completed.resolve()),
      );
      sink.on("error", () => {});
      const reading = decryptPinnedExport(
        handle,
        file.stored,
        rootKey,
        file.scope,
        signal,
        ensureActive,
      );
      let written = 0;
      for await (const block of reading) {
        ensureActive();
        written += block.length;
        if (written > bytes) throw artifactUnavailable();
        if (!sink.write(block)) await drained(sink, signal);
      }
      if (reading.authentication().bytes !== bytes || written !== bytes)
        throw artifactUnavailable();
      await verifyArtifactFile(handle, file.stored);
      ensureActive();
      sink.end(Buffer.alloc(0));
      await completed.promise;
    } finally {
      await handle.close();
    }
  }
}
