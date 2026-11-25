# Installation telemetry

Omnesis includes a small installation census, enabled by default on production
gateways. It measures adoption, active participating gateways and platform/version
distribution. It is separate from the cloud relay, push relay, account system and
gateway registration. It does not measure people or product usage.

## What is sent

The gateway sends an HTTPS `POST` to
`https://telemetry.omnesis.app/v1/heartbeat` with exactly these fields:

```json
{
  "schemaVersion": 1,
  "installationId": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "gatewayVersion": "0.7.8",
  "gitCommit": "custom",
  "os": "linux",
  "arch": "arm64",
  "period": "2026-11"
}
```

| Field            | Meaning                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `schemaVersion`  | Payload contract version, currently `1`.                                 |
| `installationId` | 64 lowercase hexadecimal characters derived for this UTC month.          |
| `gatewayVersion` | Gateway semantic version.                                                |
| `gitCommit`      | Full public upstream commit SHA, or `custom` when provenance is unknown. |
| `os`             | `linux`, `darwin`, `win32` or `other`.                                   |
| `arch`           | `x64`, `arm64`, `arm`, `ia32` or `other`.                                |
| `period`         | UTC calendar month, `YYYY-MM`.                                           |

Unknown fields are rejected. Requests have a 1 KiB body limit and global rate
limits. There is no third-party analytics SDK or analytics provider.

Source installations report a commit only after proving it belongs to the public
upstream main history or advertised public release tags. The provenance check asks for the public upstream tip;
it never sends a private local SHA to GitHub. Packaged builds include equivalent
build-time provenance. Modified, private-fork, unavailable or unverified commits
report `custom`. A public upstream tip unavailable in a shallow local checkout
may also produce `custom`.

## Frequency and first notice

The installer explains reporting before starting a gateway, without adding a
prompt. The first successful production startup schedules its first attempt after
a short grace period and random jitter. If no installer notice was recorded, it
waits until the portal displays its notice, then allows the same grace period;
clicking Agree is not a prerequisite for default-enabled reporting. The portal displays a small
non-blocking notice with **Agree** and **Disable telemetry**; acknowledgement and
the setting belong to the gateway, so another browser does not reset them.

Subsequent attempts run at least 24 hours apart, with up to one hour of random
jitter. Attempt timing persists across restarts. Requests have a four-second
deadline. Reporting is asynchronous; failed, timed-out or rejected requests do
not affect gateway operation. There is no offline upload queue or immediate
retry backlog.

## Monthly rotation

Each gateway creates an independent cryptographically random 256-bit secret in
its private configuration directory (`telemetry-secret-v1`, owner-only access).
It survives normal restarts and upgrades. It is neither the gateway UUID nor a
pairing, account or relay credential. The secret is never transmitted.

For each report, the gateway derives:

```text
period = current UTC calendar month
installationId = HMAC-SHA256(secret, "omnesis-telemetry:v1:" + period)
```

The server can deduplicate within that month. It has no key or mapping to link
the next month's identifier. No logic attempts cross-period correlation. Deleting
the secret or reinstalling without preserving the configuration creates a new
installation identity. Copying a whole configuration directory also copies this
secret, so clones can be undercounted.

## What is not collected

The payload excludes personal content, indexed documents, connected sources or
accounts, conversations, searches, feature usage, account/device/gateway IDs,
hostnames, hardware identifiers, email addresses and location. It includes no
precise client timestamp.

Network peers necessarily see an IP address while delivering a request. The
ingestion application does not record IP addresses, user agents, forwarded
headers, request URLs or other identifying HTTP metadata. Its rate limiter is
global, rather than keyed by IP. The deployment disables access logging and
request/error dumps in the ingress path; public ingress must not be enabled
until this is verified. Use a DNS-only Cloudflare record and direct HTTPS to
avoid introducing Cloudflare HTTP analytics in the telemetry request path.
DNS and network providers can still process ordinary transport metadata under
their own policies. This design does not promise network anonymity.

## Retention and statistics

