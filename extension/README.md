# Omnesis (Chrome extension)

The Manifest V3 extension that adds the web pages you read to your Omnesis
index. It pairs once with a gateway you run, then captures the readable text of
each HTTPS page you keep open long enough to count as a visit, and pushes it to
that gateway with a token that can add pages and nothing else. Stable setup is documented in `website/docs/setup.html` and data handling in
`website/browser-extension-privacy-policy.html`. Experimental page notes and Find
are documented only in `website/docs/experimental.html`; this file is for people
changing the code.

## Layout

```
public/            manifest.json, popup.html, options.html, ui.css, icons — copied into the build as-is
src/push/          the chrome-free push pipeline: durable queue, bounded transport, delivery verdicts,
                   pairing handshake, capture-policy client, document/visit builders, observability
src/capture/       the chrome-free capture engine: URL normalization, Markdown extraction, the dwell
                   state machine (lifecycle.ts), the tab→worker handoff queue, the policy cache
src/chrome/        the glue that runs in the browser: the service worker (background.ts), the content
                   script (content.ts), the popup and options controllers, storage keys, messages
scripts/           build.mjs (esbuild), package-store.mjs (store ZIP), test-manifest.mjs (E2E variant),
                   generate-icons.mjs / generate-store-assets.mjs, smoke-lifecycle.mjs (headed smoke)
store/             the Chrome Web Store listing, privacy declarations and generated assets
release-contract.json  what the store review is told: version, protocol, scopes, the gateway routes used
```

`src/push` and `src/capture` import nothing from `chrome.*`; they take `fetch`,
a durable key/value store and timers as parameters. That is what lets the same
code run under Node in the spawned-gateway E2E and byte for byte in the worker.

## How it works

- **Pairing.** The options page redeems a one-time code (`omnesis devices pair --kind browser`)
  against `POST /devices/pair` after reading `GET /health` and refusing a gateway older than the fixed capture-contract minimum (0.5.0). Experimental notes and Find use
  explicit capability discovery rather than product-minor comparisons. The gateway returns a `write:web` token, stored under its own key so the content
  script — which imports `pairing-record.ts` only — never sees it (`bundle-boundaries.test.ts`
  asserts the content bundle names neither the token key nor the legacy combined record). A retry
  after a timeout reuses a stored idempotency key, so the gateway replays the first redemption
  instead of finding the code spent.
- **Capture policy.** The capture settings live on the gateway: `GET /web-capture-policy` serves the
  shared pause, the excluded domains, the hosts other sources own, the built-in privacy rules and
  the pages the user deleted for good. The worker keeps a copy under `omnesis.capture.policy.v1`
  (15-minute TTL, refreshed on the drain alarm, on popup open and from each of its own edits) and
  captures nothing without one. Edits go through the worker to the gateway, so every paired browser
  shares them. The contract lives in `@omnesis/provider-web/capture-policy`.
- **A page's life.** The content script asks the worker `capture-eligibility` for its URL, applies
  the password-field rule itself, then runs `CaptureLifecycle`: five seconds of focused dwell,
  Defuddle + Turndown extraction of the rendered DOM as Markdown, a content hash, an emission the
  worker turns into one `POST /documents` (a `webpage` document keyed on the SHA-256 of the
  normalized URL) and one `POST /analytics/ingest` row (`page_visits`). Mutations re-extract after
  a debounce and re-push only when the text or title changed. The emission is staged in
  `chrome.storage.local` until the worker acknowledges it. This recovery outbox holds up to
  20 records; evicted recovery copies can still be handed off by their open tabs. Eviction counts
  remain available in diagnostic storage but do not trigger a popup warning or toolbar badge:
  they do not establish that an upload was lost. Current handoff failures and confirmed discarded
  uploads still surface in the popup and badge.
- **The worker.** MV3 workers are evicted within seconds of idling, so `background.ts` holds no
  authoritative state: every wake rebuilds the push client from the durable queue and config, and
  `chrome.alarms` drives the drain cadence. One request per pass, exponential backoff with
  `Retry-After`, 401/403 retained for re-pair, a `rejected` verdict (source paused or removed)
  kept as a probe, a `suppressed` verdict (page deleted for good) dropped without counting as
  synced. The popup and the toolbar badge render one composed status (`status.ts`) so they never
  disagree.

## Working on it

```
npm --prefix extension run build              # → extension/dist/, load unpacked at chrome://extensions
npx vitest run extension                       # unit suite (linkedom for DOM, fake chrome for the worker)
npx tsc --build extension && npx tsc -p extension/tsconfig.tests.json --noEmit
npm run test:e2e -- packages/collector/src/e2e/browser-capture.e2e.test.ts     # push module under Node vs a real gateway
npm run test:e2e -- packages/collector/src/e2e/browser-extension.e2e.test.ts   # the built extension in headless Chromium
```

