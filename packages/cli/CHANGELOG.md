# omnesis

## 0.7.1

### Patch Changes

- 5f69055: The browser extension's version on the gateway now follows an update. `omnesis devices list`, the portal's Devices page and `omnesis doctor` used to keep showing the version a browser was paired with, so an extension Chrome had updated, or an unpacked build reloaded, read as behind until it was paired again. The extension now reports its version with its page uploads and its periodic check, and the gateway records it when it changes, within about fifteen minutes and without a re-pair. An older extension keeps working and keeps its paired version.
- de385ba: New Discord source, behind the experimental gate. Discord hands message history to bots only — an ordinary account may not be automated and no OAuth2 scope reads messages — so you create an application, enable its Message Content intent, and paste the bot token. Omnesis then builds the invite link itself, asking for View Channels and Read Message History and nothing else, and shows it until the bot is in a server. The token is the credential and the bot's user id the account.

  Each channel's day becomes one conversation document, threads and forum posts included, with every poster in the people graph. A sync re-reads each channel's last indexed day and compares it by content, so an edit or a deletion there lands; older days stay as they were, because Discord's API offers no way to learn what was deleted short of re-reading everything ever sent.

  A bot whose Message Content intent is off is not refused by Discord — it is served blanked message bodies — so a cycle that sees a long run of messages with no content, no attachment and no embed stops and names the intent instead of indexing nothing.

- fd2c652: The gateway, collector, CLI and their workers no longer trust root certificates that Mozilla has removed but Node.js still bundles, starting with the emSign roots NSS 3.131.1 dropped. The npm runs and Node.js header downloads started by the installer, the `omnesis` launcher, `omnesis update`, the hardened gateway's release build and the Codex runtime install do not trust them either, and an OpenClaw connection that verifies the gateway by name leaves them out.
- 61230be: A machine that runs only a collector in Docker gets next steps that work there: its closing banner sends you to the gateway host or the portal to add sources, and the command for a Mac collector names the gateway it is paired with rather than this machine. `omnesis status` and the other admin commands on such a machine say to run them on the gateway host, instead of asking you to start a gateway or printing a stack trace. Its collector container now takes this machine's name, so its device keeps a readable name, and `omnesis uninstall` there reminds you to remove the device on the gateway host, as a native collector's uninstall does. A combined container no longer prints tini's "not running as PID 1" warning.
- 61230be: `install.sh --docker` asks which embedding model to install on a host with no Node of its own, reading the model list with the Node in the image it pulled, instead of installing the default without asking. Without a terminal, it checks for `--embedder` (or `--no-model`), `--keyring-passphrase-file` (or `--no-keyring`) and, for a collector, `--code` before it pulls anything, and names every missing flag in one message. It refuses a Docker Compose older than v2.24.0, and generating a keyring passphrase no longer prints `tr: write error: Broken pipe`.
- d64e605: A gateway installed with `install.sh --docker` on the default bridge network no longer recommends its container's own address for pairing a phone. `omnesis devices pair --kind ios|android` and the portal now offer the host's addresses and name that the installer wrote into the gateway's certificate first, as long as the certificate still covers them; the container's address and `omnesis.local`, which phones cannot reach through the bridge, are listed last.
- 61230be: `omnesis update --edge` on a Docker install is refused before anything changes, instead of failing at the pull with `manifest unknown` and rolling back: no image follows the main branch. Pin a release with `--target-version`, or an exact commit's published `sha-*` images as the updating guide describes. On a machine that runs only a collector in Docker, `omnesis update` recognises that the collector already runs the newest release instead of planning to reinstall it.
- @omnesis/agent-integration@0.7.1
  - @omnesis/cli-shared@0.7.1
  - @omnesis/collector@0.7.1
  - @omnesis/config@0.7.1
  - @omnesis/core@0.7.1
  - @omnesis/eval@0.7.1
  - @omnesis/gateway@0.7.1
  - @omnesis/gateway-client@0.7.1
  - @omnesis/source-sdk@0.7.1
  - @omnesis/types@0.7.1

## 0.7.0

### Minor Changes

- f8d9a52: Experimental Brain: `brain.excludedSources` lists sources the Brain never reads, each a source type (`codex`) or an exact source id. Background runs do not admit, search, fetch, query or cite an excluded source's documents, and the list applies without a restart. Knowledge already derived from those sources is kept. The interactive agent is not affected.
- 5c4156a: Find browser-openable Omnesis search results from the Chrome extension, with matching snippets, favicons, and actions to switch to an open tab or open the source link. Find searches with its own read-only credential, which the gateway issues to the paired extension automatically. The configured decision model can choose a read-only agent search for queries that need evidence, connections or calculations; the extension streams its text and tool activity alongside structured results.

  Chrome page notes and Find are experimental: both controls and gateway endpoints require `OMNESIS_EXPERIMENTAL=1`, including previously issued browser credentials. Automatic capture and portal/mobile notes remain available by default.

- 1fc358d: Capture a note about the current page from the Chrome extension using Tell Omnesis in the popup, the page or selection context menu, or Alt+Shift+N (Control+Command+T on a Mac). The side panel keeps the page and optional quotation with the draft, and unsent notes retry after an outage. Notes use their own create-only credential, which the gateway issues to the paired extension automatically; page capture keeps working with existing permissions. Page notes are experimental and need a gateway started with `OMNESIS_EXPERIMENTAL=1`; gateways without the notes capability hide the feature, and existing extensions continue to capture pages.
- f8d9a52: Phones and the OpenClaw and Hermes integrations that pinned the gateway's certificate follow its renewal instead of losing the connection, when they reach the gateway by a DNS name and the new certificate is publicly trusted (Tailscale or a public authority). A client that will still lose its connection at the next renewal — an integration from an earlier release, or one that reaches the gateway by IP address — is named beforehand, with the date and the remedy, on its portal device card, in `omnesis devices list` and in `omnesis doctor` (`fleet.tls-pin-renewal`); on a Tailscale certificate the card offers to update it. A client a renewal has already stranded is reported as `fleet.tls-pin-repair`, and `omnesis tls status` prints the next renewal.
- 103fbfd: Run the built-in agent on a Claude subscription through Claude Code. The new `claude-code/<model>` backend uses the operator's own installed and signed-in `claude` CLI (Claude Code 2.1.259 or later) on the gateway host; Omnesis never signs in to Claude or reads its credentials, and API-key variables are never passed to the CLI. It serves the same roles as Codex, among them the agent, background agent, privacy reviewer and image OCR, but not embeddings or transcription; a CLI older than the minimum is reported as needing `claude update`. Each turn is an isolated `claude -p` process in an empty Omnesis-owned directory with every built-in Claude Code tool removed; Omnesis loads none of the operator's settings files, so no settings-enabled plugins, hooks or MCP servers, switches off Claude Code's built-in plugins, and fails the turn if Claude Code offers any tool outside Omnesis or loads skills, sub-agents, slash commands or outside plugins, or runs a hook, a background task or a tool Omnesis did not call. It refuses to start Claude Code where the host's managed policy settings make it run commands of its own. Manage it with `omnesis claude-code status|refresh|setup-agent` or under Settings → Models → Backends, and `omnesis doctor` reports `models.claude-code`. An interactive gateway install with `claude` on the PATH and no agent model offers to set it up with Haiku.
- f8d9a52: Docker installs run published release images. `install.sh --docker` pulls `ghcr.io/omnesis-dev/omnesis-gateway` and `omnesis-collector` for the version it installs, `--combined` runs both daemons in one `omnesis-combined` container, `--gateway-only` runs a gateway for collectors on other machines, and `--docker-network host|bridge` chooses the network; host networking on Linux lets the apps find the gateway over Bonjour. The images are built for amd64 and arm64 and run as an unprivileged user. `omnesis update` on a Docker install moves every image to the same release through the `omnesis-updater` image. The repository ships the Compose files, and the install guide covers persistent storage, keeping the unlock material apart from the data, your own certificates, OAuth callbacks, Tailscale on the host, collectors on other machines and Unraid.
- f8d9a52: The transcriber role can run on any OpenAI-compatible `/v1/audio/transcriptions` server, such as whisper.cpp's `whisper-server` built for CUDA or Vulkan, vLLM or speaches, so a Linux host with a GPU transcribes in seconds what took minutes on the CPU. Assign it with `omnesis model assign transcriber <backend>/<model>`. The backend stays on the gateway's machine unless remote inference is allowed, and personal vocabulary hints are sent only to a backend on the same machine. A transcription that takes longer than five minutes is no longer abandoned and retried, and a recording whose caller has gone is no longer transcribed.
- f8d9a52: Experimental Brain: the Briefs feed is replaced by one morning brief. Brain runs note what you may want to hear about, each morning one run rechecks those notes and writes what still holds into a pinned Morning brief conversation, and nothing is sent when there is nothing to say; replies in that conversation act on the latest brief's items. Brain suggestions appear in Tasks as Suggested until you accept them, and the Brain only proposes changes to tasks you own. It learns what you care about from what you accept, ignore, create or undo in Tasks and from the thumbs on each brief item, and weighs the past reactions most like each new item when it decides what to suggest or mention; `brain.interest.enabled` switches that off. The brief push notification and the `brief-judge` model role are removed.
- f8d9a52: The note agent acts on the Tell Omnesis notes you capture from the portal, the apps or the CLI whenever a `background-agent` model is assigned: one bounded turn per note adds, completes, moves or strikes the tasks it mentions, remembers facts you state about yourself or people you know, answers a question it asks, and leaves a receipt with Undo. A voice note waits for its transcript first. Notes from external agents are saved and searchable but never acted on. `agent.noteAgent: false` (Settings → Models → Background agent → Act on Tell Omnesis notes) switches it off without unassigning the model; notes captured while it is off are never acted on later.
- 8bdaed6: Add `omnesis uninstall`, which removes Omnesis from the machine it runs on: everything it finds, or the components named — `gateway` (the user service, a hardened gateway through `sudo`, or a whole Docker install), `collector`, `openclaw`, `hermes`, `claude-code`, `codex` and `cli` (the installer's checkout, the global package, the launcher, the lock helper and the installer's PATH line). Data stays unless `--purge`, which also deletes the config directory, the service logs, the `dev.omnesis` keyring entries and a hardened gateway's state and passphrase, and is refused while anything that uses the data would stay. `--dry-run` shows the plan, `--yes` skips the confirmation, `--json` reports each step. Harness and client configs lose only their Omnesis entries; a checkout with local changes, a checkout or launcher the installer did not make and a PATH line other programs need are kept and reported. Every step is idempotent and a failed one never stops the rest, so running the command again finishes the job. On a Docker host the launcher performs the uninstall on the host, and `omnesis-gateway-admin uninstall` gains `--purge` and now also clears its build cache.
- f8d9a52: Experimental: the Omnesis Demo iOS app can hold a realtime voice conversation with the Omnesis agent (the Omnesis app does not include it), using the same prompt, tools, permissions and conversation as text. It needs `OMNESIS_EXPERIMENTAL=1`, remote inference allowed, and an OpenAI backend explicitly assigned to the new Speech to speech role with `gpt-live-1`. Audio goes from the phone to OpenAI and is not stored by Omnesis; the transcript, tool activity and citations stay in the conversation.
- f8d9a52: Add Regolo AI as an OpenAI-compatible provider preset (`https://api.regolo.ai`) for the agent and embedder roles, with its Models.dev metadata, logo and model controls.
- f8d9a52: Chat about a task: a task's actions offer Chat about this in the portal and in the iOS and Android long-press menu. It opens a conversation that starts from the task's card, and every turn gives the agent the task as it stands then — its notes, history and linked documents. It needs an agent model assigned.
- f8d9a52: Tasks: a list of what you mean to do, kept like a bullet journal, in the portal (`/portal/tasks`) and the iOS and Android apps, on every gateway with or without a model. Each task has a planned day, month or someday apart from any real deadline, and the Today, Month, Future, Anytime, Waiting and Done views show where it stands. Complete, move, strike or edit a task, see its history with where each change was made, and undo the latest change from its receipt. The agent gets task tools in every conversation, so a task can also change from a chat or a Tell Omnesis note.
- f8d9a52: Search reads the time a query names ("last week", "invoice from March", "Q3 2025", "15 juin") and adds a third ranking lane for the documents written in that window or about a day in it, such as calendar events, bookings and dates mentioned in text, beside keyword and semantic ranking. The time phrase is read from the asker's current time and time zone, which the portal, the CLI and the agents send. `search.temporal.enabled` (default `true`) and `search.temporal.weight` (default 1) tune it.

### Patch Changes

