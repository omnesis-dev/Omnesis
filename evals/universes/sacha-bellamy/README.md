# Sacha Bellamy demonstration universe

This fictional household has source-native history and sixteen evidence scenarios. It uses a live conversational model. Expected facts are evaluation ground truth, not agent responses. The biography, private addresses, businesses, and financial accounts are invented. The evening scenario uses real public theatre/pub locations and a public street junction as an approximate route origin; its performance, booking and short-let flat are fictional. Other route estimates to fictional addresses require disclosed fixtures.

The authoring modules under `_build/` generate current recording-week commitments in the Europe/London calendar. Historic events retain their original dates. `build.mjs --as-of YYYY-MM-DD --out DIRECTORY` gives a reproducible anchor; the fresh launcher resolves today's London date when `start` materialises the universe, rather than when `prepare` copies the template. `--as-of` remains an explicit reproducibility override. Dates stay fixed for that loaded instance.

The practical demonstrations use Gmail as the household's email account, including original PDF and voice attachments. Other mailbox fixtures are background coverage, not extra corroboration for a demo. The birthday history includes a fictional Amazon order at a reserved example address and a separate recipient acknowledgement; buying a physical gift does not establish attendance at a workshop. Journey confirmations are spoken by the traveller, while bookings and calendar entries establish plans.

## Fresh isolated load

Start from an **already configured isolated demonstration template**, with a working admin token, localhost TLS certificate, model manifest/weights, and optional Codex authentication. Configure its agent assignment independently from extraction: for example, keep the chosen live agent, set `transcriber` to `local/whisper-small`, and set `ocr` to the bare native-runtime name `tesseract`. Install Whisper through `omnesis model install whisper-small` against that template's explicit gateway URL/token/config directory. These commands never use a production template.

```sh
node scripts/load-sacha-demo.mjs prepare \
  --template /tmp/omnesis-demo-template \
  --dir /tmp/omnesis-sacha-recording \
  --port 18762

# Ensure the local OCR dependencies below are available in this shell first.
node scripts/load-sacha-demo.mjs start --dir /tmp/omnesis-sacha-recording
# Inspect gateway.log in that directory and wait for the gateway to become ready.
node scripts/load-sacha-demo.mjs seed --dir /tmp/omnesis-sacha-recording
# Keep seed running in its terminal; run these in another terminal.
node scripts/load-sacha-demo.mjs status --dir /tmp/omnesis-sacha-recording
node scripts/load-sacha-demo.mjs wait-ready --dir /tmp/omnesis-sacha-recording --timeout-ms 1800000
```

The launcher requires a nonexistent destination and an explicit high port other than 7600. It copies settings, token, TLS, privacy policy, and Codex authentication/runtime files. Model manifests are copied independently; large immutable model weight files are linked. It omits databases, collector credentials, conversations, and Codex session pools. Every recording uses a new directory; no existing stores are deleted.

`start` materialises the universe beneath that instance, then launches only the gateway in a separate `setsid` session. It never starts a generic collector. `seed` uses `scripts/demo-host/synthetic-demo-host.ts` to pair the declared roster and ingest through real collectors, including binary attachment extraction. Seeding refuses a gateway without synthetic/test identity. Gateway output goes to `gateway.log`; `launcher.pid` records the launched process. Starting a process is distinct from confirming readiness or successful seeding. The seeder runs in explicit resident mode: keep its terminal running during recording so authoritative source descriptor registries remain connected and graph derivation can continue. Stop it gracefully with Ctrl+C when finished; the gateway remains available independently. Access the portal through a certificate-covered address on the selected port; a localhost certificate does not establish trust for another host name.

Before recording or judging an answer, run `wait-ready`: successful source ingestion does not mean the semantic index is warm. `status` reports the actual `/status` document/index counts and the production date-extraction job's reported queue count and state from `/admin/background-jobs`. The parser count is cached and may drift between reconciliations; it is not a claim that every historic date is recognized. An unavailable count remains unknown. `wait-ready` runs in the foreground, prints changed counts without an ETA, and exits unsuccessfully on timeout or an unavailable gateway. It requires nonempty documents, a fully indexed corpus, and an enabled parser with no in-flight work and a reported empty queue, plus the authoritative link-derivation backlog at zero with no in-flight scan. Link backlog ground truth must be present, no more than ten minutes old and not future-dated; the link-batch throughput counter is insufficient. This is a processing check, not an assertion that a model's answer is correct. A large corpus can remain usable in the portal while CPU indexing continues; wait for the complete index before assessing retrieval.

Database, log, and model-hash-cache paths are explicitly routed into the new instance, overriding paths in the template's `.env`. GPU use defaults to `OMNESIS_LLAMA_GPU=false`; an explicit value in the launching shell takes precedence. The template's live-agent assignment and extraction assignments are retained.

## Local media dependencies

