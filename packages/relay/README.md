# `@omnesis/relay`

The relay wakes official Omnesis iOS and Android installs on behalf of
self-hosted gateways. It never accepts notification content. A gateway sends an
authenticated, empty `POST /v1/wake`; the carrier receives a constant wake; the
phone retrieves the notification from its paired gateway.

The service stores only carrier addressing and operational state in SQLite:

- hashed relay credentials and the carrier token each authorizes;
- short-lived, one-use enrolment challenges;
- per-credential wake timestamps used for rate limiting.

It stores no account, gateway, notification title, body, target id, or corpus
content.

## Runtime contract

The container serves plain HTTP on the internal network. It does not terminate
TLS, read certificates, or bind a privileged port. Put it behind an outbound
reverse tunnel or an equivalent TLS-terminating proxy, and do not publish the
container port directly. The production API requires Cloudflare's validated
`CF-Connecting-IP` header on every `/v1/*` request; it is therefore safe only
when the origin remains unreachable except through the Cloudflare Tunnel.

Both carrier credentials are required at startup:

| Environment variable                     | Meaning                                                       |
| ---------------------------------------- | ------------------------------------------------------------- |
| `OMNESIS_RELAY_HOST`                     | Internal bind address; default `0.0.0.0`                      |
| `OMNESIS_RELAY_PORT`                     | Unprivileged HTTP port; default `8080`                        |
| `OMNESIS_RELAY_METRICS_HOST`             | Internal metrics bind; default `127.0.0.1`                    |
| `OMNESIS_RELAY_METRICS_PORT`             | Internal metrics port; default `9090`                         |
| `OMNESIS_RELAY_DB_PATH`                  | SQLite path; default `/var/lib/omnesis-relay/relay.db`        |
| `OMNESIS_RELAY_APNS_KEY_PATH`            | Read-only mounted Apple `.p8` path                            |
| `OMNESIS_RELAY_APNS_KEY_ID`              | Apple key id                                                  |
| `OMNESIS_RELAY_APNS_TEAM_ID`             | Apple team id                                                 |
| `OMNESIS_RELAY_APNS_APP_IDS`             | Comma-separated bundle ids the key may serve here             |
| `OMNESIS_RELAY_FCM_SERVICE_ACCOUNT_PATH` | Read-only mounted service-account JSON path                   |
| `OMNESIS_RELAY_FCM_APP_IDS`              | Comma-separated Android app identities this deployment serves |

Admission controls have conservative, operator-overridable defaults:

| Environment variable                      | Default | Meaning                                                                        |
| ----------------------------------------- | ------: | ------------------------------------------------------------------------------ |
| `OMNESIS_RELAY_ENROL_SOURCE_LIMIT`        |      30 | Enrol attempts per source window                                               |
| `OMNESIS_RELAY_VERIFY_SOURCE_LIMIT`       |      60 | Verification attempts per source window                                        |
| `OMNESIS_RELAY_INVALID_WAKE_SOURCE_LIMIT` |     120 | Invalid wake credentials per source window                                     |
| `OMNESIS_RELAY_SOURCE_WINDOW_MS`          |  600000 | Shared source rolling window                                                   |
| `OMNESIS_RELAY_GLOBAL_ENROL_LIMIT`        |     120 | Carrier challenge dispatches per global window                                 |
| `OMNESIS_RELAY_RENEWAL_ENROL_LIMIT`       |      30 | Additional dispatches for an already enrolled carrier target per global window |
| `OMNESIS_RELAY_GLOBAL_ENROL_WINDOW_MS`    |   60000 | Global dispatch rolling window                                                 |
| `OMNESIS_RELAY_CARRIER_FAILURE_LIMIT`     |       5 | Recent challenge carrier-failure score                                         |
| `OMNESIS_RELAY_CARRIER_FAILURE_WINDOW_MS` |  600000 | Carrier-failure penalty window                                                 |
| `OMNESIS_RELAY_MAX_TRACKED_SOURCES`       |   10000 | In-memory source-counter ceiling                                               |
| `OMNESIS_RELAY_MAX_PENDING_CHALLENGES`    |    1000 | Live pending challenge ceiling                                                 |
| `OMNESIS_RELAY_CHALLENGE_TTL_MS`          |  120000 | One-use challenge lifetime                                                     |

Source counters are bounded, process-local, and never written to SQLite, logs,
or metrics. A successful challenge dispatch pays down one recent carrier
failure instead of erasing the source's history. At the memory ceiling, the
least recently used unverified counter state is replaced first, preserving
recent possession-verified sources without letting rotating addresses lock out
every newcomer. If every slot is verified, the oldest state is still replaced;
the global enrolment circuit breaker remains the hard carrier-spend ceiling for
new targets. A separate bounded circuit and the last 10% of pending challenge
capacity remain available to carrier targets with an active relay credential,
so a first-time enrolment surge does not prevent those phones from rotating a
credential. A first-time enrolment can still be delayed by a distributed
attack; no unverified request has a trusted identity before carrier proof.
Valid wake credentials are never source-limited; they remain subject only to
the per-credential wake limits.