SQLite stores only the first accepted report per identifier per UTC day, with
the fields above and the server's UTC date. It does not store raw HTTP bodies or
precise arrival times. Repeated heartbeats increment an aggregate volume counter
but do not add installations. Monthly distributions use the most recently
reported day's version/platform for each identifier.

Individual records are removed once their calendar month has ended and seven
complete UTC days have elapsed, at the next hourly cleanup (at most about 38
days plus a cleanup interval). SQLite uses secure deletion and a delete journal,
avoiding retained WAL history. Deployment backups must exclude individual
reports; snapshot or filesystem backups must not extend this retention.

Identifier-free daily, month-bounded weekly and monthly totals, monthly
version/commit/OS/architecture counts and operational counters are retained for
historical analysis. These aggregates contain no installation identifier.

The **Omnesis Installation Telemetry** Grafana dashboard uses those aggregates:

- Daily active installations are distinct identifiers observed that UTC day.
- Weekly active installations cover a UTC Monday-based week, split where it
  crosses a calendar month. The segments must not be summed into a unique count.
- Monthly active installations are distinct identifiers in one UTC calendar month.
- Month-over-month growth compares the two most recently completed months.
- Latest stable adoption uses the current month's latest reported versions and
  the published stable release, not the number of heartbeats received.

These are active, telemetry-participating gateway installations, never total
users or lifetime installs. Opt-outs, offline gateways, rejected reports and
network failures lower coverage. Incomplete days/months are partial. Unique
counts spanning a rotation boundary cannot be accurately deduplicated. Version
changes are reflected on the next accepted daily report. The public endpoint
cannot attest that every accepted report represents a real installation, and
minimal aggregate dimensions can still reveal uncommon platforms in small
populations. No installation-level dashboard or cross-month tracking is built.

## Disable or re-enable

Use **Settings → Config → Installation telemetry**, or run:

```sh
omnesis config set /telemetry/enabled false
omnesis config set /telemetry/enabled true
```

The equivalent persisted configuration is:

```json
{ "telemetry": { "enabled": false } }
```

The gateway applies changes live, cancels scheduled work, and aborts any
in-flight request. Bytes already delivered cannot be recalled. An environment
override wins over persisted configuration:

```sh
OMNESIS_TELEMETRY=off
```

Set it on the gateway service or in its configuration directory's `.env` before
startup. Remove the override and enable the setting to resume reporting.
Environment changes require the service environment to be reloaded; ordinary
configuration changes do not require a restart. Explicit opt-outs suppress the
first-time notice. Upgrades preserve both preference and acknowledgement.

## Test and development isolation

Production transport requires explicit production runtime authority. Direct
source gateway launches default to development. Installed `omnesis gateway
serve` and production images declare production mode, while test harnesses,
synthetic gateways, demos, development instances and benchmarks explicitly
declare non-production modes and disable telemetry. CI/test/synthetic markers
also veto production transport, even if configuration enables it. CI's network
guard blocks and audits production Omnesis DNS names, including telemetry.
Telemetry tests use injected transports or loopback endpoints, never synthetic
reports against the production ingestion database.

For a deliberate production source deployment outside the installer, launch the
gateway with `OMNESIS_RUNTIME_MODE=production`. Until the disclosure is
displayed in the portal, it will not report. This switch is not appropriate
for development, fixture or benchmark processes.

## Privacy and legal assessment

Default-enabled pseudonymous reporting is not automatically exempt from privacy
or terminal-equipment consent requirements. A monthly identifier remains
linkable within its month. Whether it is personal data, the applicable lawful
basis, required notices, rights handling and any consent exemption depend on the
jurisdiction and actual deployment. The **Agree** action acknowledges the notice;
it must not be described as prior opt-in consent when reporting can precede it.

Before distributing or operating this census, the operator must assess those
requirements, including local storage/access rules and processor obligations.
If a jurisdiction requires prior consent, the default-enabled policy must change
there. Technical minimisation and an easy opt-out alone do not establish legal
compliance. See the [EDPB guidance on anonymisation and pseudonymisation](https://www.edpb.europa.eu/topics/ai-and-technology/anonymisation-pseudonymisation_en)
and the [ICO's purpose-specific storage/access exceptions](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-the-exceptions/).
