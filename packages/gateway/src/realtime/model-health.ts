// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { LiveProvider } from "./live-provider.js";

export interface ModelCallHealth {
  success(): void;
  failure(error: unknown): void;
}

/** One result per media session, including failures delivered after admission. */
export function observeLiveProvider(
  provider: LiveProvider,
  begin: (() => ModelCallHealth) | undefined,
  authorized: () => boolean,
): LiveProvider {
  if (!begin) return provider;
  return {
    async create(input, callbacks) {
      const call = begin();
      let failed = false;
      let served = false;
      const failure = (error: unknown) => {
        if (failed || input.signal?.aborted || !authorized()) return;
        failed = true;
        call.failure(error);
      };
      try {
        const session = await provider.create(input, {
          onEvent(event) {
            if (event.type === "session.output_transcript.delta") served = true;
            callbacks.onEvent(event);
          },
          onFailure(error) {
            failure(error);
            callbacks.onFailure(error);
          },
        });
        let closed: ReturnType<typeof session.close> | undefined;
        return {
          id: session.id,
          sdp: session.sdp,
          send: (event) => session.send(event),
          close: () =>
            (closed ??= session.close().then((result) => {
              if (!failed && served && authorized()) call.success();
              return result;
            })),
        };
      } catch (error) {
        failure(error);
        throw error;
      }
    },
  };
}
