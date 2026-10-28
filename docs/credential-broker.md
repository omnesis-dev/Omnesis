# Credential broker (Nango): design, status and open work

Branch `nango-credentials` on the `csima/Omnesis` fork, based on upstream `main` at `0fc3ee62`. This page is the
handoff for whoever finishes the work: what exists, how it fits together, how to check it, and what is left. It
holds no deployment details; those live with the operator.

## What it does

An Omnesis account can take its credential from a self-hosted [Nango](https://nango.dev) instead of signing in
through Omnesis. The account then stores only _which_ Nango connection holds its credential, and the collector asks
Nango for a current one whenever it needs it. Nango refreshes the grant; other software on the machine can use the
same grant; removing the source in Omnesis removes only the link, never the grant.

Nango is the single sign-in layer: one OAuth sign-in per account, used by every program that goes through Nango.

## How it fits together

Two secret files (encrypted at rest like every other Omnesis credential, `packages/core/src/secret-file.ts`):

| File                                            | Holds                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `<configDir>/credential-broker.json`            | `{ kind: "nango", url, secretKey }`: where Nango is and the API key Omnesis presents                         |
| `<configDir>/<fileKey>/<accountId>/broker.json` | the binding: `{ broker: "nango", connections: { <purpose>: { providerConfigKey, connectionId } }, params? }` |

A provider with one credential binds the purpose `default`. Google binds one connection per API (`gmail`, `calendar`,
`drive`, `contacts`), because Nango keeps a separate grant per integration. `params` holds non-secret settings
recorded at link time (an IMAP host, a display name).

Flow:

1. `omnesis broker set --url <nango> --key-file <file>` writes the broker config (the key file may be Nango's own env
   file; `NANGO_SECRET_KEY` is read from it).
2. `omnesis broker link <provider> [purpose=]<integration>/<connection-id>... [--param k=v]` builds a trial binding,
   asks the provider's `broker.resolveAccount` which account the credential belongs to (probing the upstream with it),
   and only then writes `broker.json` under that account id. It refuses to take over an account already signed in
   here unless `--replace` is given.
3. `omnesis sources add <type>`: discovery now lists brokered accounts, and the add flow (CLI and portal) skips the
   paste-a-credential wizard for them.
4. At sync time the provider's `createContext` sees `broker.json`, builds its client from
   `BrokeredCredentials.load(...)`, and fetches the credential per request (or via its library's refresh hook).

### Code map

| Area        | Files                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core broker | `packages/core/src/credential-broker.ts` (+ `.test.ts`): config and binding files, `fetchBrokerCredential` (Nango `GET /connections/{id}?provider_config_key=`), `BrokeredCredentials` (cache, de-duplication, sequence guard, forced-refresh throttle, `verify` hook), `BrokerCredentialError` (a `SyncError`: `auth`, or `network` when Nango is unreachable or backing off) |
| Contract    | `packages/source-sdk/src/broker-spec.ts` (`ProviderBrokerSpec`: `fileKey`, `purposes`, `params`, `resolveAccount`), `broker?:` on `defineProvider` in `define-source.ts`                                                                                                                                                                                                       |
| CLI         | `packages/cli/src/commands/broker.ts` (+ test): `set`, `status`, `link`, `unlink`; registered in `subcommands.ts`. Loads provider definitions in-process through `@omnesis/collector/registry` (new subpath export), so it runs on the collector's machine as the collector's user                                                                                             |
| Add flow    | `brokeredAccounts` on the `credentials.status` entry (`packages/core/src/ws-messages.ts`, optional for mixed versions), filled in `packages/collector/src/source-ws-handlers.ts`; consumed in `packages/cli/src/commands/add.ts` and `packages/gateway/portal/js/views/add-source.js`                                                                                          |
| Guards      | `auth.begin` refuses to renew a brokered account (`source-ws-handlers.ts`); `credentials.clear` also removes brokered bindings; `clearProviderAccountAndLegacyCredentials` no longer counts brokered folders as legacy markers (`packages/core/src/credentials.ts`)                                                                                                            |
| Providers   | `packages/providers/{notion,google,outlook,strava,github,granola,lunchflow,coinbase,imap}/src/` — each has a `broker` spec, brokered `discover`/`createContext`/`credentialState`, and `broker.test.ts`                                                                                                                                                                        |
| Docs        | `website/docs/sources.html` (“Credentials from a broker”), `website/docs/operating.html` (CLI table)                                                                                                                                                                                                                                                                           |

## Providers

| Provider   | Nango integration(s)                                                              | Purposes                         | Account id (same as a sign-in here)                                                                                                                                                 | Re-checks identity on each token     |
| ---------- | --------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Notion     | `notion`                                                                          | default                          | workspace id from the token response                                                                                                                                                | yes (`raw.workspace_id`)             |
| Google     | `google-mail`, `google-calendar`, `google-drive`, `google-contacts` (or `google`) | gmail, calendar, drive, contacts | email from Gmail profile / Drive about / primary calendar; all must agree. Contacts cannot name its account: linking it needs `--param account=<email>`, checked against the others | no                                   |
| Outlook    | `outlook`, `microsoft`, `one-drive-personal`, `one-drive`                         | default                          | ID-token username (as MSAL), else Graph `/me`                                                                                                                                       | yes (ID token, when present)         |
| Strava     | `strava`, `strava-web`                                                            | default                          | athlete id from the token response, else `/athlete`                                                                                                                                 | yes (`raw.athlete`, when present)    |
| GitHub     | `github` (OAuth) or `github-pat` (API key)                                        | default                          | lowercased login, or `login@label` with `--param accountLabel=`                                                                                                                     | no                                   |
| Granola    | `granola` (API key)                                                               | default                          | owner email of the newest note, else `granola-<sha12(key)>`                                                                                                                         | no                                   |
| Lunch Flow | `private-api-generic` / `private-api-bearer` (API key)                            | default                          | `lunchflow-<sha12(key)>`, fixed at link time; bank-overlap check runs at link                                                                                                       | no                                   |
| Coinbase   | `private-api-basic` (username = CDP key name, password = PEM)                     | default                          | portfolio id, else key-name hash; trade-capable keys refused at link                                                                                                                | no                                   |
| IMAP       | `private-api-basic` (username = email, password = app password) + `--param host=` | default                          | the username (email)                                                                                                                                                                | yes (username must stay the account) |

Not brokered, by design: Plaid (Link widget), Enable Banking (bank SCA), WhatsApp (QR pairing), and the local-only
sources.

## Nango behaviour relied on

- `GET /connections/{connectionId}?provider_config_key=<integration>` with `Authorization: Bearer <key>` returns
  `credentials` (`OAUTH2`: `access_token`, `expires_at`, `raw`; `API_KEY`: `apiKey`; `BASIC`: `username`, `password`).
  Nango refreshes on read (15-minute margin) and in the background; the key needs credential-read permission.
  ([docs](https://nango.dev/docs/reference/backend/http-api/connections/get))
- `force_refresh=true` forces an OAuth refresh; Omnesis sends it only for OAuth credentials, at most once per
  connection every 5 minutes, because a failed forced refresh puts the shared connection into Nango's 30-second
  back-off for every other caller.
- Error codes mapped in `brokerFailure()`: `connection_refresh_backoff` → retry (`network`, 30 s);
  `connection_refresh_exhausted` and `refresh_token_external_error` carrying `invalid_grant` → `auth` (sign in again at
  Nango); `unknown_provider_config` → `auth` (unbound); 404 → `auth` (not found); anything else → `network`.
- Nango API keys can be limited by resource type but not to particular connections; the key Omnesis holds reaches every
  connection in its environment. A key that can read credentials but not list connections, or a separate Nango
  environment for Omnesis's connections, narrows it.

## Safety rules the code keeps

- The broker key is sent only as a header, only to the configured URL, with redirects refused; plain `http` only to a
  loopback host; connection and integration ids that would change the URL path (`.`, `..`, `/`, `?`, `#`, `%`, control
  characters) are refused on read, write and fetch. No error message or JSON output includes the key or a token.
- Nothing revokes, deletes or rotates a grant upstream for a brokered account (Google `disconnect`, MSAL, Strava,
  Coinbase, GitHub, Plaid paths all checked). Removing an account removes only its local directory.
- No brokered path writes a tokens or credentials file.
- `credentialState` never does network I/O for a brokered account; an unreachable Nango is a retried `network`
  failure, never `needs-auth`.

## Checking it

With Node 24 (`.nvmrc`), after `npm ci` (the postinstall runs `patch-package`, needed for typechecks):

```sh
npx vitest run packages/core/src/credential-broker.test.ts packages/cli/src/commands/broker.test.ts \
  packages/providers/{notion,google,outlook,strava,github,granola,lunchflow,coinbase,imap}
NODE_OPTIONS=--max-old-space-size=10240 npx tsc --build packages/cli
npx prettier --check $(git diff --name-only 0fc3ee62)
```

Full unit suites passed at `d1f2af2e` (core, source-sdk, portal, collector, cli, all providers). The only failures
were nine tests in untouched files (`source-sdk/local-agent-sessions`, `providers/local-files`,
`providers/screen-time`) that make folders unreadable with `chmod`, which does not work when tests run as root.

An independent adversarial review ran on the branch; everything it confirmed was fixed in `d1f2af2e` except the items
below.

## Open work, in priority order

1. **Notion Databases: duplicate `<name>_start` column (upstream bug, not broker-related).**
   `packages/providers/notion/src/schema-mapper.ts` turns a `date` property into `<col>_start` and `<col>_end`
   without reserving those names, so a database with properties such as “Date” and “Date Start” produces two
   `date_start` columns and the gateway's analytics ingest fails with DuckDB
   `Catalog Error: Column with name date_start already exists!` on every sync. Fix: run every derived column name
   through `sanitizeColumnName(..., usedNames)` (or check `usedNames` for the suffixed names before choosing the base
   name), and keep `sourceColumnId` stable. Add a test with both properties in both orders. Worth proposing upstream
   on its own.
2. **Identity re-check for Google, GitHub, Coinbase, Lunch Flow and Granola.** Their `createContext` trusts that a
   linked connection still belongs to the linked account. If a connection is re-authorised at Nango as someone else
   (or a key is swapped), that account's data syncs under the stored id. Use the `verify` option of
   `BrokeredCredentials.load`: Google per-purpose probe (cache the answer per token), GitHub `/user`, Coinbase key
   name recorded at link, Lunch Flow bank-account ids, Granola owner email. Fail with
   `BrokerCredentialError("identity-changed", ...)`.
3. **Needs-sign-in hint for brokered accounts.** `buildReauthHint` (`packages/collector/src/sync-engine-types.ts`)
   tells the operator to sign in again, which `auth.begin` refuses for a brokered account. It should say to sign the
   connection in again at the broker, or `omnesis broker unlink`.
4. **Portal wizard skip is too broad.** `shouldOpenCredentialsWizard` skips the wizard whenever any brokered account
   exists; the CLI skips it only when a brokered account not yet added exists. Match the CLI (the fallback reopens the
   wizard, so this costs a round trip, not a failure).
5. **Narrower Nango key** (see above), and document it in `website/docs/sources.html`.
6. **Before proposing upstream:** consider gating behind `OMNESIS_EXPERIMENTAL` per the repository's rules for new
   behaviour; add a `.changeset/` entry; split into reviewable commits (core + contract + CLI, then providers); rebase
   on current upstream `main`; drop this page; contributions need the upstream CLA.

## Commits

| Commit     | What                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2d7ae699` | Core broker, contract, CLI, add flow, Notion/GitHub/Granola/Lunch Flow/Coinbase/IMAP, docs                                                                                                    |
| `b1ca022e` | Google, Outlook, Strava                                                                                                                                                                       |
| `06abcacd` | Import order                                                                                                                                                                                  |
| `d1f2af2e` | Review fixes: Nango error codes, input checks, cache sequence and refresh throttle, identity re-check (Notion, Strava, Outlook), Google Contacts rule, `--replace`, unlink and clear clean-up |
