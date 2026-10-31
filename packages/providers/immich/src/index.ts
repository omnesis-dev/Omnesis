// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The experimental Immich source: one Immich user's photo and video library,
 * read through that user's API key, one document per asset. Text and
 * metadata only — when, where, who, albums, camera — never the image.
 *
 * Still to come (#592): OCR text, tags, photos partners share (as a source of
 * their own, so access levels can tell them apart), other people's assets in
 * shared albums, a custom CA for self-signed HTTPS, and album or day summaries.
 * Place names in the reader's language wait on places as entities (#622).
 */

import {
  config,
  defineProvider,
  readConnectionState,
  type ProviderDefinition,
} from "@omnesis/source-sdk";
import { fileAlbumStore } from "./album-store.js";
import { ImmichClient, normalizeBaseUrl, type ImmichClientOptions } from "./client.js";
import { immichCredentialsSpec } from "./credentials-spec.js";
import { immichDocumentEventProfile } from "./document-event-profile.js";
import { immichIcon } from "./icons.js";
import {
  authenticate,
  authFlow,
  cleanupCredentials,
  discoverAccounts,
  hasCredentials,
  loadCredentials,
} from "./provider.js";
import { DEFAULT_PAGE_SIZE, ImmichAssetSource } from "./source.js";
import { immichStateSpec } from "./state.js";
import { validateImmichCursor } from "./types.js";

export { ImmichClient, normalizeBaseUrl, MIN_IMMICH_MAJOR } from "./client.js";
export { immichCredentialsSpec, REQUIRED_PERMISSIONS } from "./credentials-spec.js";
export { immichDocumentEventProfile } from "./document-event-profile.js";
export { immichIcon } from "./icons.js";
export { assetToDocument, assetUrl, isIndexableAsset, personLid } from "./normalizer.js";
export { probeImmich } from "./provider.js";
export { ImmichAssetSource } from "./source.js";
export { immichStateSpec } from "./state.js";
export { validateImmichCursor } from "./types.js";
export type {
  ImmichAlbum,
  ImmichAsset,
  ImmichCursor,
  ImmichServerVersion,
  ImmichUser,
} from "./types.js";

export const IMMICH_PROVIDER_ID = "immich";
export const IMMICH_SOURCE_ID = "immich";

/**
 * An Immich asset page, on any host — every server has its own, so the
 * pattern cannot name one; a full UUID after `/photos/` is what keeps it from
 * matching other sites' photo pages. An optional reverse-proxy prefix and the
 * album-scoped form are accepted. Group 1 is the asset id, the external id.
 */
const ASSET_URL_PATTERN =
  "https?://[^/\\s]+(?:/[^\\s]*)?/(?:albums/[0-9a-f-]{36}/)?photos/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";

export interface ImmichContext {
  accountId: string;
  client: ImmichClient;
  /** The Immich user id the stored key was connected as, when it was recorded. */
  userId?: string;
  configDir?: string;
}

/**
 * The provider, over an injectable transport. Production passes nothing and
 * talks to the network; the synthetic twin passes a simulated server.
 */
export function buildImmichProvider(
  clientOptions: ImmichClientOptions = {},
): ProviderDefinition<ImmichContext> {
  return defineProvider<ImmichContext>({
    provider: { id: IMMICH_PROVIDER_ID, name: "Immich" },
    authType: "api-key",
    experimental: true,
    credentials: immichCredentialsSpec,

    // An account is the Immich user the key belongs to, by email: each user
    // connects with their own key, so Immich decides what each one sees.
    discover(ctx) {
      return Promise.resolve(
        discoverAccounts(ctx?.configDir).map((id) => ({
          id: String(id),
          subject: { kind: "email" as const, value: String(id) },
        })),
      );
    },

    authenticate(session) {
      return authenticate(session, clientOptions);
    },

    async authFlow(params, callbacks, ctx) {
      return String(await authFlow(params, callbacks, ctx, clientOptions));
    },

    async cleanupCredentials(accountId, ctx) {
      await cleanupCredentials(accountId, ctx?.configDir);
    },

    async createContext({ accountId, host }) {
      const { baseUrl, apiKey, userId } = await loadCredentials(accountId, host?.configDir);
      return {
        accountId,
        client: new ImmichClient(baseUrl, apiKey, clientOptions),
        ...(userId ? { userId } : {}),
        configDir: host?.configDir,
      };
    },

    // Offline: a stored key means connected. A probe here could only add
    // false negatives — a server that is off for the night would park the
    // source in needs-auth — and a revoked key surfaces on the next sync.
    credentialState(ctx) {
      return readConnectionState(async () => {
        if (!hasCredentials(ctx.accountId, ctx.configDir)) return { status: "never-connected" };
        await loadCredentials(ctx.accountId, ctx.configDir);
        return { status: "connected" };
      });
    },

    async disposeContext() {},

    sources: [
      {
        id: IMMICH_SOURCE_ID,
        name: "Immich",
        description:
          "Photos and videos from a self-hosted Immich library — when, where, who and which albums, never the images",
        unitName: "photos",
        icon: immichIcon,
        defaultSyncInterval: "30m",
        contract: {
          state: immichStateSpec,
          apiVersion: 2,
          requires: ["state-envelope", "typed-config"],
        },
        documentEventProfile: immichDocumentEventProfile,
        urlPatterns: [{ regex: ASSET_URL_PATTERN, idGroup: 1 }],
        config: config.object({
          pageSize: config.number({
            label: "Assets per request",
            default: DEFAULT_PAGE_SIZE,
            min: 10,
            max: 1000,
            integer: true,
            advanced: true,
            help: "How many assets one request reads. Lower it if the Immich server is small and slows down during the first sync.",
          }),
          linkAddress: config.string({
            label: "Address for links",
            placeholder: "https://photos.example.com",
            pattern: "^https?://\\S+$",
            patternHint: "An http:// or https:// address",
            advanced: true,
            help: "The address photos open at from Omnesis, when it is not the one this collector reaches the server at — a public name for phones away from home. Leave blank to link to the server address. Photos already indexed pick up a change at the next daily full read.",
          }),
        }),

        create({ sourceId, providerId, dataCutoff, config: options, host }, ctx) {
          const linkAddress =
            typeof options?.linkAddress === "string" ? options.linkAddress.trim() : "";
          const linkBaseUrl = linkAddress ? normalizeBaseUrl(linkAddress) : undefined;
          if (linkBaseUrl === null) {
            throw new Error(
              `"${linkAddress}" is not an address photos can be linked to. Set "Address for links" to an http:// or https:// address with no query, or leave it blank.`,
            );
          }
          const source = new ImmichAssetSource(ctx.client, providerId, sourceId, ctx.accountId, {
            ...(ctx.userId ? { expectedUserId: ctx.userId } : {}),
            ...(host ? { albumStore: fileAlbumStore(host.stateDir, host.configDir) } : {}),
            ...(linkBaseUrl ? { linkBaseUrl } : {}),
            pageSize: typeof options?.pageSize === "number" ? options.pageSize : undefined,
            dataCutoff,
          });
          return Promise.resolve({
            // The host resolves the stored cursor against `contract.state`
            // first; validating again here is what lets the synthetic twin,
            // which inherits no contract, pass its cursor through unchanged.
            sync: (cursor, opts) => source.sync(validateImmichCursor(cursor), opts),
          });
        },
      },
    ],
  });
}

export default buildImmichProvider();