The headless suite builds with `OMNESIS_EXTENSION_TEST_BUILD=1`, which applies
`scripts/test-manifest.mjs`: the wildcard HTTPS host permission is granted at
install time (no automation can click Chrome's permission dialog) and the
extension id is pinned. The store ZIP is asserted never to carry that variant.
Chromium runs with `--ignore-certificate-errors` because a worker's `fetch`
cannot click through the spawned gateway's self-signed certificate — the real
extension gets no such concession, which is why the docs require a trusted
certificate.

`chrome.storage.local` keys are an on-disk contract with installed browsers;
`src/storage-keys.test.ts` pins every literal. Renaming one needs a worker-start
migration in the same commit.

The Notes and Find workers require `GET /health` reporting both a compatible feature capability and
`experimental: true`. They persist this verification
separately from older capability caches. Previously verified notes may still be
queued during a network outage; an explicit disabled experimental flag hides
both features, stops delivery and preserves drafts and unsent notes. Native
panel entrypoints revalidate before exposing either composer or search results.

## Releasing

`docs/releasing.md` § "Chrome Web Store artifact" is the recipe. In short:
record `origin/main` once before qualification, then pass it as
`OMNESIS_EXTENSION_RELEASE_COMMIT` to
`npm --prefix extension run package:store:release`. On a clean checkout at that recorded commit it writes
`extension/artifacts/omnesis-browser-capture-<version>.zip`
with a `SOURCE.txt` naming the exact commit; `release-contract.json` must agree
with `manifest.json` and `package.json` (`store-release.test.ts` checks all of
it, including that every gateway route the extension uses is declared and that
`store/assets/` was generated from the current options page and stylesheet).

The package carries no fixed `key`, so a store install has a different extension
id from an unpacked build of the same source and starts with no pairing. The two
therefore coexist in one browser, each pairing on its own; unpair the unpacked
build before relying on the store one, or both capture the same pages. Say so on
the setup page when the store listing goes live.

## Tell Omnesis

This feature is unstable and requires `OMNESIS_EXPERIMENTAL=1` on the gateway. On compatible gateways, an already paired browser automatically receives a separate note credential. Existing page-capture pairing stays unchanged. Older gateways continue capturing pages without offering notes.

Use **Alt + Shift + N** (**Control + Command + T** on macOS), the popup's **Tell Omnesis** icon, or the page/selection context menu. The native side panel fixes the page context for the note and includes any selected text. **Ctrl/Cmd + Enter** saves; Enter inserts a newline. Written drafts survive closing the panel and retain their original page when switching tabs. An untouched empty draft follows the page where you next invoke Tell Omnesis. Unsent notes survive browser restarts and retry with stable IDs. A full 100-note queue refuses new saves and keeps the draft. Gateway-rejected notes can be reopened for editing. Chrome lets users change the shortcut at `chrome://extensions/shortcuts`.

## Find

Find is unstable and requires `OMNESIS_EXPERIMENTAL=1` on the gateway. An already paired browser enables Find automatically on compatible gateways. This stores a separate `read` credential; capture stays on `write:web`, note creation stays on `notes:create`, and saved-note editing uses `notes:update`. The read credential allows ordinary search across all indexed sources. The extension filters results for browser-openable HTTP(S) source links; that display filter is not an authorization restriction. Gateways without Find support keep capturing pages and do not offer Find.

Use **Alt + Shift + F** (**Control + Command + K** on macOS) or the popup's **Find** icon. Find and Tell Omnesis open separate workflows in the native side panel. Find shows titles, matching snippets, favicons and source links. Keyboard selection and Enter open a result: a safely matching tab and its window receive focus, otherwise the source link opens in a new tab. The separate new-tab action opens another copy. Query and result state survive closing the panel. Matching never relies on a domain alone; unprovable account aliases open the source link instead.

Chrome requests the required `tabs` and `favicon` permissions at installation or upgrade. Find matches open tabs and shows available icons automatically, without another activation step. Tab matching stays local and does not upload the tab list. Icons use Chrome's local favicon service; missing icons use a fallback. Neither feature requests browser-history access. The configured decision model chooses direct index retrieval or a read-only agent search. Without an enabled decision model, Find uses the index. The side panel shows the decision, streamed agent text and the same conversation and ephemeral tool-card components used by the portal; the agent emits grounded destinations through a structured result tool. Each query is a fresh task, with no timeline or follow-up conversation.

The popup icons show the configured shortcuts in their tooltips. Escape closes either workflow. Durably accepting a new note (including offline queuing), updating a saved note, or successfully opening a search result closes the panel; failed saves keep the text. Tell Omnesis lists notes associated with the current page through the gateway graph. Selecting a saved note opens an editor, using a separate `notes:update` credential and revision checks to prevent overwriting concurrent edits. Browser note edits retain the original page and selected passage. **New note** returns to the separate creation draft; editing changes only the note text, preserving its original page and quotation. Editing requires no additional Chrome permission.

Chrome may keep previously assigned shortcuts after an extension upgrade or reload. Change them at `chrome://extensions/shortcuts`; popup icon tooltips show the active bindings.

Chrome's address bar also accepts **om + Space/Tab**, then a query. Search-pipeline suggestions are bounded and debounced, stay in memory for that input session, and do not invoke the decision model or agent. Select a suggestion to focus its safely matching tab or open its source link; submit the query itself to open Find with the ordinary decision gate and SSE stream. Suggestions require the gateway's `browserFindSuggest` capability and experimental mode. Gateways that support Find without suggestions retain query submission. Chrome registers the keyword through the manifest; an unavailable gateway leaves it inactive for private search. Text outside keyword mode is never forwarded.