`OMNESIS_RELAY_APNS_BASE_URL` and `OMNESIS_RELAY_FCM_BASE_URL` are optional
carrier-origin overrides for isolated testing. They should be unset in normal
operation.

The gateway does not select a relay unless both experimental mode and its
explicit kill switch are enabled. The endpoint defaults to the published
Omnesis origin and can be replaced for a self-hosted deployment:

```yaml
gateway:
  pushRelay:
    enabled: false
    url: https://push.omnesis.app
```

Changing the URL makes existing relay registrations unavailable until each
phone re-enrols, so the gateway never continues sending wakes to an old origin.

Mount both credential files read-only from owner-only host paths. Do not copy
them into an image or place them in the build context. The Dockerfile copies
source and dependencies only, runs as the unprivileged `node` user, exposes
port 8080 inside the container, and contains no TLS or certificate handling.
Startup fails before binding the HTTP port unless both mounted paths are regular
owner-only files, the APNs file contains an EC private key, and the FCM JSON
contains the required identity and a parseable RSA private key.

## Protocol

- `POST /v1/enrol` starts possession proof and returns a challenge id. The
  relay first verifies that its carrier credential covers the submitted app
  identity, then sends a nonce through that exact carrier token. A global
  rolling circuit breaker rejects excess dispatches before contacting the
  carrier, and the pending challenge table has a hard configured ceiling.
- `POST /v1/enrol/verify` accepts the echoed nonce once and returns a
  long-lived credential scoped to that carrier token.
- `POST /v1/wake` requires the credential in `Authorization: Bearer …` and an
  empty body. Limits are 30 wakes/hour and 300 wakes/day per credential.
- `GET /health` reports accepted protocol versions and carrier reachability.
  It returns `200` with `status: "ready"` only after both carriers have
  succeeded. It returns `503` with `status: "unknown"` before reachability has
  been proved, or `status: "degraded"` after a carrier failure or incomplete
  carrier configuration.

Credentials are stored as SHA-256 digests, can be revoked independently in the
store, and have no hard expiry. Enrolment challenges expire after two minutes
by default and cannot be replayed.

Successful re-enrolment for the exact same platform, carrier token, app
identity, and environment atomically activates the new credential, revokes all
older credentials for that target, and erases their carrier addressing. Failed
or expired possession proof leaves the existing credential active.

## Health monitoring

Use the built-in health check from outside the relay's TLS-terminating proxy.
The maximum success age should be longer than the interval of the controlled
iOS and Android canaries that exercise real carrier delivery:

```sh
omnesis-relay check-health \
  --url https://relay.example.com \
  --max-success-age-seconds 900
```

The command requests only `GET /health`. It requires the current enrolment and
wake protocols, `ready` status, both configured carriers to be reachable, and
both success timestamps to be recent. It also rejects carrier timestamps more
than 60 seconds in the future by default. `--timeout-seconds` and
`--max-clock-skew-seconds` override those probe limits.

Exit status `0` means ready and fresh, `1` means the relay responded but is not
ready or fresh, `2` means the request or response failed, and `64` means the
command arguments were invalid. Plain HTTP origins are accepted only on
loopback for isolated local checks. This command does not send a carrier
message; scheduled real-device canaries are still required to advance the
carrier success timestamps.

Prometheus-format operational metrics are served separately on the internal
metrics bind at `GET /metrics`. Never route that bind through the public tunnel
or publish it as a host port. Wildcard metrics binds are rejected at startup.
Labels are fixed enums only: metrics expose
aggregate operation outcomes, bounded rejection reasons, carrier outcomes and
latency, active credentials, unanswered enrolment challenges, and build
identity. `relay_enrolments_total{platform,outcome}` counts `accepted` only
after successful possession verification, `failed` when challenge dispatch
fails, and `rejected` for uncovered or unavailable carriers and rejected
verification of a known challenge. Expired unanswered challenges are pruned
and counted every minute even when the relay receives no requests.
`relay_credential_mint_failures_total{platform}` counts APNs JWT and FCM OAuth
mint failures, while
`relay_credentials_pruned_total{platform,reason}` counts credentials erased
after a known stale-token rejection. They contain no carrier token, relay
credential or digest, nonce, app identity, gateway identity, notification data,
raw carrier response, or request source. `relay_abuse_rejections_total` uses
only fixed endpoint and reason labels.

## Offline credential revocation

An operator can revoke one credential without loading APNs or FCM configuration.
Prefer an owner-only file containing exactly the relay credential:

```sh
chmod 600 /run/secrets/relay-credential
omnesis-relay revoke --db /var/lib/omnesis-relay/relay.db \
  --secret-file /run/secrets/relay-credential
```

If an incident system already holds the SHA-256 digest, it can be supplied
directly:

```sh
omnesis-relay revoke --db /var/lib/omnesis-relay/relay.db \
  --digest 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

The command prints neither the secret nor its digest. Exit status `0` means one
active credential was revoked; `1` means it was already inactive/not found or
the operation failed; `64` means the command usage was invalid. Revocation
retains only the credential digest and revocation time while erasing its carrier
token and app identity.
