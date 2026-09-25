# External agent integrations

Omnesis integrates directly with OpenClaw and Hermes. There is no separate
Omnesis runner process: a managed plugin inside each agent handles both
directions of the connection.

Both plugins use the gateway's single OAuth-protected Streamable HTTP MCP
resource at `/mcp` for ordinary questions and for collecting an approved
result. Their native runtime remains responsible for trusted conversation
identity, transcript ingestion, durable completion wakes, subscriptions, and
posting a released answer back into the originating conversation. There is no
separate native Answer API, Answer-specific MCP URL, or fallback transport.

Transcript ingestion and MCP Answer work on any gateway. Watch management and
Watch-reaction delivery ride on the gateway's Watch runtime, which is still
experimental, so the gateway advertises whether they are available as
`capabilities.subscriptions` on `GET /health`. `omnesis connect` reads that to
decide whether to write the Watch tools into the installed skill, and the
plugin reads the recorded answer to decide whether to register them — so an
installation against a gateway without Watches has no tool that answers 404 and
no skill text promising one.

## Install and connect

Run this on the machine that hosts the external agent:

```text
omnesis connect openclaw
omnesis connect hermes
```

The command:

1. discovers the agent's managed installation and installs the matching plugin;
2. establishes verified TLS trust before sending credentials;
3. redeems one pairing ceremony into three operational device credentials:
   conversation ingestion, delivery receipt, and subscription management;
4. starts standard MCP OAuth with PKCE, then opens the Gateway consent page or
   prints its URL and short code for approval in an authenticated Portal;
5. creates a separately removable connection for corpus reads;
6. installs the Omnesis skill that teaches the agent to use the native Answer
   tool, and — where the gateway offers them — the subscription and
   firing-bound Answer tools;
7. writes the agent-specific configuration and verifies gateway health.

Create the pairing code on a trusted Omnesis surface. The connect command
prints the exact next step when interactive input is required.

To update an already paired installation, upgrade and restart the Omnesis
gateway, then immediately refresh the managed plugin and skill in place:

```text
omnesis connect openclaw --refresh
omnesis connect hermes --refresh
```

Refresh validates the saved credential file, refreshes or repairs OAuth when
needed, and preserves the paired device identity and Watches. It does not
consume a pairing code. The command refuses a gateway that does not advertise
the required Watch privacy protocol, so the plugin cannot be refreshed in an
unsafe rolling order. Restart the corresponding OpenClaw or Hermes gateway
afterward.

On the first access-grants upgrade, the same command migrates the existing
delivery and ingestion credentials in place and reuses the legacy management
credential from the harness state. It then asks for OAuth approval to create
the separate corpus-reading connection. The operational device is not paired
again and its Watches retain their owner.

## Data flow

```text
OpenClaw or Hermes transcript
        |
        | durable cursor + idempotent POST /agent-messages
        v
Omnesis conversation source

natural-language subscription
        |
        | background-agent compiler
        v
document-event plan OR closed catalog-watch plan
        |                         |
        | semantic prefilter      | deterministic read-only SQL
        | + LLM precision pass    | rising-edge evaluation
        +------------+------------+
                     v
durable subscription firing
        |
        | identifier-only WebSocket delivery
        v
plugin durable inbox
        |
        | persist before ACK
        v
dedicated native background workflow
```

An ordinary interactive Answer follows the same layered boundary:

```text
trusted native conversation route persisted by plugin
        |
        | ask_omnesis over OAuth-protected POST /mcp
        v
privacy-reviewed Answer task
        |
        | immediate release, or identifier-only completion wake after approval
        v
get_answer_status over OAuth-protected POST /mcp
        |
        v
plugin posts into the persisted native conversation
```

The native conversation handle is attached by trusted plugin code as MCP
request metadata, outside the model-visible tool arguments. The gateway binds
it to the authenticated integration device; neither the model nor the metadata
chooses a device. A held completion wake contains no answer or corpus content;
it carries only the delivery, task, and native-conversation identifiers. The
plugin then calls `get_answer_status` with its installation's OAuth sign-in, so
the connection's current access level remains the authority for the read.

Conversation ingestion reads the agent's durable transcript rather than
depending only on best-effort hooks. OpenClaw reads sessions through its
official transcript runtime API and persists the session generation, consumed
event count, event-prefix hash, and timestamp-boundary fingerprints. If
compaction or reset replaces events without changing the public session
identity, the prefix check detects the rewrite and safely replays records by
stable identity instead of skipping them. Hermes reads its SQLite transcript
and excludes Omnesis-owned background sessions so a delivered reaction cannot
be ingested and replayed as user conversation.

## Credential boundary

Pairing and OAuth create two different kinds of authority. The paired plugin is
an operational device. Its three credentials can receive delivery identifiers,
ingest transcripts, or manage that device's subscriptions; none can read the
corpus. The external agent is also an MCP connection. Its OAuth sign-in is
what permits Answer access through `/mcp`, under the access level the owner
approved. The plugin keeps both relationships because it performs both roles.