- 5edde4f: Background agent work now waits out problems you fix on the gateway host instead of giving it up: a signed-out, missing or outdated Claude Code, a model the backend does not offer, invalid reasoning controls, or a model server whose context length cut the prompt short. The experimental Brain pauses with the reason shown until you fix it, then carries on with nothing lost. An answer an OpenAI-compatible server stops early, for example on a content filter or an aborted generation, now fails the turn instead of being kept as complete, and Claude Code reports a too-long prompt and a reached output limit the same way the other backends do.
- ea89ee2: Keyword search ranks before reading rows and, once the gateway has built an in-memory copy of the full-text index, ranks in milliseconds. Searches that took seconds for queries with common words now answer in tens of milliseconds, with the same results. The in-memory index uses memory in proportion to the corpus and is rebuilt in the background as it changes; set `search.bm25.memoryIndex` to `false` to rank from disk only. Type-ahead suggestions complete a half-typed last word correctly, and the browser extension's omnibox shows six suggestions.
- 0eac42e: Long recordings now finish on a slow transcriber: each part of a recording (ten minutes, or a minute for an audio language model) gets its own deadline, so a long recording is no longer cut off after 30 minutes in all and retried on every sync, while a server that stops answering is still given up within one part's time. A recording may take up to six hours. A slow vocabulary lookup no longer holds up voice notes and dictation; after three seconds the recording is transcribed without hints.
- affd350: Experimental Brain: a background run can no longer add a page claim that cites a source excluded from the Brain, or change an existing claim that cites one, even when the page already cites that document, so the claim verifier never reads it. A knowledge-maintenance run that ends without settling on every one of its attempts, for example because the gateway is killed each time, no longer holds its pages out of maintenance for good: an hour after its last attempt it is marked failed and its work is retried.
- ebcc6f2: Experimental Brain: saving a page no longer sends a claim that cites a source excluded from the Brain to the claim verifier, so the verifier never reads that source's documents. Such a claim keeps its verification while it still holds and otherwise stays unverified. The morning brief no longer checks an item that cites an excluded source, and page reviews and loop changes no longer show the reviewing model its documents.
- 5434fb8: Transcription vocabulary leaves out structured metadata and quoted or code blocks, keeps full names intact, adds fewer hints that differ only in capitalization, and packs complete phrases without repeating their parts.
- 456c80a: An `omnesis` CLI older than its gateway no longer crashes when the gateway reports a value the CLI does not know yet. `omnesis model list` and `model status` show a model assigned through a newer kind of backend by its name, and `omnesis tls status`, `omnesis doctor`, `omnesis watches list` and `omnesis push status` likewise show a newer certificate source, renewal mode, delivery kind or phone state as the gateway reported it.
- 6a851e9: Add contextual vocabulary hints, learned in bounded background batches from indexed documents, for the gateway's transcriber (local Whisper, or an HTTP transcription server on the same machine) and supported on-device iOS and Android transcription. Mobile apps refresh a bounded dictionary in the background and read it from memory without delaying recording. Vocabulary is on by default; turn it off with `inference.transcriptionVocabulary.enabled: false`.
- 55064b0: Add clarification choices, queued follow-ups, interrupt-and-send corrections, saved drafts, and edit-and-resend to conversations in the portal, iOS, and Android. Accepted follow-ups and unanswered questions persist with the gateway conversation; drafts stay on the device. Queued follow-ups accumulate into one message; Send now interrupts the current turn and delivers that message. Message context menus offer Copy, and user messages offer Edit and resend. Edits append a new prompt and preserve the original exchange. New mobile apps retain ordinary chat with older gateways, and older apps can answer clarification questions in text.
- a8cc1dc: Provider logos that Models.dev serves as editor exports now display in the portal and apps. The gateway strips Inkscape metadata (comments, editor namespaces, `<metadata>` blocks) and rewrites plain paint styles such as `style="fill:#303030"` into attributes before its strict SVG check, instead of refusing the logo; everything else the check refuses, it still refuses. Regolo AI is the first affected provider.
- a2142d0: Going Back to the Chrome extension's Find page, or reloading it, shows that search's results again instead of re-running the search. The browser keeps the current search and the five before it.
- 10d36b2: The gateway keeps within a memory budget instead of being killed when memory runs out. The budget is `gateway.memoryLimitMb` (or `OMNESIS_MEMORY_LIMIT_MB`) when set, otherwise the container's memory limit, otherwise the host's memory; the analytics engine's default memory ceiling now follows it. The semantic search index stays in memory only while it fits: otherwise search answers from keywords alone, and `omnesis status`, `omnesis doctor` and the gateway log say semantic search is degraded and why. The index is saved as it is built and as it changes, on encrypted installs too, so a gateway that is stopped or killed continues from its last save on the next start instead of building the index again.
- 02be313: A source whose icon host is slow or unreachable no longer holds up each sync page. The gateway fetches a source's icon and its family's icon at the same time, once when they share an address, and remembers a failed fetch for five minutes instead of waiting for it again on every page. Each page used to wait up to 30 seconds while the host was down.
- f8d9a52: iMessage audio messages that Messages stores with no MIME type are recognised as audio, so they are transcribed and shown in the day chat instead of being listed as excluded attachments.
- 8c0982c: Deleting a document, or excluding a domain in the browser extension and removing its captured pages, no longer fails now and then with an internal server error while the gateway is indexing new documents. The deletion now waits for the indexer's write to finish. Indexing no longer fails on a document when a deletion lands at the same moment.
- A message submitted again after its answer was already saved is answered at once instead of waiting until another message in the same conversation finishes, and stopping a voice call's queued request while another message is being answered ends that request at once instead of leaving it without a reply.
- 6a851e9: Documents written while the indexer is working through the corpus are no longer left out of search.
- 719e3da: Show a sent message the instant it is sent in the portal, iOS, and Android. A message that starts a turn appears in the transcript before the gateway confirms it, and a follow-up sent while a turn is running appears on the queue card without first disappearing. The gateway's user-message event names the submissions it accepted, so the early bubble is renamed rather than repeated, and a refused send withdraws it so the retry card stands alone.
- 115c44b: Settings survive a rollback or a move to an older release. An older gateway drops the settings it does not know from `omnesis.json` when it next changes the configuration, so upgrading again used to bring them back at their defaults — the note agent switched back on, Brain source exclusions and the transcription vocabulary opt-out gone. The update now saves the configuration as `omnesis.json.newer-settings` before handing it to an older release, and the next release that knows those settings restores the ones missing when its gateway starts, keeping any change made on the older release.
- fa37c8f: Index documents for keyword search when no embedding model is installed or assigned. Enabling an embedding model backfills vectors, including after text changes or deletions while semantic search was disabled, without dropping keyword results.

  Search results name the embedding model in use correctly after a model is enabled, replaced, or disabled without restarting the gateway.

