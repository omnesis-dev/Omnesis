# Omnesis embedded Tailscale (experimental)

With `OMNESIS_TAILSCALE_EMBED_ENABLED=1`, an Omnesis gateway can join its
owner's Tailscale network as its own device, called `omnesis`, without
Tailscale being installed on its computer. This package is the small Go
program that does it, built on Tailscale's embeddable library (tsnet). The
gateway starts it, talks to it over standard input and output, and stops it
by closing its input.

The flag is independent of `OMNESIS_EXPERIMENTAL`. Without it nothing
changes: no settings tab, no `omnesis tailscale` command, no new fields in
`/health` or `/status`, and the program is never started. A gateway that
merely finds Tailscale installed on its computer keeps working as before
either way; the two can run side by side.

## Using it

Set `OMNESIS_TAILSCALE_EMBED_ENABLED=1` for the gateway (and for the CLI
where you run `omnesis tailscale` commands), then open **Settings → Tailscale**
in the portal, or run `omnesis tailscale on`. Sign in from the link or QR code
it shows. The gateway is then reachable from every device on your tailnet at
`https://omnesis.<your-tailnet>.ts.net`, with a publicly trusted certificate
when the tailnet has HTTPS certificates turned on, and with the gateway's own
certificate otherwise.

- **Public address for cloud agents** (`omnesis tailscale public on`): opens
  only what ChatGPT and Claude's connectors need to connect and sign in —
  the MCP endpoint, the OAuth and well-known paths, the data-source sign-in
  callback and the sign-in page's static files — through Tailscale Funnel.
  Every other path does not exist on the public side. Tailscale asks the
  account owner to allow Funnel once; the page shows that link.
- **Collectors joining through Tailscale** (`omnesis tailscale joining
ask|automatic|off`, default `ask`): on a collector's machine that runs
  Tailscale, `omnesis tailscale join` finds the gateway on the tailnet and
  asks to join without a pairing code. Only an untagged device of the same
  Tailscale user as the gateway may ask; tagged devices and devices shared
  in from other people always pair with a code. "Ask" holds the request for
  the owner to approve on their phone (notification) or in the portal.
- **Phones** keep pairing with a QR code. A QR code for the tailnet address
  carries a marker, so an app that cannot reach it says to connect Tailscale
  on the phone and offers to open it.
- **Docker**: the gateway image carries the program and sets
  `OMNESIS_TAILSCALE_HELPER`. The device's identity is kept under the config
  volume (`<config>/tailscale/`), so updates keep it signed in.
- **From source**: build the program with `npm run tailnet-helper:build`
  (needs the Go version in `go.mod`), or point `OMNESIS_TAILSCALE_HELPER` at a
  copy.

## How it works

The program joins the tailnet in userspace and forwards every request, from
the tailnet and from the public address, to a Unix socket the gateway opens
for it alone on POSIX (`<config>/tailscale/gateway.sock`, or a short path under
the runtime directory, mode `0600`). Windows uses a fresh named pipe over TLS:
the helper pins the gateway certificate loaded for that listener, and the gateway
authenticates a per-service token passed in the helper's private environment.
The token never enters command arguments or a persistent file. Both the token
and caller header are removed before the gateway app sees the request.
It names the caller in one header: the
caller's address and, for a tailnet device, what Tailscale says about it
(device, user, tags, and whether it belongs to the gateway's own user). The
gateway believes that header only on that socket; any copy a caller sends is
removed by the program and ignored everywhere else.

The program refuses public requests outside the public paths before they
reach the gateway, and the gateway refuses them again. Public and tailnet
connections arrive on separate listeners, so the two can never be confused.

The program clears every `TS_` environment variable at start (so a stray
`TS_AUTHKEY` cannot sign it in to someone else's account) and turns off
Tailscale's log upload: this device's logs never leave the machine.

`internal/protocol` defines the conversation with the gateway; the gateway
mirrors it in `packages/gateway/src/tailscale-embed/protocol.ts`.

## Testing

- `go test ./...` here, also run by the unit lane through `go.test.mjs`.
- The gateway side: `packages/gateway/src/tailscale-embed/*.test.ts`, with a
  scripted stand-in for this program (`testing/fake-helper.mjs`), and
  `tailscale-embed-flag-off.test.ts` for the flag.
- End to end: `packages/collector/src/e2e/tailscale-embed.e2e.test.ts` runs a
  private tailnet on loopback — headscale as the coordination server,
  Tailscale's relay server, real `tailscaled` machines for the owner's laptops,
  another person's laptop and a tagged server — against a real gateway and this
  program. `node scripts/tailnet-test/tools.mjs` provisions those programs.

headscale offers neither Tailscale's certificates nor Funnel, so the end-to-end
suite covers the gateway's own certificate on the tailnet and the public
address reporting itself unavailable. The trusted certificate and the public
address need a real Tailscale account to exercise.
