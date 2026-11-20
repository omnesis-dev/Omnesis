# Local tailnet test actor

This module runs a real Tailscale SDK test coordinator, local DERP/STUN, and
userspace peers. The Gateway uses its production helper. The actor is a normal
Go test, so the SDK receives a real `testing.T` and every resource has teardown.

The pinned official Tailscale CLI reads each peer's actual LocalAPI through a
private Unix socket or a Windows pipe restricted to the current user. A native
adapter supplies that socket; it does not invent status or identity responses.
A CONNECT proxy carries application traffic through the peer's encrypted SDK
network. Online presence follows live control streams and key expiry, including
offline transitions. Certificate issuance is disabled to exercise the Gateway's
configured private certificate.

`scripts/tailnet-test/portable-tools.mjs` builds the actor and CLI from this
module with the pinned toolchain. Its source and binary checksums identify a
complete reusable build. `scripts/ci/portable-transports-proof.mjs` runs the real
registration, CLI, encrypted transport, ownership and presence controls before
the Gateway and Collector E2E scenarios. Generated peer state stays outside the
repository and is removed only after process ownership has closed.