Media generation requires Python 3, Pillow, ReportLab, the DejaVu Sans font, and the eSpeak NG shared library plus English voice data. It never sends fixture text to a remote speech service. `OMNESIS_SYNTH_PYTHON` can select a virtualenv interpreter. On Debian-family systems the packages are `python3-pil`, `python3-reportlab`, `fonts-dejavu-core`, `libespeak-ng1`, and `espeak-ng-data`. A virtualenv can supply the Python libraries with `python -m pip install Pillow reportlab`.

The receipt and oldest tenancy PDFs contain raster images only, with no hidden text. Warranty PDFs contain native text. Voice files contain actual mono PCM speech, with ISO fixture dates pronounced as English month/day/year. Generation also writes PNG scan pages for checking OCR separately. Validate binary structure without inference:

```sh
python3 evals/universes/sacha-bellamy/_build/media_test.py
node --test scripts/load-sacha-demo.test.mjs
```

Actual speech extraction requires the optional `smart-whisper` and `ffmpeg-static` packages plus installed Whisper weights. Actual Tesseract extraction requires `node-tesseract-ocr`, the `tesseract` executable, and English trained data. Replay extraction does not decode these binary files.

An unprivileged Debian-family installation can unpack OCR packages into an isolated tools directory instead of modifying system packages:

```sh
DEMO_TOOLS="$(mktemp -d)"
mkdir "$DEMO_TOOLS/downloads" "$DEMO_TOOLS/root"
(cd "$DEMO_TOOLS/downloads" && \
  apt-get download tesseract-ocr libtesseract5 liblept5 tesseract-ocr-eng tesseract-ocr-osd && \
  for deb in *.deb; do dpkg-deb -x "$deb" ../root; done)
export PATH="$DEMO_TOOLS/root/usr/bin:$PATH"
export LD_LIBRARY_PATH="$DEMO_TOOLS/root/usr/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export TESSDATA_PREFIX="$DEMO_TOOLS/root/usr/share/tesseract-ocr/5/tessdata"
tesseract --version
```

Package dependencies and trained-data paths vary with the distribution; verify the binary and resolve any missing libraries before launch. Install `node-tesseract-ocr` into a task-local npm prefix, then expose it through the worktree's own module directory. Do not mutate a shared primary checkout's module directory. Source the same extraction environment before `start`; the gateway inherits it. OCR can alternatively use an independently configured image-capable Codex or HTTP vision assignment. Audio transcription remains local.

## Recording with Cerebras

In the isolated gateway portal, open **Models**, add a backend using the **Cerebras** preset, and enter its credential privately in the portal. Keep the preset URL `https://api.cerebras.ai`: Omnesis adds `/v1` for the OpenAI-compatible API. Select a currently discovered model from that backend's model selector and assign it to the conversational agent. Preserve the separate local transcription and OCR assignments. Cerebras documents its [OpenAI compatibility](https://inference-docs.cerebras.ai/resources/openai); the available models should be discovered when configuring the backend.

Run `wait-ready` before recording and verify each answer's cited evidence. Runtime validation used Luna; Cerebras latency has not been measured for this universe. Selecting a different backend does not establish answer correctness or a speed claim.

## Party departure recording

A11 must retrieve the latest organiser correction before calculating departure. Fictional addresses cannot establish a live Maps route. An external route tool with a suitable public location or a visibly disclosed fictional route fixture can supply the duration. For a fixture, label both the invented journey and buffer on screen: 35 minutes plus 10 minutes gives a 17:30 departure for 18:15 guest arrival. Cite source evidence for the corrected date, time and venue; attribute the durations to the fixture. This assumes an evening departure from home, separately from the 10:00 setup commitment. Refresh the party date from each newly materialized universe.

## Tonight's departure and tickets

A16 starts with “What time should I leave home tonight?” The load day's calendar and Gmail reservation establish an invented 20:00 performance at the Criterion Theatre, 218–223 Piccadilly, London. Thomas's separate WhatsApp conversation confirms a 19:00 drink at The Three Greyhounds, 25 Greek Street, London W1D 5DD. The earlier meeting is the departure target.

The actual Gmail tenancy PDF identifies a temporary London flat on Gower Street for the loaded week; the permanent household's residence history continues unchanged. Its public entrance approximation is the junction of Gower Street and Chenies Street. A real route lookup can use that junction, but must describe it as an approximate origin rather than an actual numbered dwelling. Travel duration and a chosen arrival buffer determine departure; the corpus does not invent a live route duration.

Follow up with “What seats do we have?” The actual attached ticket PDF holds Stalls Row H seats 12 and 13. Neither the email body, calendar nor WhatsApp repeats the seats or temporary address. Extraction must read the PDF bytes through the normal Gmail attachment pipeline. The reservation and PDFs clearly mark the performance and tickets as fictional, without implying a real scheduled show or valid admission.