- f8d9a52: Mixed versions with 0.6.0: a 0.7.0 gateway keeps serving 0.6.0 iOS and Android apps, the 0.6.0 Chrome extension, 0.6.0 OpenClaw and Hermes plugins and MCP clients, and 0.7.0 clients keep working against a 0.6.0 gateway, without the features new in 0.7.0. A 0.6.0 app shows the new agent tools as generic tool cards. A 0.6.0 plugin trusts the gateway's exact certificate, so it must be reconnected with `omnesis connect <harness> --refresh` after the gateway renews it; the portal and `omnesis doctor` name it before the renewal. A 0.6.0 configuration still boots: a `brain.workerConcurrency` above 32 runs as 32, and an HTTP backend named `claude-code` keeps serving its assignments.
- 77e1fdd: A Tell Omnesis note captured while the note agent is switched off is never acted on, even when the agent is switched back on within seconds or while it is still reading an earlier note.
- f8d9a52: An Obsidian vault with a symlink to another note, or two notes sharing a frontmatter `id`, syncs again. Each note keeps an identity of its own, a file symlink is skipped and its target is read once under its real path, and a note whose identity changes removes its old document.
- f8d9a52: `inference.ocr.requestTimeoutSeconds` now bounds an image's OCR on the gateway as well as on the collector, with one default of 120 seconds. At the deadline, or when the collector gives up, the gateway stops the backend's work instead of letting it run on and slow the next images.
- ed28de0: Two fixes for the built-in agent on an OpenAI-compatible server such as Ollama. Streamed tool calls that share a stream index are now told apart by id, so a server that streams every call of a response at index 0 no longer has its parallel calls merged into one call with concatenated arguments and the rest dropped. A server that trims a request longer than its context window instead of refusing it, which Ollama does by default, now fails the turn with `prompt_truncated` and a message naming the reported and expected prompt sizes and the remedy, instead of returning an answer the model produced without its instructions and tools.
- f8d9a52: The Chrome extension's `om` address-bar keyword no longer drops what you type when the gateway does not offer Find: pressing Enter sends the text to Chrome's default search engine, as the address bar says beforehand. A query typed while Find was offered is never sent to the web. The extension asks for Chrome's `search` permission for this, which shows no install-time warning.
- 6d8df8d: `omnesis sources reindex-missing` run while the indexer is still starting, or restarting after an embedding model change, now says to try again in a moment instead of failing with an internal server error. When the indexer failed to start or is switched off, it names the reason.
- e263306: Updates on a machine with less than about 5 GB of memory now stop the gateway as well as the collector while the build runs, so the build is no longer killed beside a serving gateway and rolled back; the gateway is down until it restarts on the new release. Docker image builds give the TypeScript compile a 3 GB heap instead of Node's default, which a small builder ran out of. `install.sh --docker --build` checks that Docker's storage has about 25 GB free before building, and says so instead of failing with a containerd export error.
- d7d62db: A queued message whose answer is stopped, interrupted, or cut short by Send now on a later message no longer shows "This message could not finish" with a Retry button. It is already in the conversation, so retrying would have sent it twice. A message that genuinely fails still offers Retry.
- 7d6c2e4: Experimental task suggestions can be accepted with a note, accepted for a chosen day, month or someday, marked already done, or ignored. A note written while accepting is saved as a Tell Omnesis note about that task and applied to it by the note agent. Ignoring a suggestion only takes it out of Tasks: Omnesis keeps tracking the loop behind it and does not suggest it again. On iOS and Android a suggestion looks like any task, with the actions behind a long press, and the banner announcing suggestions sits at the top of Tasks.
- e8b05ac: Check a transcriber backend before assigning it. The gateway asks an HTTP backend to transcribe one second of audio when the transcriber role is assigned to it, and refuses the assignment with the backend's answer when it cannot (a chat-only server with no `/v1/audio/transcriptions` endpoint, a model the server does not have). The Models page says what a transcriber needs, marks a model the backend has refused, and the role reads "configured, but unavailable" with the reason instead of a green check for a backend that will not transcribe. The HTTP transcriber also reads Qwen3-ASR's `language …<asr_text>` prefix as the detected language, so Ollama and llama-server serving that model return clean text.
- d617606: Transcribe through a speech model served only through a chat API. When a backend has no `/v1/audio/transcriptions` endpoint, the transcriber check sends the audio as a chat completion with an `input_audio` part, and a backend that transcribes it is used that way, a minute of audio per request (Qwen3-ASR behind Ollama or llama-server, an audio language model on vLLM, OpenAI's audio chat models). A backend's `transcription` setting pins the protocol and the chunk length; a model answering in Qwen3-ASR's format gets one-minute chunks on the transcription API too. Each request's deadline now allows for a slow audio model on a CPU, and the OpenAI, Groq and Mistral presets, with the Voxtral, Scribe, Parakeet and Canary families, count as transcribers.
- fa7801e: Type-ahead suggestions now complete a last word that starts like a search operator, so typing "or", "and", "not" or "near" suggests "order", "android", "notes" or "nearby". Keyword search right after new documents are indexed also drops the same common words whether it ranks from the in-memory index or from disk.
- f8d9a52: WhatsApp and iMessage day chats show each untranscribed voice note's state — awaiting transcription, no transcriber available, no speech detected, audio unavailable, or audio not downloaded on this device — instead of a bare placeholder. The Sources page, the apps, `omnesis sources` and `omnesis members` show how many notes are waiting, and `omnesis doctor` warns when no transcriber is assigned. iMessage retries a voice note after a transcriber outage as WhatsApp does.
- f8d9a52: WhatsApp works through a backlog of voice notes and attachments page after page, newest days first, instead of clearing about one item a minute after an outage; new messages still come first.
- @omnesis/agent-integration@0.7.0
  - @omnesis/cli-shared@0.7.0
  - @omnesis/collector@0.7.0
  - @omnesis/config@0.7.0
  - @omnesis/core@0.7.0
  - @omnesis/eval@0.7.0
  - @omnesis/gateway@0.7.0
  - @omnesis/gateway-client@0.7.0
  - @omnesis/source-sdk@0.7.0
  - @omnesis/types@0.7.0

## 0.6.0

### Minor Changes

- 3e94207: The gateway reads the dates written in every document's text on every install, without experimental mode or the Brain, and the agents' time queries and **Debug → Calendar** include them. An all-numeric English date such as "10/07/2026" reads month-first when the gateway's time zone is in the United States, a US territory or the Philippines, and day-first everywhere else, including Canada, Latin America and UTC. A gateway whose time zone is UTC, as a container often is, therefore reads US-style dates day-first: set `enrichment.dates.numericDateOrder` to `month-first` or `day-first` to choose explicitly.
- 2f2680e: Tell Omnesis voice notes can be transcribed by the gateway's transcriber. While a transcriber is assigned and the new `inference.dictation.transcribeOnGateway` setting is on (the default; Settings → Models → Transcriber, or Settings → Voice in the apps), the iOS and Android apps record Tell Omnesis — including Apple Watch notes — as a voice note: the note is saved at once and the gateway replaces its text with its own transcript when ready. Watch notes wait on the watch until the iPhone receives them, and the watch returns to its face after sending. Omnesis Demo gains its own Apple Watch app.
- 4b975f5: Gmail reads mail more faithfully. A message is dated by its `Date` header rather than by when Gmail received it, so mail imported from another account sits in the year it was sent. Bodies are decoded in the charset they declare, a "view in browser" or abridged plain-text part gives way to the HTML that carries the message, the date line no longer renders as a heading, Bcc recipients on sent mail join the people graph, automated senders no longer create people, and signature logos are no longer indexed as attachments. A first sync keeps listing the mailbox until Gmail has no more pages, so the oldest mail is no longer left unread, and a message deleted between being listed and being fetched is treated as deleted rather than as an expired history. The changes apply to mail synced after the update; mail already indexed keeps its current form until the source is resynced.

  Shared attachment extraction improves for every source: legacy PowerPoint files are read from their text records instead of their raw bytes, binary noise from old Office files is no longer indexed as text, text attachments honour their declared charset, image file names in URLs are no longer taken for email addresses, and one slow OCR request no longer pauses OCR for every image after it. `inference.ocr.requestTimeoutSeconds` sets how long a collector waits for one image's OCR.

- 52f8455: New Maildir source. It indexes email that a mail tool keeps on the collector's machine as a Maildir — mbsync, offlineimap or getmail, for example — without Omnesis connecting to the mail server itself, which makes it the way in for accounts whose provider allows only approved mail apps. A message stored in several folders, as Gmail's labels are, is one document tagged with every folder. Folder changes, stars and replies update it without re-reading its attachments, and deleting its last copy removes it. Drafts, spam and trash are skipped. Thunderbird accounts kept in its file-per-message (maildir) store are read too.
- ba922cd: Plaid and Local Files are no longer experimental. Every collector now offers them in **+ Add source** without `OMNESIS_EXPERIMENTAL=1`, and a collector that already hosts one keeps syncing it with the flag off.

### Patch Changes

- 4e47b47: When an agent signs in again and you choose a connection for it to replace, each connection now reads "Access level: …" instead of "Uses …". The line names the access level the connection uses, which can be shared by several connections and is often named after the agent it was first made for, so "Uses OpenClaw" under a Hermes connection read as if Hermes were OpenClaw.
- 19e245b: Update brace-expansion within its existing major versions to fix denial of service vulnerabilities in brace parsing and expansion.
- d25b1d5: On macOS, a collector that dies without a clean exit now always comes back — whether it crashed, was killed by its event-loop watchdog, or was killed outright, for example by the system when memory runs out. launchd can hold back the respawn a LaunchAgent's `KeepAlive` asks for — it records the restart and waits for something to demand the job — which left the collector down until it was started by hand. Each collector now starts a small guard process beside it that, once the collector's process has ended, waits out the LaunchAgent's throttle interval and asks launchd to start the job again unless it is already running, ended with a clean exit (such as a collector parked for re-pairing), or was stopped with `omnesis service stop`. Linux is unaffected: systemd restarts a failed collector unit on its own.
- 0aab430: The portal, iOS and Android chat show copy buttons beside inline code values and multiline code blocks in completed assistant answers. The agent formats addresses, phone numbers, identifiers and requested drafts with standard Markdown so older clients can still display them. Copying puts just the value on the clipboard, without its label or Markdown delimiters.
- e3fecd3: The Docker images now ship their dependencies with the repository's patches applied, as source installs always have. Without them, a WhatsApp source running in the collector container let libsignal print whole Signal session records — ratchet private keys and root keys included — to the container's log each time a session was opened, closed or pruned; the images also lacked the Baileys pairing-platform fix and the better-sqlite3-multiple-ciphers type export. The image build now fails when a patch no longer applies, and the runtime smoke checks each patched file in every shipped image.
- 3e94207: If you ran a WhatsApp source in the collector container from an earlier Docker image, that container's logs may contain Signal session records, which include session keys. After updating, rotate or delete the old collector container logs, for example by recreating the container, and remove any copies a log driver or log collector has shipped elsewhere. Source installs are not affected.
- be832f0: A long-running gateway no longer starts refusing every sync page from a source that declares URL patterns, Strava among them, with "must be a supported safe regular expression" until it is restarted. The gateway checks those patterns with a WebAssembly build of RE2 whose memory is fixed at 16 MiB, and every check left a little of it behind until none was left; the dependency is now patched to free it.
- 12f10e4: Gmail: a message whose text is split across several parts, or whose large body Gmail returns by attachment id, is read in full instead of from its first part. A small inline image is kept when its text adds a phone number, an email address or several words the message does not already carry.
- 272d590: Hermes: a scheduled job or other tool call no longer fails with "Omnesis corpus authorization needs repair" when the Hermes gateway renewed the Omnesis credential while the tool still held the previous access token. The adapter now renews from the gateway when the token it picked up from disk has already expired.
- 3e94207: An OpenClaw or Hermes integration no longer has to be approved again because one token refresh was slow. When the gateway took longer to answer a refresh than the integration waited, it still rotated the refresh token, and the integration was left holding a spent one; `omnesis connect --refresh` then fell back to a new approval. A token refresh now waits up to 55 seconds for the gateway, long enough for the write stall a gateway shows right after a restart, and repeats once a refresh whose answer never arrived — a timeout, a dropped connection or a server error. The gateway answers that repeat with the tokens it already issued for two minutes after rotating them. Concurrent refreshes from the same integration wait correspondingly longer for each other.
- e83263d: Maildir: a message whose Date header lies before 1980 or more than a day in the future is dated by its mail server's Received stamp instead.
- 8ef86a6: Show readable document connections and matching-text copies in iOS and Android search results. Mobile clients request optional graph context only from gateways that advertise support, while older clients and gateways retain ordinary search behavior.
- 3cf5ddb: `omnesis connect openclaw` works with OpenClaw 2026.9.6 again. That release reports a missing legacy `omnesis-bridge` plugin in new words, which connect took for a real failure and stopped. When OpenClaw instead finds an `omnesis-bridge` copy it did not install and refuses to remove it, connect now says how to find and delete that copy before running it again.
- b1f897c: OpenClaw: when the gateway refuses an expired Omnesis access token, the plugin renews it with its refresh token again, including when the gateway's authorization server is on another address than its MCP endpoint. Previously that renewal was refused locally and every expiry fell back to re-issuing the credential with the device's management token.
- 2a0bf0f: When a Strava account runs into the rate limit Strava counts against the API application, the other Strava accounts a collector connects through that application now also show as rate limited, not only the one that hit it. A rate limit counted against one account no longer shows another provider's sources as rate limited because they are signed in with the same account name, such as a mailbox and a note-taking app on one email address. This changes only which sources show as rate limited.
- 19e245b: Add graph-aware agent search with bounded document trails, grouped matching extracted text and readable context. Search v2 is enabled by default; set `search.v2.enabled` to `false` to restore legacy behavior. Inspect copy locations, source links and breadcrumbs with `omnesis search --agent-context` or the portal search page. Ordinary search response fields and mobile interfaces retain their existing behavior.
- 2a0bf0f: Two Strava accounts synced into one gateway no longer stop each other. When it chose which activities to enrich, each account's source also read the other account's, fetched them with its own token and wrote them back as the other athlete's, which the gateway refuses; the refused write was retried on every sync, so the source stopped listing new activities, and what it had stored of the other account's activity could stop that account's source too. Each source now reads only its own athlete's activities. Strava sources already stopped this way start again once every Strava source on the gateway is resynced, from the Sources page or all at once with `omnesis sources resync strava-activities`.
- 2a0bf0f: The Strava source keeps each activity's splits, best efforts, laps, segment efforts and zones. Every page that fetched them deleted them again as it wrote them, so those tables stayed empty. Activities enriched before the update stay without them until the source is resynced, from the Sources page or with `omnesis sources resync strava-activities`. A resync fetches every activity again within Strava's daily read limit, four or five reads per activity, so for a large account it takes days.
- 2a0bf0f: The Strava source's count in the portal and in `omnesis status` is its number of activities. It used to add up every Strava table — kudos, gear, splits and the rest — and so showed more activities than the account has.
- 2a0bf0f: Strava activity documents keep every part of an activity as its details, comments and kudos are fetched. Fetching comments and kudos used to write the document again without the description, calories, device, perceived exertion, top results and photo caption, and fetching details again wrote it without the comments and kudos, so after a first sync every document had lost its description; the caption is kept in a new `photo_caption` column of `strava_activities`. Fetching an activity's details no longer sends it back for the comments, zones and streams already fetched for it. Documents name the gear an activity used, not its gear id, without waiting for the weekly athlete refresh, and an activity edited on Strava keeps its gear when it is written again. A pace whose seconds round up to a minute reads `6:00 /km`, not `5:60 /km`, and an activity's start time reads the same however its document was last written. Documents already stored change when their activity is next written: after an edit or new kudos or comments on Strava, or after a resync from the Sources page or with `omnesis sources resync strava-activities`.
- 2a0bf0f: The Strava source picks up activities and edits it used to miss. An activity uploaded with a start time more than a month back — history imported from another service, or a watch synced after weeks offline — is added by the daily check of the whole activity list, which used to read it and write nothing; an edit to an activity older than a month arrives the same way. A crop, a corrected distance or elevation, or a changed duration or start of a manual activity counts as an edit, so the activity's details, splits, comments, kudos and streams are fetched again. When kudos or comments arrive, the activity's comments and kudos are fetched again and its counts follow Strava's; after the update this happens once for each activity whose counts changed since it was first listed. The daily check and the six-hourly check of the last month's activities keep running while the source works through a backlog of activity details instead of waiting for it to finish, and they stop short of the rate limit as the backlog does, leaving the listing of new activities reads of its own. A Strava account that had no activities when it was connected lists every activity added later, not only the newest hundred. A bike or pair of shoes deleted on Strava now leaves the `strava_gear` table at the next weekly athlete refresh.
- 2a0bf0f: The Strava source copes with Strava deactivating the install's API app. Strava deactivates a Standard Tier API app whose owner, the Strava account that registered it, has no active subscription, and then refuses every request made through it. The source used to read a refusal of an activity's zones or streams as that activity refused and mark it done, so a deactivated app could empty those backlogs with nothing fetched, and reactivating the app brought none of it back; the activity listing and the fetches of details and comments failed with an error that did not say why. A deactivated app now stops the source with the steps to fix it: subscribe on the owner's account, then reactivate the app on Strava's API settings page. Nothing is written while the app is deactivated, and once it is reactivated the source carries on where it stopped. The athletes connected through the app need no subscription. Activities already marked done this way are fetched again after a resync, from the Sources page or with `omnesis sources resync strava-activities`.

  For an athlete without a Strava subscription, the source no longer asks Strava for each activity's heart-rate and power zones, which Strava refuses one read at a time; it asks once the athlete's profile shows a subscription. A profile that reports no subscription only in its older `premium` field counts as one without. An activity's zones that Strava serves without the time spent in each zone, or without saying whether they are heart-rate or power, no longer stop the source from fetching zones; what can be stored is stored and the activity is marked done. The setup wizard and the Strava entry of the sources documentation say that the app's owner needs a subscription, and that a new app connects one athlete and can be raised to ten.

- 2a0bf0f: Strava's open-ended top heart-rate or power zone is stored with no upper bound (`max_value` null) instead of `-1`, which read as a bound below every other zone's, so a query such as `max_value < 150` counted the top zone among the lowest. The descriptions of the cadence, workout type and zone points columns now say what Strava reports in them. The athlete's zones change at the next weekly athlete refresh; an activity's zones already stored change after a resync, from the Sources page or with `omnesis sources resync strava-activities`.
- 2a0bf0f: The Strava source keeps listing new activities while it works through a backlog of activity details, comments, zones and streams. A batch the rate limit could not cover used to hold back the whole source, and new activities waited with it; working through the backlog now stops at 80% of Strava's limits, which leaves the listing reads of its own. When Strava itself refuses a request as over its limit, the source now reads which window is spent from the read limit as well, the one a new Strava app reaches first, and waits until that window resets: until midnight UTC once the day is spent, rather than trying again every quarter hour, or every hour once the overall day was spent.

  An athlete with more gear than one 15-minute window of reads can fetch no longer stops the source: the athlete refresh waited for a window that could cover all of its gear at once, which never came, and new activities waited behind it. It now fetches what each window allows and carries on in the windows after. A newly added Strava source syncs every 30 minutes rather than every 5. A Strava source added earlier keeps the interval it has; `omnesis config set /sources/strava-activities/syncInterval 30m` gives it the new one.

- be832f0: The Strava source no longer spins when it runs out of API budget. It used to ask for the same empty page dozens of times a second, each one a round trip to the gateway, and because it never let go of usage counted in a window that had already reset, the loop did not end when the window did. It now shows as rate-limited and waits until Strava's 15-minute or daily window resets.
- 2a0bf0f: Connecting Strava asks for Strava's permission to read activities as well as the one for private activities, so an athlete who unticks private activities on Strava's authorization screen still has a source that syncs their other activities, and one who unticks every activity box is asked to connect again instead of seeing an unexplained error on every sync. While a grant leaves private activities out, those already synced are removed; connecting again with the box ticked brings them back at the next daily check of the activity list. The sign-in now says what each unticked box leaves out, also when it goes through the gateway's public address, and the setup wizard asks for that address's host name as the callback domain.
- 2a0bf0f: One activity Strava keeps failing to serve no longer stops the Strava source. Such an activity used to end every sync on it: the activities behind it were never enriched and new activities stopped being listed until a resync, which met the same activity again. The source now asks for that activity again after half a day, and after its third failure, a day after the first, carries on without that part of it; when Strava itself is down, a sync still stops with the error as before. A batch of long activities' streams larger than the gateway accepts in one request was also sent again on every sync and stopped the source the same way; the source now sends streams in batches the gateway accepts, and stores none for an activity whose streams alone are too large. An activity whose details, comments or kudos Strava refuses is passed over rather than stopping the sync.
- e86284b: An update no longer leaves an OpenClaw or Hermes integration without corpus access, and an approval you give is no longer lost. `omnesis update` and fleet updates refresh the plugin with `connect --refresh --no-interactive`: a working sign-in is left to the plugin, a missing one is re-issued with the agent device's own credentials, and when nothing approved is left the refresh stops and names `omnesis connect <harness> --refresh` instead of opening approval requests nobody waits on. A refresh run without a terminal behaves the same way. An interactive refresh asks for a new approval only after those headless steps fail, keeps a single request open per integration across runs, waits for that request's whole lifetime through a stalled gateway, and the next refresh collects an approval given after the command stopped, within the request's ten-minute lifetime. The gateway ends an agent's older open request when the same agent opens a new one, so the phone never offers an approval the agent cannot receive. A refresh never erases the stored tokens before it has replacements, and both plugins re-issue a token set that a stopped refresh left missing, instead of refusing the credential file.
- 27f40cf: Date extraction waits for a voice note's gateway transcript — up to `enrichment.dates.pendingContentWaitMs` (1 hour) — so the dates a Tell Omnesis voice note mentions are read from the gateway's words rather than the phone's interim transcript.
- 9c6e93d: Gateway dictation for Tell Omnesis is on by default whenever a transcriber model is assigned, without experimental mode; set `inference.dictation.transcribeOnGateway` to false to keep the phone's transcript only. The Brain waits for a voice note's gateway transcript — or for the gateway to give up on it — before reading the note, up to `brain.pendingContentBarrier` (1 hour), so it reads each note once, in the gateway's words. Apple Watch notes dictated as text are kept on the watch until the iPhone confirms it has them, like recorded voice notes. The portal's Tell Omnesis page marks a voice note still being transcribed, and no longer shows the gateway's transcript as an edit.
  - @omnesis/agent-integration@0.6.0
  - @omnesis/cli-shared@0.6.0
  - @omnesis/collector@0.6.0
  - @omnesis/config@0.6.0
  - @omnesis/core@0.6.0
  - @omnesis/eval@0.6.0
  - @omnesis/gateway@0.6.0
  - @omnesis/gateway-client@0.6.0
  - @omnesis/source-sdk@0.6.0
  - @omnesis/types@0.6.0

## 0.5.14

### Patch Changes

- e8c77e2: The Android app now cancels a session's launch reads when the session ends. After re-pairing or unpairing, a read still in flight no longer reaches the old gateway or refills the source list the app had just cleared.
- 344aaef: ChatGPT can connect to a gateway again. It identifies itself with a client metadata document that authenticates by a signed key (`private_key_jwt`) rather than as a public client, and the gateway refused every such client with "Client metadata could not be verified." The gateway now accepts these clients: it fetches the key set their metadata document names, verifies each signed client assertion at the token and revocation endpoints (signature, issuer, audience, expiry and single use, and the signing algorithm when the document names one), and advertises `private_key_jwt` in its authorization-server metadata. A metadata document that also lists grant types this gateway does not offer is no longer refused; those grants are ignored, and the document must still offer the authorization code flow. When a client's metadata cannot be verified, the gateway log now says why.
- 677df17: Keep `omnesis` commands working on the gateway's own machine while Tailscale is down. Once the gateway serves a Tailscale certificate, the address recorded for other machines is its tailnet name, and the CLI and collector beside the gateway kept dialling that name, which stops resolving when Tailscale is disconnected — so every command failed with "Cannot reach gateway" although the gateway was running. They now reach the gateway over loopback by that same name, still verifying its certificate against the name it was issued for.
- 72139b9: Offer Claude Code and Codex the one-time certificate trust step instead of blocking them. On a gateway serving a mkcert certificate, the portal's Connect an agent dialog now shows both agents a copyable `export NODE_EXTRA_CA_CERTS=…` (Claude Code) or `export SSL_CERT_FILE=…` (Codex) line naming the mkcert root that issued the certificate, before their usual commands. On the gateway's own self-signed certificate, Codex gets the same step with the gateway's certificate file, and Claude Code stays blocked with a notice that it cannot trust a self-signed certificate and how to give the gateway one it can. The access overview reports the kind of certificate the gateway serves and that trust file. The installer, the install prompt and the install docs now warn when a gateway ends up without a Tailscale certificate, naming the agents that cannot connect and the fix.
- d65c96a: The portal's Connect an agent dialog shows a grid of general agents, each with its own icon: Claude Code, Codex, ChatGPT, the Claude apps, Antigravity, OpenClaw and Hermes. Choosing one shows only that agent's setup, with the gateway's address filled in and a link to its section of the docs. Agents that connect from the Internet are marked with a warning on a private address, which they cannot reach, and the dialog then offers no command for them, only how to publish the gateway. OpenClaw and Hermes show the one-line installer and the `omnesis connect` command with a pairing code minted in place and, where the address presents the gateway's own certificate, its fingerprint. The Codex card and docs say that Codex 0.147 or later is needed to complete the sign-in. Claude Code offers the plugin first, as the recommended path, then the server alone. Claude Code and Codex say how to finish the sign-in on a machine without a browser, and the docs gain a section on it. Antigravity CLI replaces Gemini CLI, which no longer serves personal Google accounts. ChatGPT connects only on port 443, so its card warns when the address uses another port, and its note links OpenAI's developer mode guide. The step for the sign-in code says it applies only when the sign-in page shows one, and the page no longer repeats Connect an agent in its header while its empty state offers it. The access overview (`GET /admin/access`) now lists every MCP resource the gateway accepts, whether a client there meets the gateway's own certificate, and the certificate's fingerprint. The editor entries and the editor setup skill are gone; any other OAuth-capable MCP client still connects with the MCP URL.
- c3ad46e: The Connect an agent dialog no longer shows Claude Code or Codex setup commands that cannot work on a gateway serving its self-signed certificate. Both agents accept only a publicly issued certificate, so their cards now say so and link to setting up a Tailscale certificate or a domain. The access overview reports whether each MCP address serves a publicly trusted certificate.
- 1b13352: Development dependencies are updated for published security advisories: the build tooling's TOML parser, and the OpenClaw release the OpenClaw integration is checked against, now 2026.7.35, which carries patched URI, IP-address and HTTP-client libraries. The gateway, collector, CLI and apps ship no changed runtime dependency, and the OpenClaw integration still supports OpenClaw 2026.7.1 and later.
- 459b053: Direct MCP connections gain a read-only `list_tables` tool that returns, page by page, the analytics tables and columns the connection may query with `run_sql`. Clients that keep only the start of a server's instructions no longer lose the table list: the instructions now open with the privacy warning, untrusted-data handling and the discovery step, and a refused query points at `list_tables`.
- 5491347: An agent connection can no longer be approved with Answer or Direct allowed but no source readable, which left the agent answering every question with "I can't see that". The gateway refuses such a rule for approvals, access levels and grant edits, and the portal's source step says so. The Sources page gains a card, shown while no agent is connected, that suggests connecting Claude, ChatGPT, Codex, Antigravity, OpenClaw or Hermes and opens the Connect an agent dialog.
- 031f7e3: `omnesis connect openclaw|hermes` now loads the plugin it installed. It restarts the harness (`openclaw gateway restart` or `hermes gateway restart`), asking first on a terminal because a restart interrupts a running agent. `--yes` restarts without asking, and `--no-restart` prints the command instead. It then asks the harness whether the Omnesis skill is ready and reports the answer, with the command to run when the skill is not ready. `--refresh` restarts the harness the same way. `--skill-only` changes no plugin, so it restarts nothing.

  The installer's `--openclaw` and `--hermes` roles no longer reinstall Omnesis over a machine that already runs it. On a host with a recorded checkout or a registered gateway or collector service, the role connects with the `omnesis` command already there and leaves the checkout, launcher, services and config as they are. When that command is too old for this connect, the role offers the machine's own `omnesis update` first, or stops and names it when there is no terminal. The harness roles no longer initialize or migrate the keyring, so they no longer seal an existing collector's credentials as a side effect.

  In the portal's Connect an agent dialog, an address counts as direct to the gateway only when it presents the gateway's certificate on the port the gateway listens on. A Tailscale Funnel address that serves the same certificate is now labelled as a proxy, and its command still pins the fingerprint.

- 7004b29: OpenClaw and Hermes can use Direct and Notes when their connection's access level grants them. Each plugin lists the connection's tools on `/mcp` and offers the Direct and Notes ones as native tools named `omnesis_` followed by the gateway's tool name — `omnesis_list_tables`, `omnesis_run_sql`, `omnesis_add_note` and the rest — with the gateway's own descriptions and input schemas, forwarding each call to the same gateway tool. A connection without Direct or Notes is offered none of them. OpenClaw re-reads the connection's tools every five minutes and whenever the gateway refuses a call; Hermes reads them when it loads the plugin, so it picks up a newly granted tool on its next restart. Both keep the last listing so a restart with the gateway down keeps the tools they had. The installed skill describes the new tools, and `/mcp` responses of up to 4 MiB are accepted so the largest Direct results reach the agent.
- a3501ba: Re-running the Connect an agent command for OpenClaw or Hermes on a machine that is already connected now reconnects it instead of failing with a device conflict. The machine proves it is the same installation with the credentials it already holds, so the agent device keeps its id, watches, and history, and its old credentials stop working. When the harness is already connected, the portal card asks whether the code reconnects that device or connects another machine, and a machine that lost its saved credentials is told which card choice to use.
- dbc1e6f: `omnesis update` now refreshes the OpenClaw and Hermes plugins when `omnesis` is not on the PATH the update runs with — as it is not for an installer-managed install updated over SSH, from a background service, or by the portal's fleet update. The refresh runs the CLI the update just installed by its path, so the harness restart that follows it is no longer skipped.
- d371e9c: `omnesis connect hermes` accepts Hermes's default background process notification mode, `concise`, which Hermes's installer writes since v0.21. It reports every finished background process, so a completed approval still wakes the agent; only `error` and `off` are still refused.
- 7c25a59: Re-running the installer on a machine whose last update was interrupted now reads the installed version from the build the update returns to even when `--source-dir` names the checkout through a symlink, as a macOS temporary directory under `/var` is. The installer handed the updater the path as typed, which did not match the physical path in the update record, so it judged the version by the half-applied checkout and could leave out the `--force` an updater older than 0.5.6 needs.
- 0bcf505: The iOS app now accepts a pairing payload typed into the Paste JSON sheet with the keyboard's curly quotes. The sheet also stops autocorrecting and capitalising what you type.
- 75c4f2b: A join whose first connection times out (a firewall that drops rather than refuses, such as a cloud security group or a DROP-target zone) now says it cannot reach the gateway at the address it dialled, and the installer says the pairing code was not used. It used to print a stack trace and tell the operator to mint a fresh code.
- 01f9a6b: The `add_note` MCP tool now requires a UUID `id` for each capture and echoes it in the receipt as `captureId`, beside the saved note's own `id`. A retry with the same capture ID saves one note even after the connection is signed in again, and captures from separate connections stay independent. Notes saved before this change keep their IDs when retried. The tool is now marked idempotent.
- 32cee6b: On a Mac with Homebrew's mkcert, the gateway can renew its mkcert certificate: it now looks for `mkcert` in Homebrew's bin directories when its service PATH does not include them, as on Apple Silicon, where renewal failed with "`mkcert` is not installed or not on the gateway's PATH". `omnesis tls provision` and the installer look there too.
- 1a15e62: Installing or updating from source no longer fails twice, and on every re-run, because of a broken node-gyp header cache. node-gyp keeps the Node headers that native modules compile against in a per-version cache outside the checkout and trusts it from then on; a header download killed part-way, or several native modules fetching the headers at once into an empty cache, could leave `common.gypi` empty or missing there, and every later `npm ci` failed on it ("common.gypi not found", or a `SyntaxError` in it) — retrying from an empty `node_modules` did not help. Before each `npm ci`, the installer, the source launcher's dependency recovery and `omnesis update` now discard the running Node's header directory unless it is complete and fetch the headers once, before npm builds anything; nothing else in the cache is touched. The Docker image build compiles against the image's own Node headers instead.
- 536162a: Keep headless OAuth recovery working for OpenClaw and Hermes for the whole life of an approved connection. When a harness could no longer refresh its Omnesis ticket, the gateway re-keyed the approved credential by reading the audience and scope from the original authorization request — a row the access cleanup deletes minutes after approval. From then on recovery answered as if the grant had been revoked, and the harness told the operator to run `omnesis connect <harness> --refresh` although its grant, device and credential were all valid. The approved audience and scope now live on the credential itself, and existing credentials are filled from their surviving authorization requests or tokens on upgrade. The OpenClaw plugin now logs why a refresh failed when it falls back to recovery, and names that reason in the error if recovery fails too.
- 89df595: `omnesis connect openclaw` works again on OpenClaw 2026.8.1 and later, which refuse to install a plugin that declares capabilities until the installer accepts them. Connecting OpenClaw is the request to install the Omnesis plugin, so `connect` now accepts that plugin's declared capabilities and prints a line saying so; `connect --refresh`, `omnesis update` and a fleet update of the agent machine do the same. OpenClaw releases before 2026.8.1 are detected and installed as before. The OpenClaw release the integration is checked against is now 2026.9.2, which also drops the outdated HTTP-server libraries the previous one carried.
- ea7b5b4: On macOS, restarting the gateway service now reaches a gateway that an earlier run of the service left behind. When such a gateway kept running, launchd's own gateway waited on its configuration directory, gave up and was restarted, over and over, while `omnesis service restart` and the restart in `omnesis update` reached only launchd's copy: the update waited ten minutes for a version that could not start and rolled back. Starting, restarting, reloading, stopping or reinstalling the gateway service now first stops a gateway that holds the service's configuration directory and was started by that service but is no longer its process. A gateway you run by hand is left alone.
- 03ab8f0: Re-running the installer with `--port` on an installed gateway now names every device paired from another machine before it moves the port, since each one still dials the old port, and the closing banner prints what points each at the new one: for a collector, a repair code and the installer line that registers its service on the new address. `omnesis devices list --json` prints the device list for scripts, and `omnesis devices repair` on a collector says how to redeem the code when the gateway has moved.
- c633aaf: The portal's bundled browser libraries are refreshed to their current patch releases: DOMPurify 3.4.16, marked 18.0.14, sql-formatter 15.9.0 and the CodeMirror editor packages. The gateway's MCP server and the OpenClaw integration's MCP client move to MCP SDK 2.1.0.
- 64a3d63: Search under load no longer answers from a stale index. When more searches arrive than the search workers admit, the overflow runs on the gateway's main thread, which read a snapshot refreshed only every ten minutes, so documents indexed since the last refresh were missing from those answers and the same query could return different results depending on load. The main thread now reads the current index whenever search workers are on; `search.snapshot` applies only when they are disabled.
- e99fe75: The list of sources you can add opens quickly again on slower machines: the gateway draws each source's SVG icon once and reuses it, where it used to redraw every icon on every request, which took tens of seconds on a small machine.
- 13734fa: Source installs on 0.5.13 can update again. Their update installed the next release's dependencies over the existing `node_modules`, and npm crashed on that install and rolled the update back every time. The next release's dependency tree installs cleanly over 0.5.13's, and an update, a rollback and the source launcher's recovery now retry a failed dependency install once from an empty `node_modules`. The build tooling's YAML parser is also updated to a release with a prototype-pollution fix.
- 9118b6c: A Tailscale CLI that hangs no longer stalls Omnesis: the installer, `omnesis tls provision` and the gateway's certificate renewal give each `tailscale status` 10 seconds before moving on to the next place Tailscale may be, and bound `tailscale cert` at five minutes. Before, a hung CLI held the installer for as long as it hung, once per check.
- 02848be: On a Mac with Homebrew's Tailscale, the gateway can renew its Tailscale certificate and find the tailnet for pairing addresses: it now looks for `tailscale` in Homebrew's bin directories when its service PATH does not include them, as on Apple Silicon. The installer looks there too when it is run from a shell whose PATH lacks them.
- 6629d9d: When the gateway cannot renew a Tailscale certificate, its error now names the real reason: a Tailscale CLI that answered but is not connected (for example logged out) is reported with its state, and when no CLI could be run at all, every place the gateway looked is listed along with its PATH. Before, it named only the last place it looked, which on a Mac was usually a Tailscale app that was never installed.
- 26e0537: `omnesis tls provision` on a machine whose gateway still serves its self-signed certificate now activates the new certificate in the running gateway, as it already did elsewhere. It used to say "Not activated yet (fetch failed)" and ask for `omnesis service restart`, because it reached the gateway without trusting the certificate saved for it; it also skipped the warning about paired phones for the same reason.
- 369f328: `omnesis tls provision` now exits non-zero when it provisions nothing: when no trusted-certificate path is available, when `tailscale cert` or mkcert fails, and when a certificate is already wired and `--force` was not given. It printed the right guidance before but always exited 0, so scripts could not tell.
- d6c7768: After `omnesis tls provision` replaces a self-signed certificate with a Tailscale one, the collector on the gateway's own machine reconnects. Its service still dialled `https://localhost`, which the new certificate does not cover, so it waited forever on "its certificate changed … and is not trusted here". Provision now regenerates that collector's service definition by the rule `omnesis service install` and `omnesis update` use, so it dials the name the certificate covers, and restarts it.
- 06515e9: On Linux, `omnesis tls provision` now takes the Tailscale operator permission for your account when tailscaled refuses it a certificate ("Access denied: cert access denied"), as the installer already did, and mints the certificate. It asks through sudo or doas only where a password prompt can be answered, or where none is needed; otherwise it names the command to run, as before. It also records the MagicDNS address as one phones verify through their own system trust (`OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN`), as the installer does.
- da8a18c: Pinning a gateway's certificate with `--trust-fingerprint` works behind Tailscale serve or Funnel. The certificate probe now names the host it dials, as every TLS client does; a front that serves several names refused the nameless handshake with "tlsv1 alert internal error", so `omnesis connect openclaw|hermes` and pairing failed there.
- 38afcae: A source update on a Linux machine short of memory no longer rolls back because the gateway was killed while it built. The gateway, refused a start by the source launcher until the build is in place, is restarted by systemd every two seconds, and those starts spent the unit's start limit, so systemd could refuse the update's own restart and the update undid a build that had succeeded. `omnesis update`, `omnesis service start` and `omnesis service restart` now clear a unit's recorded failures before starting it.
- 85bce6b: An update whose new gateway exits on boot rolls back within seconds instead of waiting out the whole ten-minute health wait. Between health probes the update now asks systemd or launchd whether the gateway is still running, and rolls back once the service manager has relaunched it twice or has held no gateway process for 15 seconds. A gateway that is still running keeps the whole wait, so a long migration is never cut short.
  - @omnesis/agent-integration@0.5.14
  - @omnesis/cli-shared@0.5.14
  - @omnesis/collector@0.5.14
  - @omnesis/config@0.5.14
  - @omnesis/core@0.5.14
  - @omnesis/eval@0.5.14
  - @omnesis/gateway@0.5.14
  - @omnesis/gateway-client@0.5.14
  - @omnesis/source-sdk@0.5.14
  - @omnesis/types@0.5.14

## 0.5.13

### Patch Changes

- 7a4a80c: Agent plugins install cleanly across clients. Codex signs in with its default client registration: the gateway accepts the port a native client's loopback redirect is assigned at sign-in for clients identified by a metadata document too, as RFC 9700 allows, so `codex mcp add` alone connects and no `--oauth-client-registration dcr` or separate `codex mcp login` step is needed. The guidance plugin in `plugins/omnesis` uses the portable agent-plugins.org 1.0 format and is listed for Codex, GitHub Copilot CLI and VS Code, which no longer pick up the Claude plugin whose URL only Claude Code can fill in. Its Codex marketplace is now named `omnesis`: remove an existing `omnesis-openai` marketplace with `codex plugin marketplace remove omnesis-openai`, then add the repository again and install `omnesis@omnesis`. The Claude Code plugin gains a setup skill and a README, and takes its URL with `--config` when installed from a terminal. The portal's Connect an agent dialog lists the command or install link for Claude Code, Codex, Gemini CLI, GitHub Copilot CLI, VS Code and Cursor with the gateway's address filled in. Plugins no longer ship their test files.
- 89724c2: `omnesis update` now restarts OpenClaw and Hermes when their command is installed outside the PATH the update runs with — as it is for a fleet update started from a background service or an update run over SSH. It looks for the harness where its installer puts it (npm's global prefix, `~/.local/bin`, Homebrew, `/usr/local`) the same way the harness plugin's own self-update does.
- 6c788ca: Running the install command again on a machine it already set up updates that install: the installer uses the checkout the earlier install recorded, lets it fetch from its origin again, and runs the machine's own `omnesis update`, which backs up, rebuilds, refreshes service definitions, restarts and rolls back as usual. Certificate, keyring, embedding model and pairing are left alone, so a collector no longer asks for a new pairing code. `--reconfigure`, `--collector` or `--client-only` on a machine with another role, or a first install that never registered its services, runs the full install, which now restarts the services the machine already had so a rewritten service definition takes effect.
  - @omnesis/agent-integration@0.5.13
  - @omnesis/cli-shared@0.5.13
  - @omnesis/collector@0.5.13
  - @omnesis/config@0.5.13
  - @omnesis/core@0.5.13
  - @omnesis/eval@0.5.13
  - @omnesis/gateway@0.5.13
  - @omnesis/gateway-client@0.5.13
  - @omnesis/source-sdk@0.5.13
  - @omnesis/types@0.5.13

## 0.5.12

### Patch Changes

- Updates the `hono` web framework to 4.13.8.
  - @omnesis/agent-integration@0.5.12
  - @omnesis/cli-shared@0.5.12
  - @omnesis/collector@0.5.12
  - @omnesis/config@0.5.12
  - @omnesis/core@0.5.12
  - @omnesis/eval@0.5.12
  - @omnesis/gateway@0.5.12
  - @omnesis/gateway-client@0.5.12
  - @omnesis/source-sdk@0.5.12
  - @omnesis/types@0.5.12

## 0.5.11

### Patch Changes

- 2bcb587: Phone pairing offers only addresses the phone can use. The portal's pairing dialog and `omnesis devices pair`/`repair` open on the best address for the iPhone or Android phone being paired and say where it works. They list the other usable addresses and name the refused ones with the reason. An iPhone is no longer given the gateway's Tailscale IP, which iOS refuses with the gateway's own certificate. The local name offered is the one the gateway announces with the machine's LAN addresses (`omnesis.local`), not the machine's own `.local` name. A gateway given a Tailscale certificate by `omnesis tls provision` treats its Tailscale name as trusted, so phones pair there with system trust that survives renewals. `omnesis tls provision` names the phones that must pair again when the certificate changes.
- 91a0e60: A source install follows a repository whose history was replaced by a new root. `omnesis update` and a re-run of the installer fetch only the release tag they chose, so a checkout cloned from an older tag no longer fails its fetch once that tag is gone, and an edge install's `origin/main` follows `main` to the new root. A newer version that shares no history with the installed build is a forward update that says the history was replaced. Re-running the installer now also treats a newer release that does not contain the installed build as forward, as `omnesis update` already did.
  - @omnesis/agent-integration@0.5.11
  - @omnesis/cli-shared@0.5.11
  - @omnesis/collector@0.5.11
  - @omnesis/config@0.5.11
  - @omnesis/core@0.5.11
  - @omnesis/eval@0.5.11
  - @omnesis/gateway@0.5.11
  - @omnesis/gateway-client@0.5.11
  - @omnesis/source-sdk@0.5.11
  - @omnesis/types@0.5.11

## 0.5.10

### Patch Changes

- b0d7997: The Hermes integration accepts the operator's rewind permission on a fleet update command and passes it on as `--allow-rewind`, instead of rejecting the command.
  - @omnesis/agent-integration@0.5.10
  - @omnesis/cli-shared@0.5.10
  - @omnesis/collector@0.5.10
  - @omnesis/config@0.5.10
  - @omnesis/core@0.5.10
  - @omnesis/eval@0.5.10
  - @omnesis/gateway@0.5.10
  - @omnesis/gateway-client@0.5.10
  - @omnesis/source-sdk@0.5.10
  - @omnesis/types@0.5.10

## 0.5.9

### Patch Changes

- d118d2b: `omnesis update --fleet` gives a machine that reports a restart pending five minutes to come back on the new release before reporting the restart as owed, so an agent harness that restarts after draining its work is reported as updated.
  - @omnesis/agent-integration@0.5.9
  - @omnesis/cli-shared@0.5.9
  - @omnesis/collector@0.5.9
  - @omnesis/config@0.5.9
  - @omnesis/core@0.5.9
  - @omnesis/eval@0.5.9
  - @omnesis/gateway@0.5.9
  - @omnesis/gateway-client@0.5.9
  - @omnesis/source-sdk@0.5.9
  - @omnesis/types@0.5.9

## 0.5.8

### Patch Changes

- fe02e67: `omnesis update --fleet --commit` reads which machines were connected from the release plan before the host update, so it waits for them to reconnect instead of finding them offline and parking their updates.
  - @omnesis/agent-integration@0.5.8
  - @omnesis/cli-shared@0.5.8
  - @omnesis/collector@0.5.8
  - @omnesis/config@0.5.8
  - @omnesis/core@0.5.8
  - @omnesis/eval@0.5.8
  - @omnesis/gateway@0.5.8
  - @omnesis/gateway-client@0.5.8
  - @omnesis/source-sdk@0.5.8
  - @omnesis/types@0.5.8

## 0.5.7

### Patch Changes

- 3de1482: `omnesis update --fleet --commit` waits for the machines to reconnect after the gateway restarts, instead of finding them offline and leaving their updates parked until they next connect.
  - @omnesis/agent-integration@0.5.7
  - @omnesis/cli-shared@0.5.7
  - @omnesis/collector@0.5.7
  - @omnesis/config@0.5.7
  - @omnesis/core@0.5.7
  - @omnesis/eval@0.5.7
  - @omnesis/gateway@0.5.7
  - @omnesis/gateway-client@0.5.7
  - @omnesis/source-sdk@0.5.7
  - @omnesis/types@0.5.7

## 0.5.6

### Patch Changes

- f614dcf: `omnesis update` treats a newer release as a forward update even when the source install was moved to an exact commit that release does not contain, and lists the commits it leaves behind. A same-or-older target that does not contain the installed build needs the new `--allow-rewind` flag (implied by `--force`), which `--fleet` passes to each machine it commands. `omnesis update --fleet` now waits for every commanded machine to report, prints each result, and exits with an error when any machine failed or never answered.
  - @omnesis/agent-integration@0.5.6
  - @omnesis/cli-shared@0.5.6
  - @omnesis/collector@0.5.6
  - @omnesis/config@0.5.6
  - @omnesis/core@0.5.6
  - @omnesis/eval@0.5.6
  - @omnesis/gateway@0.5.6
  - @omnesis/gateway-client@0.5.6
  - @omnesis/source-sdk@0.5.6
  - @omnesis/types@0.5.6

## 0.5.5

### Patch Changes

- 989f81f: Treat the OpenClaw and Hermes integrations as generally available: their transcript sources are no longer marked experimental, and the iOS and Android pair forms offer the agent-integration kind without experimental mode.
- e613750: Open in source lands on the item more often. Apple Reminders links open the reminder itself, and iMessage links open the existing conversation (including groups and business senders) instead of starting a new message; run `omnesis sources resync` on those sources to refresh links on documents already indexed. Search results, references, graph views, near-duplicates, attachments and exports now carry each document's published link rather than the gateway's internal matching form. On Android, a link no installed app opens falls back to the web link, and the action is hidden when nothing on the phone can open the document; on iOS, an app link for an app the phone lacks falls back to the web link. The Android and iOS apps no longer show the gateway push-setup warning in the app-wide banner, where it covered other controls; it appears in Settings → Notifications only.
  - @omnesis/agent-integration@0.5.5
  - @omnesis/cli-shared@0.5.5
  - @omnesis/collector@0.5.5
  - @omnesis/config@0.5.5
  - @omnesis/core@0.5.5
  - @omnesis/eval@0.5.5
  - @omnesis/gateway@0.5.5
  - @omnesis/gateway-client@0.5.5
  - @omnesis/source-sdk@0.5.5
  - @omnesis/types@0.5.5

## 0.5.4

### Patch Changes

- Add the integration device kind for third-party code that asks Omnesis questions on your behalf, such as a voice-assistant handler. An integration's tokens carry only the answer scope, and the access level chosen for it on the portal's Devices page decides which sources its answers may use and whether a privacy policy reviews them; until one is chosen its questions are refused. Pair one from the portal's Devices page or with `omnesis devices pair --kind integration --name <name>`; `omnesis access levels` lists which integration uses which level.
  - @omnesis/agent-integration@0.5.4
  - @omnesis/cli-shared@0.5.4
  - @omnesis/collector@0.5.4
  - @omnesis/config@0.5.4
  - @omnesis/core@0.5.4
  - @omnesis/eval@0.5.4
  - @omnesis/gateway@0.5.4
  - @omnesis/gateway-client@0.5.4
  - @omnesis/source-sdk@0.5.4
  - @omnesis/types@0.5.4

## 0.5.3

### Patch Changes

- 49df595: Keep fleet-update notices compact, move the full report into a modal, and dismiss successful updates automatically.
- 86eb268: Hide the portal fleet-update action when a passphrase-backed keyring has no non-secret credential locator that the detached updater can inherit.
  - @omnesis/agent-integration@0.5.3
  - @omnesis/cli-shared@0.5.3
  - @omnesis/collector@0.5.3
  - @omnesis/config@0.5.3
  - @omnesis/core@0.5.3
  - @omnesis/eval@0.5.3
  - @omnesis/gateway@0.5.3
  - @omnesis/gateway-client@0.5.3
  - @omnesis/source-sdk@0.5.3
  - @omnesis/types@0.5.3

## 0.5.2

### Patch Changes

- bf9e2a4: Let the portal-owned updater inherit non-secret keyring locators so it can decrypt the local admin token and take its mandatory pre-update backup.
  - @omnesis/agent-integration@0.5.2
  - @omnesis/cli-shared@0.5.2
  - @omnesis/collector@0.5.2
  - @omnesis/config@0.5.2
  - @omnesis/core@0.5.2
  - @omnesis/eval@0.5.2
  - @omnesis/gateway@0.5.2
  - @omnesis/gateway-client@0.5.2
  - @omnesis/source-sdk@0.5.2
  - @omnesis/types@0.5.2

## 0.5.1

### Patch Changes

- cfd2d2f: Plaid: a stored sync cursor is checked against one definition of its shape, so a corrupt field is recovered from the same way wherever it is noticed.
  - @omnesis/agent-integration@0.5.1
  - @omnesis/cli-shared@0.5.1
  - @omnesis/collector@0.5.1
  - @omnesis/config@0.5.1
  - @omnesis/core@0.5.1
  - @omnesis/eval@0.5.1
  - @omnesis/gateway@0.5.1
  - @omnesis/gateway-client@0.5.1
  - @omnesis/source-sdk@0.5.1
  - @omnesis/types@0.5.1

## 0.5.0

### Minor Changes

- 5407bc7: During ordinary interactive native gateway installs that register services, offer isolated ChatGPT Codex login and exact `gpt-5.6-luna` Agent assignment when a Codex command is present, the live account catalog exposes that model, and Agent is unassigned. Acceptance explicitly enables remote inference.

### Patch Changes

- Complete portal-driven fleet updates with durable operation tracking, bounded diagnostics, safe host restarts, and post-update device verification.
  - @omnesis/agent-integration@0.5.0
  - @omnesis/cli-shared@0.5.0
  - @omnesis/collector@0.5.0
  - @omnesis/config@0.5.0
  - @omnesis/core@0.5.0
  - @omnesis/eval@0.5.0
  - @omnesis/gateway@0.5.0
  - @omnesis/gateway-client@0.5.0
  - @omnesis/source-sdk@0.5.0
  - @omnesis/types@0.5.0

## 0.4.23

### Patch Changes

- d20fec3: Add an Update fleet action to the portal that durably updates a supported gateway host to the reviewed release, waits for the exact version to become healthy, and then updates collectors and managed agent integrations.
  - @omnesis/agent-integration@0.4.23
  - @omnesis/cli-shared@0.4.23
  - @omnesis/collector@0.4.23
  - @omnesis/config@0.4.23
  - @omnesis/core@0.4.23
  - @omnesis/eval@0.4.23
  - @omnesis/gateway@0.4.23
  - @omnesis/gateway-client@0.4.23
  - @omnesis/source-sdk@0.4.23
  - @omnesis/types@0.4.23

## 0.4.22

### Patch Changes

- Add model-specific reasoning controls backed by the Models.dev catalog across the portal, iOS, and Android. Omnesis now exposes only the controls declared for the selected provider and model, autosaves behavior changes, preserves model defaults for older clients, and sends each provider the reasoning request shape it expects. The mobile model pickers also show the assigned model consistently and keep recently used models available.
  - @omnesis/agent-integration@0.4.22
  - @omnesis/cli-shared@0.4.22
  - @omnesis/collector@0.4.22
  - @omnesis/config@0.4.22
  - @omnesis/core@0.4.22
  - @omnesis/eval@0.4.22
  - @omnesis/gateway@0.4.22
  - @omnesis/gateway-client@0.4.22
  - @omnesis/source-sdk@0.4.22
  - @omnesis/types@0.4.22

## 0.4.21

### Patch Changes

- b9b6b00: Write the service units, `.env` and the keyring passphrase durably, so a power cut right after an install cannot leave them empty. The unit and plist writers used a plain `writeFileSync`, and the installer wrote `.env` and `keyring.pass` without syncing: a crash seconds later left all three zero-length on ext4, systemd reported the units masked, nothing started at boot, and an empty passphrase file leaves the encrypted index openable only with the recovery code. The units and plists now go through the same atomic, fsync-backed write the rest of the CLI already uses, and the installer syncs each file it writes and its directory.
- 69ba074: Stop failing an install over a gateway that is merely slow to start. The installer waited a fixed 60 seconds for the gateway's first `/health`, then reported it as not running and exited — but a first boot applies every database migration, which on a small or busy machine takes longer than that. When the wait passes and the supervisor reports the gateway running, the installer now says it is still starting and keeps waiting (up to `OMNESIS_GATEWAY_STARTUP_MAX_SECONDS`, 10 minutes by default; 0 turns the extra wait off), and the message it prints when it does give up names the whole time it waited. A gateway that is not running still fails the install immediately, with its last log lines, exactly as before.
- 5ab0194: Stop an update from carrying forward a collector's `https://localhost` gateway URL on a host whose certificate does not cover localhost. 0.4.18 wrote that URL into every collector unit regardless of the certificate served, so a host with an operator or tailnet certificate has a collector that can never complete a handshake — and updating it kept the URL as "the operator's", leaving the host broken for good. An inherited loopback URL the served certificate cannot satisfy is now dropped when the unit is regenerated, so the address recorded in the config `.env` applies again. An address that is not loopback is still the operator's and is left exactly as it is.
  - @omnesis/agent-integration@0.4.21
  - @omnesis/cli-shared@0.4.21
  - @omnesis/collector@0.4.21
  - @omnesis/config@0.4.21
  - @omnesis/core@0.4.21
  - @omnesis/eval@0.4.21
  - @omnesis/gateway@0.4.21
  - @omnesis/gateway-client@0.4.21
  - @omnesis/source-sdk@0.4.21
  - @omnesis/types@0.4.21

## 0.4.20

### Patch Changes

- 7ac4c3c: Keep source updates from running out of memory on small machines. On a machine with less than about 5 GB, `omnesis update` now stops this account's collector while the build runs and starts it again afterwards, and stops the collector and gateway before a rollback rebuilds after a killed build. A build or dependency install killed by the system is now reported as most likely out of memory, with what to do: stop the collector and gateway, add swap or free memory, then run `omnesis update`. The installer and the unfinished-update notice say the same.
  - @omnesis/agent-integration@0.4.20
  - @omnesis/cli-shared@0.4.20
  - @omnesis/collector@0.4.20
  - @omnesis/config@0.4.20
  - @omnesis/core@0.4.20
  - @omnesis/eval@0.4.20
  - @omnesis/gateway@0.4.20
  - @omnesis/gateway-client@0.4.20
  - @omnesis/source-sdk@0.4.20
  - @omnesis/types@0.4.20

## 0.4.19

### Patch Changes

- 1e0a5ed: Reconnect a collector to the gateway on its own machine after an update and a restart. A collector whose service was installed before the loopback address was recorded for it still dialed `https://omnesis.local:7600`; on macOS Homebrew's `node` cannot resolve `.local` names, so after `omnesis update` and a reboot it waited for the gateway forever. The collector now reaches a gateway that holds its config directory on this machine over `https://localhost:<port>`, checking again on every attempt so a gateway that starts after the collector is still found, and reports the address it switched to.
- c0a2d14: Let another machine join a Docker gateway by the line its install prints. The gateway container's self-signed certificate covered only names inside the container, yet the banner told a collector elsewhere to dial the host's own hostname, so pairing failed the certificate's name check. The installer now hands the gateway the host's names (its hostname, `<hostname>.local` and its LAN addresses) for the certificate it mints, and the banner joins by one of them with `--trust-fingerprint`. A certificate minted earlier is kept, since paired phones and collectors pin it; the banner says when it does not cover the printed name and that `omnesis tls renew --force` mints one that does.
- 6b754ab: Restart the gateway and collector when re-running the installer moves an existing source install to a new release. The installer checked out and built the new release, but on Linux registering the services left the running gateway and collector on the old build, and its health check accepted the old gateway because it only asked whether one answered. A re-run that moves the checkout now restarts both services onto the new build and waits for the gateway to report the new version.
- d70fdac: Keep `omnesis` commands and a collector on the gateway's own machine working when the gateway serves a certificate that does not name `localhost`. Requests from the gateway's machine went over `https://localhost:<port>` whenever a gateway there held the config directory, and a collector installed alongside it was given that address, but a tailnet certificate from `omnesis tls provision`, or an operator's own certificate, names only its host, so every command failed its certificate check and the collector waited for the gateway forever. Loopback is now used only when the certificate the gateway serves names `localhost`, and only for an address with an explicit port and no path, so a URL that points at a reverse proxy in front of the gateway is also left as recorded.
- 70a0118: Say what is wrong when a machine pairs with a gateway by an address its certificate does not name. Pairing reported every certificate failure as "not trusted on this machine … pass --trust-fingerprint", including a certificate that is trusted but does not cover the address used (a LAN IP missing from it), where passing the fingerprint changes nothing. It now names the uncovered host and points at an address the certificate covers, which `omnesis tls status` lists on the gateway's machine. The installer's address menu also stops suggesting direct IPs when the gateway's certificate covers none.
- db3fc59: Apply each release's service definitions when `omnesis update` restarts the gateway and collector. The update restarted them under the launchd plist or systemd unit written when they were installed, so a change a release made to those definitions never reached an existing machine: a Linux gateway kept a unit that stopped it listing network interfaces, which turned LAN discovery off and made `omnesis doctor` warn about service hardening, and a collector installed beside its gateway kept the address other machines use instead of the loopback address a fresh install gives it. The update now rewrites a daemon's definition before restarting it, keeping its executable, configuration directory, keyring wiring and environment, and a rollback puts the previous one back. With `--no-restart`, systemd reads the new unit for the daemon's next restart and launchd loads the new plist at the next login. A definition the update cannot rewrite without losing something, such as a unit with a systemd drop-in, is left as it is, and the update names `omnesis service install` instead.
  - @omnesis/agent-integration@0.4.19
  - @omnesis/cli-shared@0.4.19
  - @omnesis/collector@0.4.19
  - @omnesis/config@0.4.19
  - @omnesis/core@0.4.19
  - @omnesis/eval@0.4.19
  - @omnesis/gateway@0.4.19
  - @omnesis/gateway-client@0.4.19
  - @omnesis/source-sdk@0.4.19
  - @omnesis/types@0.4.19

## 0.4.18

### Patch Changes

- f55427d: Let a Linux gateway answer mDNS queries. Its responder bound its socket to the LAN address, and a Linux socket bound that way never receives queries sent to the mDNS group, so the gateway announced itself once at start and then answered nobody: a collector or browser looking for `_omnesis._tcp` later, or for `omnesis.local`, found nothing. The responder now listens on every address while still sending on the LAN interface.
- d7cff59: Keep `omnesis` commands working on a Linux gateway host that cannot resolve `.local` names. The address the installer records for other machines is also the one the CLI on the gateway's own machine uses, and it defaulted to `https://omnesis.local:7600` even where that name does not resolve — a stock Ubuntu server — so every command there failed with "Cannot reach gateway". The default is now an address the machine resolves (a direct IP when `.local` names do not), and choosing a name it cannot resolve prints a warning.
- 879dc83: Retry a source install's dependency step once when it fails on its own, and say what to do when it fails again. npm's downloads and install scripts occasionally fail for reasons unrelated to Omnesis — a dropped connection, or an install-script binary still open for writing (`ETXTBSY`) — and the installer used to stop right there with npm's raw output and no explanation. It now tries `npm ci` a second time; if that fails too, it says the dependency install failed twice, names the usual causes, and that re-running the installer continues from the checkout it already made. A failed build gets its own message as well.
- 6d09036: Keep the collector and `omnesis` commands on the gateway's own machine connected after a restart. The address an install records for other machines (`OMNESIS_GATEWAY_URL`, by default `https://omnesis.local:7600`) was also where the collector and the CLI on the gateway host sent their requests, and that name may not resolve there: a Linux server has no `.local` resolution, and on macOS the system denies Homebrew's `node` local network access. After a reboot the collector waited for the gateway forever and `omnesis doctor` reported it unreachable. A collector installed alongside its gateway now dials `https://localhost:<port>`, and CLI requests go over loopback whenever a gateway on this machine holds the config directory; printed join commands still carry the recorded address. Existing installs pick up the collector change when `omnesis service install` (or the installer) runs again.
- 0418c69: Let the gateway advertise itself on the local network when it runs as a systemd service on Linux. The service units restricted network access so tightly that the gateway could not list its own network interfaces, so it quietly turned LAN discovery off on every systemd install. `omnesis doctor` flags units written before this fix; reinstall them with `omnesis service install`.
  - @omnesis/agent-integration@0.4.18
  - @omnesis/cli-shared@0.4.18
  - @omnesis/collector@0.4.18
  - @omnesis/config@0.4.18
  - @omnesis/core@0.4.18
  - @omnesis/eval@0.4.18
  - @omnesis/gateway@0.4.18
  - @omnesis/gateway-client@0.4.18
  - @omnesis/source-sdk@0.4.18
  - @omnesis/types@0.4.18

## 0.4.17

### Patch Changes

- No functional changes since 0.4.16. This release exercises the fleet update path end to end on machines that all run 0.4.16, including the Hermes plugin restarting through its planned SIGUSR1 restart after an update.
  - @omnesis/agent-integration@0.4.17
  - @omnesis/cli-shared@0.4.17
  - @omnesis/collector@0.4.17
  - @omnesis/config@0.4.17
  - @omnesis/core@0.4.17
  - @omnesis/eval@0.4.17
  - @omnesis/gateway@0.4.17
  - @omnesis/gateway-client@0.4.17
  - @omnesis/source-sdk@0.4.17
  - @omnesis/types@0.4.17

## 0.4.16

### Patch Changes

- 1a603ac: Restart Hermes after a fleet update installs a new Omnesis plugin through Hermes's own planned restart. Hermes refuses `hermes gateway restart` from inside its gateway, where the plugin runs, so the plugin now sends its gateway process SIGUSR1: Hermes lets agent runs in progress finish, exits, and its service manager starts it again. When the signal cannot be sent, the process has no restart handler, or Hermes is still running four minutes later, the device row records the restart still owed with the command to run. The plugin no longer writes `logs/omnesis-restart.log` under the Hermes home.
  - @omnesis/agent-integration@0.4.16
  - @omnesis/cli-shared@0.4.16
  - @omnesis/collector@0.4.16
  - @omnesis/config@0.4.16
  - @omnesis/core@0.4.16
  - @omnesis/eval@0.4.16
  - @omnesis/gateway@0.4.16
  - @omnesis/gateway-client@0.4.16
  - @omnesis/source-sdk@0.4.16
  - @omnesis/types@0.4.16

## 0.4.15

### Patch Changes

- No functional changes since 0.4.14. This release exercises the fleet update path end to end on machines that all run 0.4.14, including the Hermes plugin restarting itself from outside the gateway it restarts and a host update no longer leaving a stale "restart owed" on a plugin that already restarted.
  - @omnesis/agent-integration@0.4.15
  - @omnesis/cli-shared@0.4.15
  - @omnesis/collector@0.4.15
  - @omnesis/config@0.4.15
  - @omnesis/core@0.4.15
  - @omnesis/eval@0.4.15
  - @omnesis/gateway@0.4.15
  - @omnesis/gateway-client@0.4.15
  - @omnesis/source-sdk@0.4.15
  - @omnesis/types@0.4.15

## 0.4.14

### Patch Changes

- 4f0c0f4: Restart Hermes reliably after a fleet update installs a new Omnesis plugin: the restart now runs outside the Hermes gateway's process tree, so Hermes restarts through its service manager the same way it does from a shell. The restart's output and exit code are appended to `logs/omnesis-restart.log` under the Hermes home, and a restart that exits with an error is reported as still owed, with its output and the command to run.
- 05a6b97: A harness plugin that already runs the version an `omnesis update` on its host just refreshed no longer gets a stale "restart owed" on its device row. On a host where several updates run one after another, a later run no longer marks a plugin that has already restarted onto the new version as owing a restart.
- ac3da58: `omnesis model install` now names the real `omnesis model assign` command with the model's role and assignment value, and says when the installed model is already assigned instead of asking you to activate it.
- b99da6e: Keep the gateway and collector services, and the `omnesis` command, working when Homebrew's Node is upgraded or is not on PATH: service units now point at Homebrew's version-independent Node link, and the source launcher finds the keg-only `node@24` on its own, so the installer no longer asks you to add Node to your PATH.
  - @omnesis/agent-integration@0.4.14
  - @omnesis/cli-shared@0.4.14
  - @omnesis/collector@0.4.14
  - @omnesis/config@0.4.14
  - @omnesis/core@0.4.14
  - @omnesis/eval@0.4.14
  - @omnesis/gateway@0.4.14
  - @omnesis/gateway-client@0.4.14
  - @omnesis/source-sdk@0.4.14
  - @omnesis/types@0.4.14

## 0.4.13

### Patch Changes

- No functional changes since 0.4.12. This release exercises the fleet update path end to end on machines that already run 0.4.12: the target build's updater finishing the update, collectors restarting through their own service unit, and OpenClaw and Hermes restarting right after their plugin is installed.
  - @omnesis/agent-integration@0.4.13
  - @omnesis/cli-shared@0.4.13
  - @omnesis/collector@0.4.13
  - @omnesis/config@0.4.13
  - @omnesis/core@0.4.13
  - @omnesis/eval@0.4.13
  - @omnesis/gateway@0.4.13
  - @omnesis/gateway-client@0.4.13
  - @omnesis/source-sdk@0.4.13
  - @omnesis/types@0.4.13

## 0.4.12

### Patch Changes

- d9772c2: A collector that installs a fleet update now asks its service manager to restart it on the new build — `launchctl kickstart -k` for its LaunchAgent, a queued `systemctl --user restart` for its systemd unit — instead of exiting and relying on a respawn launchd did not always perform. A collector not running as its own Omnesis service unit still exits for its supervisor to bring it back.
- bfdc44f: A fleet update now restarts OpenClaw or Hermes as soon as the Omnesis plugin is installed, so the new plugin loads without a manual step. The restart interrupts any agent run in progress. When the harness cannot be restarted from the plugin, the device row still reports the restart as owed and names the command.
- 07dc1fc: The WhatsApp source no longer writes Signal-protocol session state to the collector's service log. The bundled `libsignal` printed whole session records, including private and root keys, whenever a session was opened, closed or pruned; those console diagnostics are now removed.
  - @omnesis/agent-integration@0.4.12
  - @omnesis/cli-shared@0.4.12
  - @omnesis/collector@0.4.12
  - @omnesis/config@0.4.12
  - @omnesis/core@0.4.12
  - @omnesis/eval@0.4.12
  - @omnesis/gateway@0.4.12
  - @omnesis/gateway-client@0.4.12
  - @omnesis/source-sdk@0.4.12
  - @omnesis/types@0.4.12

## 0.4.11

### Patch Changes

- `omnesis update --fleet` waits up to 90 seconds for the collectors and agent plugins that were connected before the gateway restarted to reconnect before it plans the fan-out, so a fleet that is online is no longer reported offline, and it names any device that did not come back.
- b8e6ed0: `omnesis update` hands everything after the apply — a backup that can wait for it, the restarts, the health wait, the harness refresh, the completion record and any rollback — to the build it just installed, passing the host update lock directly, so a fix to those steps applies to the update that delivers it.
  - @omnesis/agent-integration@0.4.11
  - @omnesis/cli-shared@0.4.11
  - @omnesis/collector@0.4.11
  - @omnesis/config@0.4.11
  - @omnesis/core@0.4.11
  - @omnesis/eval@0.4.11
  - @omnesis/gateway@0.4.11
  - @omnesis/gateway-client@0.4.11
  - @omnesis/source-sdk@0.4.11
  - @omnesis/types@0.4.11

## 0.4.10

### Patch Changes

- Fleet updates finish on every machine without manual steps:
  - **Stopped gateway:** an update on a host whose gateway is not running copies its closed stores as the pre-update backup instead of failing, no longer prints a restart hint for a gateway that does not run, and restarts the collector normally.
  - **Busy host:** `omnesis update --wait-for-lock=<minutes>` waits for another update on the same host to finish. Collector, OpenClaw and Hermes self-updates use it, so a collector and a harness plugin on one machine no longer fail each other.
  - **Hermes:** the Hermes plugin accepts update commands, so `omnesis update --fleet` updates it like OpenClaw.
  - **Builds that cannot take the command:** a device whose build does not accept update commands is recorded as unsupported rather than failed, is not offered again until it reports another version, and `omnesis devices list`, the portal and `omnesis doctor` name the commands to run on that machine.
  - **Failure details:** a failed self-update reports the lines that name the cause, capped so the gateway always records the result.
  - **Restart hints:** an update that installs nothing only says a daemon still runs the previous build when it started before the installation changed.
  - **Backup progress:** `omnesis backup` and the pre-update backup show the bytes written for the file in progress, and label the size figure as an upper bound.
  - @omnesis/agent-integration@0.4.10
  - @omnesis/cli-shared@0.4.10
  - @omnesis/collector@0.4.10
  - @omnesis/config@0.4.10
  - @omnesis/core@0.4.10
  - @omnesis/eval@0.4.10
  - @omnesis/gateway@0.4.10
  - @omnesis/gateway-client@0.4.10
  - @omnesis/source-sdk@0.4.10
  - @omnesis/types@0.4.10

## 0.4.9

### Patch Changes

- The dedicated-account gateway runs from a release that root fetches, builds and owns, not from files a login account can change. `omnesis service install gateway --hardened` and the installer print one root command. `omnesis-gateway-admin` installs, updates with a backup and an automatic switch back, rolls back, uninstalls and administers the gateway. The dedicated account is offered on hosts whose home directories are closed to other accounts. The gateway's passphrase lives in `/etc/omnesis-gateway`, readable by root alone, and a dedicated gateway no longer exits on first start because it had no home directory for DuckDB's encryption extension.
- Deployment and security improvements across install, update, TLS and devices:
  - **Publishing:** a multi-package publish that stops partway resumes safely. Versions already published byte for byte count as done.
  - **Collector storage keys:** a collector creates its own storage keys at install and at every start, and refuses to start when encryption is armed without its key.
  - **Security checks from the terminal:**
    - security verification covers collectors, and each remedy names the host to run it on
    - `omnesis doctor --device` and `--fleet` work from the terminal
    - the doctor lists revoked devices that still host sources
  - **Certificate lifecycle:** expiry diagnostics, in-process renewal and activation, and `omnesis tls status`, `renew`, `reload` and `trust`.
  - **Docker certificates:** Docker installs serve a certificate issued on the host (`--tls-cert`, `--tls-key` and `--tls-ca`). The collector container verifies the name it dials.
  - **Container updates:** a container update records completion, and an interrupted update rolls back.
  - **Source update build:** the managed source update sizes its build heap from the memory the machine can use.
  - **Reverse proxy:** behind a trusted proxy (`OMNESIS_TRUST_PROXY`), rate limits read the proxy's last forwarded address. Remote clients no longer share the loopback exemption.
  - **Harness plugin updates:** an OpenClaw or Hermes plugin's update outcome stays on its device row, shown by `omnesis devices list` and three doctor checks.
  - **Phone notifications:** `omnesis push status` and the doctor separate the four reasons a phone gets no notifications.
  - **Chrome extension:** gateway installs offer it from the Chrome Web Store, with wording that matches the certificate served.
  - **Cross-checks:** the entry package name is checked against the installer, updater and manifest. Device revocation is enforced through one shared check.
  - @omnesis/agent-integration@0.4.9
  - @omnesis/cli-shared@0.4.9
  - @omnesis/collector@0.4.9
  - @omnesis/config@0.4.9
  - @omnesis/core@0.4.9
  - @omnesis/eval@0.4.9
  - @omnesis/gateway@0.4.9
  - @omnesis/gateway-client@0.4.9
  - @omnesis/source-sdk@0.4.9
  - @omnesis/types@0.4.9

## 0.4.8

### Patch Changes

- Portal Settings > Config: a keystroke typed right after a field reappears under a filter change is kept instead of being overwritten, and Discard clears a rejected save's error banner.
- `omnesis update adopt-source` and `omnesis update migrate-to-package` no longer also start the host update once the subcommand finishes.
  - @omnesis/agent-integration@0.4.8
  - @omnesis/cli-shared@0.4.8
  - @omnesis/collector@0.4.8
  - @omnesis/config@0.4.8
  - @omnesis/core@0.4.8
  - @omnesis/eval@0.4.8
  - @omnesis/gateway@0.4.8
  - @omnesis/gateway-client@0.4.8
  - @omnesis/source-sdk@0.4.8
  - @omnesis/types@0.4.8

## 0.4.7

### Patch Changes

- 4ac2b7b: Add an OpenRouter backend preset: one API key routes agent roles to any OpenRouter model, with the OpenRouter mark in the portal, iOS, and CLI pickers.
  - @omnesis/agent-integration@0.4.7
  - @omnesis/cli-shared@0.4.7
  - @omnesis/collector@0.4.7
  - @omnesis/config@0.4.7
  - @omnesis/core@0.4.7
  - @omnesis/eval@0.4.7
  - @omnesis/gateway@0.4.7
  - @omnesis/gateway-client@0.4.7
  - @omnesis/source-sdk@0.4.7
  - @omnesis/types@0.4.7

## 0.4.6

### Patch Changes

- Check local source read access freshly inside the collector during fleet health checks, separately from cached sync status; report missing inputs, incomplete scans, and timeouts as unverified.
- Allow OpenClaw connection setup to finish when Node prints its color-environment warning alongside the exact missing legacy-plugin diagnostic; genuine retirement errors still stop setup.
- Strengthen source-restricted access, pending-approval review, and principal attribution across the portal and mobile clients.
- Show fleet health-check progress above collapsed device cards, and clear failed-update notices after a reconnect confirms recovery without retrying the failed command.
- Support standing operator instructions in OMNESIS.md.
- Plaid: sign in through a Plaid-hosted page, so banks that authenticate on their own website connect; choose which countries' banks are offered; keep fetching a new bank's history until Plaid finishes assembling it; and refuse a bank that is already connected.
- e88fc54: Add a verified adoption path for hand-made source installations and keep ownership markers repository-local.
- 4088a69: Resolve unpinned Docker installs from stable tags in the configured container registry.
- 85d0942: Report newer releases passively from one gateway-owned, install-aware check without downloading or installing them.
- 9cf4e0b: Plaid: revoke the item at Plaid when its source is removed, request 730 days of history, keep deposit-only institutions in the picker, and complete the add as soon as one bank is linked.
- d8b5440: Describe every corpus credential revoked with an agent device while keeping live-access warnings precise.
- e416084: Explain how to authenticate Docker installs when their container registry denies access.
- 6b404b2: Ask for content-blind relay notification consent on each phone and let operators review or withdraw it from the portal.
- 89b10d1: Refuse Docker edge installs because published installer images correspond to releases.
- 95fc4dd: Retain a bounded number of automatic pre-update backups while preserving operator-created backups.
- c6f2217: Refuse concurrent updates on one host and recover locks left by interrupted processes.
- 104c350: Verify managed OpenClaw and Hermes plugins nightly against deliberately pinned real harness loaders.
- 30feaa9: Recover interrupted source updates from the last build known to have completed.
- 2207a03: Add a verified migration from an installer-managed source checkout to the package delivery method.
  - @omnesis/agent-integration@0.4.6
  - @omnesis/cli-shared@0.4.6
  - @omnesis/collector@0.4.6
  - @omnesis/config@0.4.6
  - @omnesis/core@0.4.6
  - @omnesis/eval@0.4.6
  - @omnesis/gateway@0.4.6
  - @omnesis/gateway-client@0.4.6
  - @omnesis/source-sdk@0.4.6
  - @omnesis/types@0.4.6

## 0.4.5

### Patch Changes

- 3bb4747: Let release operators select a package registry independently from publication arming, support staging Changesets prereleases for beta rehearsals, and document the existing per-command registry routing for package installation and updates.
  - @omnesis/agent-integration@0.4.5
  - @omnesis/cli-shared@0.4.5
  - @omnesis/collector@0.4.5
  - @omnesis/config@0.4.5
  - @omnesis/core@0.4.5
  - @omnesis/eval@0.4.5
  - @omnesis/gateway@0.4.5
  - @omnesis/gateway-client@0.4.5
  - @omnesis/source-sdk@0.4.5
  - @omnesis/types@0.4.5

## 0.4.4

### Patch Changes

- afc8d53: Publish the product entry point as `omnesis` and keep synthetic providers out of the release graph.
  - @omnesis/agent-integration@0.4.4
  - @omnesis/cli-shared@0.4.4
  - @omnesis/collector@0.4.4
  - @omnesis/config@0.4.4
  - @omnesis/core@0.4.4
  - @omnesis/eval@0.4.4
  - @omnesis/gateway@0.4.4
  - @omnesis/gateway-client@0.4.4
  - @omnesis/source-sdk@0.4.4
  - @omnesis/types@0.4.4

## 0.4.3

### Patch Changes

- Harden MCP OAuth discovery, redirect validation, refresh rotation, audience aliases, and Answer ownership; preserve managed agent integrations while moving corpus access to OAuth grants; and improve authorization review and recovery across the portal and mobile apps.
- Updated dependencies
- Updated dependencies
  - @omnesis/collector@0.4.3
  - @omnesis/agent-integration@0.4.3
  - @omnesis/gateway@0.4.3
  - @omnesis/cli-shared@0.4.3
  - @omnesis/config@0.4.3
  - @omnesis/core@0.4.3
  - @omnesis/eval@0.4.3
  - @omnesis/gateway-client@0.4.3
  - @omnesis/source-sdk@0.4.3
  - @omnesis/types@0.4.3

## 0.4.2

### Patch Changes

- Make external-agent connections generally available while keeping Watch management capability-gated, renew expiring integration credentials automatically, expose reauthorization status and recovery instructions, refresh TLS trust during reconnects, and consolidate the Hermes adapter into the shared integration package.
  - @omnesis/agent-integration@0.4.2
  - @omnesis/cli-shared@0.4.2
  - @omnesis/collector@0.4.2
  - @omnesis/config@0.4.2
  - @omnesis/core@0.4.2
  - @omnesis/eval@0.4.2
  - @omnesis/gateway@0.4.2
  - @omnesis/gateway-client@0.4.2
  - @omnesis/source-sdk@0.4.2
  - @omnesis/types@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies
  - @omnesis/core@0.4.1
  - @omnesis/agent-integration@0.4.1
  - @omnesis/cli-shared@0.4.1
  - @omnesis/collector@0.4.1
  - @omnesis/config@0.4.1
  - @omnesis/eval@0.4.1
  - @omnesis/gateway@0.4.1
  - @omnesis/gateway-client@0.4.1
  - @omnesis/source-sdk@0.4.1
  - @omnesis/types@0.4.1

## 0.4.0

### Minor Changes

- 56a13a5: Replace legacy external-agent MCP access with one OAuth-protected HTTP resource backed by principals, revisioned grants, independently revocable credentials, Portal approval, and managed OpenClaw and Hermes enrollment. Grants can independently authorize Direct and Answer over all sources, an explicit source-instance allowlist, or a denylist whose future-source behavior is shown before approval. Answer grants select a reusable named privacy-policy family with immutable edit, fork, template, and restore history, or explicitly opt into unreviewed release. Existing grants remain editable without reauthorizing the client, and code-gated authorization requests can be reviewed from a paired iPhone after a private notification.

### Patch Changes

- Updated dependencies [56a13a5]
  - @omnesis/gateway@0.4.0
  - @omnesis/collector@0.4.0
  - @omnesis/agent-integration@0.4.0
  - @omnesis/config@0.4.0
  - @omnesis/core@0.4.0
  - @omnesis/types@0.4.0
  - @omnesis/cli-shared@0.4.0
  - @omnesis/eval@0.4.0
  - @omnesis/gateway-client@0.4.0
  - @omnesis/source-sdk@0.4.0

## 0.3.0

### Minor Changes

- b7a34a6: Add generally available gateway-hosted MCP 2026-07-28 Streamable HTTP endpoints for the privacy-reviewed Answer boundary and optional direct read access, including read-only loop retrieval; make the Privacy control surface and privacy-reviewer model assignment available for interactive Answer approvals; make the 2025-11-25/2026-07-28 stdio command a compatibility bridge over those endpoints; layer ordinary OpenClaw and Hermes answers, trusted native approval routing, and task-scoped completion retrieval exclusively over the Answer MCP endpoint, with integration delivery protocol v3 enforcing the MCP-only contract; add a client-only installer mode, separate native Claude and OpenAI plugins for Answer and Direct profiles, and a canonical retrieval playbook shared by the built-in agent, Direct MCP runtime, and generated Direct skills.

### Patch Changes

- Updated dependencies [b7a34a6]
- Updated dependencies [0399f47]
  - @omnesis/gateway@0.3.0
  - @omnesis/gateway-client@0.3.0
  - @omnesis/collector@0.3.0
  - @omnesis/core@0.3.0
  - @omnesis/source-sdk@0.3.0
  - @omnesis/agent-integration@0.3.0
  - @omnesis/cli-shared@0.3.0
  - @omnesis/config@0.3.0
  - @omnesis/eval@0.3.0
  - @omnesis/types@0.3.0
