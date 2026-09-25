# Landing page

Static marketing site (`index.html`) plus its media. Also serves the
installer: `install.sh` here is a byte-identical mirror of the canonical
`scripts/install.sh`, so `https://omnesis.dev/install.sh` resolves. After
editing the canonical script run `cat scripts/install.sh > website/install.sh`
— a unit test (`scripts/release/install-sh-mirror.test.mjs`) fails on drift. Most assets are
hand-authored, but a few are **generated from the synthetic demo gateway**
(the John Smith corpus — no personal data) so they stay current and never
leak real data. All generators are repeatable: re-run them any time to
refresh the assets.

## The Brain page's brief still

`brain.html` shows a phone with a brief open. The image is not a mock-up: it is
a render of the app's own `BriefDetailSheet` against the `briefHealthRecovery`
fixture in `ios/Sources/Omnesis/UI/PreviewMocks.swift`, so the site cannot end
up showing a screen the app does not produce.

| Asset                                             | Regenerate with                 |
| ------------------------------------------------- | ------------------------------- |
| `media/brief-health-trend.png` (+ `media/light/`) | `scripts/shot-website-brief.sh` |

The script runs the one snapshot case that renders it
(`OmnesisTests/PreviewSnapshotTests/testBriefDetailHealthTrend`) on the
configured macOS build host and copies both appearances in; `--check` fails if
either committed still has drifted from what the app renders today. Re-run it
after changing the fixture, the brief UI, or the app's theme.

## Shared architecture stages (collector → substrate)

`index.html` and `brain.html` both open their diagram with the same two boxes:
the collector, and the substrate it feeds. The landing page labels the second
one **Gateway** (the component); the Brain page labels it **Context substrate**
(what that component holds). Nothing else about the pair differs.

The markup is generated into both pages by
`scripts/render-arch-substrate.mjs`, between the markers

```html
<!-- arch-substrate:start LABEL -->
<!-- arch-substrate:end -->
```

so **do not hand-edit between those markers** — edit the template in the script
and re-render:

```
node scripts/render-arch-substrate.mjs
```

`--check` reports drift instead of writing, and
`scripts/render-arch-substrate.test.mjs` runs the same comparison in CI, so a
template edit that is never rendered reddens the build. The styling half lives
in `website/arch-substrate.css`, which both pages link.

## "Manage from anywhere" showcase — regenerating the three surfaces

The showcase shows the same Sources view across three surfaces. Each is
produced from the synthetic demo gateway and lands in `media/` (dark) +
`media/light/` (light) — except the CLI, which is inlined HTML.

| Surface | What it is                             | Regenerate with                       |
| ------- | -------------------------------------- | ------------------------------------- |
| iPhone  | `media/status-ios.png` (+ `light/`)    | `scripts/record-screenshots.sh`       |
| Portal  | `media/status-portal.png` (+ `light/`) | `scripts/record-portal-screenshot.sh` |
| CLI     | inline HTML terminal in `index.html`   | `scripts/record-cli-terminal.sh`      |

Each script boots the demo gateway (`scripts/start-demo-gateway.sh`), waits
for indexing, captures/renders, and stops the gateway. None of them touch a
live Omnesis instance.

- **iPhone** — `record-screenshots.sh` drives the OmnesisDemo app on the iOS
  simulator (Sources tab via `DEMO_INITIAL_TAB`) and `XCUIScreen`-captures it
  in light + dark; `screenshots-to-image.sh` scales the result. The landing
  frames it with the carousel's `--frame-bezel` CSS.
- **Portal** — `record-portal-screenshot.sh` → `scripts/capture-portal.mjs`
  drives the portal headlessly with Playwright (Sources page, "+ Add source"
  modal open, theme forced via the `omnesis.theme` localStorage key) and
  screenshots the viewport (no browser chrome). The landing wraps it in the
  `.browser-win` window frame.
- **CLI** — `record-cli-terminal.sh` → `scripts/render-cli-terminal.mjs` runs
  `omnesis status` against the demo gateway and injects the colourised output
  as an inline `.term` between the `<!-- cli-terminal:start/end -->` markers
  in `index.html` (do not hand-edit between those markers).

The iPhone + portal images swap to their `media/light/` variants on the
landing page's theme toggle; the CLI terminal re-themes automatically because
it's HTML using the page's `.term` tokens.

## Demo carousel (top of the page)

The hero carousel videos under `demos/` are produced by
`scripts/record-demos.sh` + `scripts/demos-to-video.sh` (see those files).

## Apple Watch clips

`scripts/record-watch-demos.sh` + `scripts/watch-demos-to-video.sh` record the
wrist flow the same way, against the `wrist` universe. Two simulators are
involved because the watch app holds no gateway pairing of its own: it relays
the question to a paired iPhone over WatchConnectivity, and the phone answers
through the replay agent. What is on screen — the activity labels, the
per-source icons, the counters, the spoken read-along — is all live.

Siri cannot be invoked in a simulator, so the recorder injects the question
through `DEMO_WATCH_ASK` exactly where `AskOmnesisIntent` would hand it over.

Output is 416×496, the watch panel's true resolution, so the page renders it at
roughly half that in CSS. watchOS has no light appearance, so unlike the phone
and iPad clips there is no light variant and no theme swap.

`scripts/watch-demo-preview.sh` assembles the clips into a standalone review
page (a watch bezel, one card per clip) and serves it on the local network —
for judging the clips before they are wired into a page.