The model can invoke the plugin's subscription-management tool, but the native
runtime—not the model—uses the management credential. Creating or revising a
Watch asks the same privacy policy used by Answer to decide whether its
existence-level disclosure is allowed, requires operator approval, or is
denied. Any richer information requested after a firing passes through Answer
independently.

`omnesis connect` also writes `OMNESIS_AGENT_HARNESS` into the harness state
dotenv, naming the harness whose shells inherit it. It is not a credential and
grants nothing; `omnesis answer` reads it to recognise that a question is being
asked from inside an agent turn and refuses, naming the native `omnesis_answer`
tool instead — which waits for the answer properly and returns it into the run.
Reading an existing task back with `--task` is unaffected. A shell can of course
unset it; this corrects habit, not a determined caller.

The private runtime file contains the three operational credentials and the
OAuth client and token state. File mode `0600` protects it from other OS users,
but it does not protect it from an unsandboxed model shell running as the same
OS user. For a hard plugin-versus-shell boundary, run model shell commands in a
filesystem sandbox that excludes the harness state directory, or run them
under a different OS identity.

Each OpenClaw or Hermes installation is one paired device with its own
connection. Several installations can use one access level while each
connection stays separately removable. When a refresh needs a
new approval, the approval screen suggests replacing the connection already
bound to that device, so its name and access level carry over and the old
sign-in stops working. Every valid conversation and background session in one
installation shares that device's Watch-management authority. Ordinary
questions use the connection's Answer permission; a delivered Watch workflow uses
only its short-lived firing-bound Answer authority. Channel authentication
belongs to the harness, so pair only an installation whose conversations should
share that operational authority.

Updates use optimistic concurrency. The agent must list or get a subscription,
then pass that current `revision` as `expectedRevision`. A stale revision
returns a conflict; plugins and the CLI report it and never silently retry.

## Subscription delivery

The gateway never sends document content, a generated summary, a compiled
watch, an embedding score, or a matching threshold in a wake. Delivery
contains opaque identifiers, the exact subscriber-authored reaction
instruction, and a short-lived Answer credential bound to that firing.

Both plugins:

- validate the wire protocol before persistence;
- persist a delivery in a local durable inbox before acknowledging it;
- deduplicate redelivery by delivery and firing identity;
- park work while the native agent is unavailable;
- recover work that is known not to have started after restart;
- maintain a stable subscription-workflow-to-native-session binding;
- run reactions in dedicated background sessions, not the user's active chat.

Hermes parks a delivery whose durable state says native execution was starting
when the process crashed. That boundary is ambiguous, so it fails closed rather
than risk running the reaction twice.

If a reaction needs to understand why the subscription fired, it calls the
firing-bound Answer endpoint. For a document subscription, the gateway resolves
only the immutable documents recorded as evidence for that firing. For a SQL
watch, it provides only the approved condition and the fact/time that it became
true—never query rows or computed values. In either case the model receives no
general corpus tools, and the normal privacy reviewer, standing-grant,
policy-revision, expiry, revocation, cumulative-disclosure, and egress checks
still apply.

The firing-bound endpoint is intentionally narrower than generic MCP Answer:
it derives immutable evidence and authority from the delivered firing. It is
not the native integration's ordinary Answer API and must not be replaced by a
general corpus question without an equivalent firing-scoped MCP tool.

## Source layout

- `packages/agent-integration/` is the canonical shipped package. It contains
  the shared durable client, protocol, TLS, inbox, ingestion code, and the
  OpenClaw and Hermes assets installed by the CLI.
- `integrations/openclaw-omnesis-plugin/` is a standalone development
  entrypoint for exercising the OpenClaw plugin contract outside the packaged
  CLI flow. The Hermes adapter has no such mirror: `omnesis connect hermes`
  copies `__init__.py`, `adapter.py` and `plugin.yaml` out of
  `packages/agent-integration/hermes/` into the Hermes plugin directory, and
  `test_adapter.py` sits beside them and loads the same file.
- `packages/cli/src/commands/connect.ts` owns managed installation, pairing,
  credential provisioning, configuration, and health verification.

The prompt-facing skill exposes subscriptions in prose, not the watch DSL. An
integration states its condition as a sentence; Omnesis compiles it, inside the
gateway, into a watch the runtime can evaluate. The external agent never
supplies a watch document, a SQL query, or a threshold — a condition it cannot
express is refused rather than approximated, and the refusal comes back as one
of a closed set of codes (`unsupported_condition`, `not_a_condition`,
`ambiguous_request`, `compiler_failed`) with a fixed sentence for each.

The closed refusal vocabulary is deliberate. A compiler reasoning about a
condition has read the operator's corpus to decide whether it is expressible,
so its own words about why it refused cannot cross back to an off-host
integration. The code says what the agent needs to know — retry differently, or
do not retry — and nothing about what was read. Three of the four are settled
decisions that will answer the same way again; `compiler_failed` is the one
that means the transient thing happened, so it is the one worth retrying
unchanged.
