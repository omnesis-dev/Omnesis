#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
# Smoke the exact built image before publication. Uses only disposable state.
set -euo pipefail
image=${1:?image required}
role=${2:?gateway, collector, combined or updater required}
name="omnesis-image-check-$$-$RANDOM"
volume="$name-state"
collector_name="$name-collector"
collector_volume="$name-collector-state"
network="$name-network"
scratch=$(mktemp -d)
cleanup() {
  docker rm -f "$collector_name" "$name" "$name-locked" "$name-competitor" >/dev/null 2>&1 || true
  docker volume rm "$collector_volume" "$volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
[ "$(docker image inspect -f '{{.Config.User}}' "$image")" = '10001:10001' ]
docker run --rm --entrypoint omnesis "$image" --version
if [ "$role" = updater ]; then
  docker run --rm --entrypoint sh "$image" -c 'docker --version && docker compose version'
  exit 0
fi
case "$role" in gateway|collector|combined) ;; *) echo 'Unknown image role' >&2; exit 2;; esac
keyring_env=(-e OMNESIS_SECRET_STORE=passphrase -e OMNESIS_KEYRING_PASSPHRASE_FILE=/var/lib/omnesis/keyring.pass)
init_volume() {
  docker volume create "$1" >/dev/null
  # Disposable unlock material stays in its private test volume, never logs.
  docker run --rm --mount "type=volume,source=$1,target=/var/lib/omnesis" \
    --entrypoint node "$image" -e '
      const fs=require("node:fs");
      fs.writeFileSync("/var/lib/omnesis/keyring.pass", require("node:crypto").randomBytes(48).toString("hex"), {mode:0o600});
      fs.writeFileSync("/var/lib/omnesis/omnesis.json", JSON.stringify({inference:{assignments:{embedder:null}}}), {mode:0o600});
    '
  docker run --rm --mount "type=volume,source=$1,target=/var/lib/omnesis" \
    "${keyring_env[@]}" --entrypoint omnesis "$image" keyring init --backend passphrase >/dev/null
}
fixture_seeded=0
init_volume "$volume"
docker network create "$network" >/dev/null
start() {
  # A collector image contains the complete CLI closure, so use that exact
  # image to host its disposable gateway dependency without another pull.
  local command=()
  if [ "$role" = collector ]; then command=(--entrypoint node); fi
  local arguments=()
  if [ "$role" = collector ]; then arguments=(/app/packages/gateway/dist/index.js); fi
  docker run -d --name "$name" --cap-drop ALL --security-opt no-new-privileges \
    --network "$network" --network-alias gateway -p 127.0.0.1::7600 \
    --mount "type=volume,source=$volume,target=/var/lib/omnesis" \
    "${keyring_env[@]}" -e OMNESIS_MDNS_DISABLE=1 "${command[@]}" "$image" "${arguments[@]}" >/dev/null
  for attempt in $(seq 1 120); do
    if docker exec "$name" curl -fsSk https://localhost:7600/health >/dev/null 2>&1; then return; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ]; then break; fi
    sleep 2
  done
  docker logs "$name" >&2
  echo 'Gateway did not become healthy' >&2
  exit 1
}
check_collector() {
  for attempt in $(seq 1 60); do
    if docker exec "$name" omnesis devices list --json | python3 -c '
import json,sys
value=json.load(sys.stdin)
items=value if isinstance(value,list) else value.get("items",[])
sys.exit(0 if any(d.get("kind")=="collector" and d.get("online") for d in items) else 1)
'; then return; fi
    if [ "$attempt" -eq 60 ]; then
      docker logs "$name" >&2
      if [ "$role" = collector ]; then docker logs "$collector_name" >&2; fi
      exit 1
    fi
    sleep 2
  done
}
stop_cleanly() {
  docker stop --time 120 "$1" >/dev/null
  [ "$(docker inspect -f '{{.State.ExitCode}}' "$1")" = 0 ]
}
check_encryption() {
  docker exec "$name" node -e '
    const fs = require("node:fs");
    for (const name of ["omnesis.db", "index.db"]) {
      const data = fs.readFileSync(`/var/lib/omnesis/${name}`);
      if (data.length < 16 || data.subarray(0,15).toString() === "SQLite format 3") {
        throw new Error(`${name} is empty or plaintext`);
      }
    }
  '
}
check_mcp() {
  docker cp "$name:/var/lib/omnesis/tls/cert.pem" "$scratch/cert.pem" >/dev/null
  local port url status
  port=$(docker inspect -f '{{(index (index .NetworkSettings.Ports "7600/tcp") 0).HostPort}}' "$name")
  url="https://localhost:$port"
  curl --fail --silent --show-error --cacert "$scratch/cert.pem" \
    "$url/.well-known/oauth-protected-resource" > "$scratch/metadata.json"
  python3 - "$scratch/metadata.json" "$url" <<'PY'
import json,sys
with open(sys.argv[1]) as f: metadata=json.load(f)
assert metadata['resource'] == sys.argv[2] + '/mcp', metadata
assert metadata['authorization_servers'] == [sys.argv[2]], metadata
PY
  status=$(curl --silent --show-error --cacert "$scratch/cert.pem" \
    -D "$scratch/headers" -o "$scratch/response" -w '%{http_code}' \
    -H 'Content-Type: application/json' -X POST "$url/mcp" \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"docker-smoke","version":"1.0.0"}}}')
  [ "$status" = 401 ]
  python3 - "$scratch/headers" "$url" <<'PY'
import sys
with open(sys.argv[1]) as f: headers=f.read().lower()
assert 'www-authenticate:' in headers, headers
assert 'resource_metadata="' + sys.argv[2] + '/.well-known/oauth-protected-resource/mcp"' in headers, headers
PY
  # Exercise DCR, PKCE, owner approval, initialize, tools/list and revocation
  # with the production SDK. The mounted helper never invokes a model.
  cp packages/collector/src/e2e/mcp-oauth-helper.ts "$scratch/helper.ts"
  (umask 077; docker exec "$name" node --input-type=module -e '
    import { readTokenFile, primeSecretFileKeyCache } from "/app/packages/core/dist/index.js";
    await primeSecretFileKeyCache({configDir:"/var/lib/omnesis"});
    const token = readTokenFile("/var/lib/omnesis");
    if (!token) throw new Error("Bootstrap credential unavailable");
    process.stdout.write(token);
  ' > "$scratch/token")
  docker run --rm -i --network host --user "$(id -u):$(id -g)" \
    --cap-drop ALL --security-opt no-new-privileges \
    --mount "type=bind,source=$scratch,target=/app/.mcp-smoke,readonly" \
    -e NODE_EXTRA_CA_CERTS=/app/.mcp-smoke/cert.pem -e "MCP_SMOKE_URL=$url" \
    --entrypoint node "$image" --input-type=module <<'JS'
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { authorizeMcpClient, revokeAccess } from "/app/.mcp-smoke/helper.ts";
const deadline = setTimeout(() => {
  process.stderr.write("Docker MCP OAuth smoke timed out\n");
  process.exit(1);
}, 120_000);
try {
  const gatewayUrl = process.env.MCP_SMOKE_URL;
  const authorized = await authorizeMcpClient({
    gatewayUrl, apiKey: readFileSync("/app/.mcp-smoke/token", "utf8"),
  }, {
    principalName: `Docker smoke retrieval client ${randomUUID()}`,
    grantName: "Docker smoke Direct access",
    credentialLabel: "Docker smoke OAuth credential",
    capabilities: ["direct"],
  });
  const accessToken = authorized.provider.savedTokens?.access_token;
  assert(accessToken, "Approved MCP client has no access credential");
  try {
    const result = await authorized.client.listTools();
    assert(result.tools.length > 0, "Approved Direct client received no MCP tools");
  } finally {
    try {
      await revokeAccess(gatewayUrl, authorized.portal, {
        kind: "credential", id: authorized.credentialId,
      });
      const revoked = await fetch(`${gatewayUrl}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{
          protocolVersion:"2026-07-28",capabilities:{},clientInfo:{name:"revoked-smoke",version:"1.0.0"},
        }}),
      });
      assert.equal(revoked.status, 401, "Revoked OAuth credential still authorizes MCP");
      await revoked.body?.cancel();
    } finally {
      await Promise.allSettled([authorized.client.close(), authorized.transport.close()]);
    }
  }
} finally {
  clearTimeout(deadline);
}
JS
  rm -f "$scratch/token"
}
fixture() {
  docker exec -i -e NODE_EXTRA_CA_CERTS=/var/lib/omnesis/tls/cert.pem "$name" \
    node --input-type=module - "$1" <<'NODE'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { primeSecretFileKeyCache, readTokenFile } from '/app/packages/core/dist/index.js';
await primeSecretFileKeyCache({configDir:'/var/lib/omnesis'});
assert.equal(JSON.parse(readFileSync('/var/lib/omnesis/omnesis.json','utf8')).inference.assignments.embedder,null);
const token=readTokenFile('/var/lib/omnesis');
const title='container-persistence-fixture';
const content='An invented guide to sorting toy blocks by shape and colour.';
const call=async (path,body,timeout=10_000)=>{
  const result=await fetch('https://localhost:7600'+path,{
    method:body ? 'POST':'GET',
    signal:AbortSignal.timeout(timeout),
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    ...(body ? {body:JSON.stringify(body)}:{})
  });
  assert(result.ok, `Fixture API returned HTTP ${result.status}`);
  return result.json();
};
if(process.argv[2]==='seed') {
  const now=new Date().toISOString();
  const result=await call('/documents',{documents:[{
    providerId:'web',sourceId:'web',externalId:'docker-persistence-fixture',title,content,
    contentHash:createHash('sha256').update(content).digest('hex'),
    metadata:{documentType:'webpage',sourceUrl:'https://example.org/container-fixture'},
    sourceCreatedAt:now,sourceUpdatedAt:now
  }]});
  assert.equal(result.ingested,1);
}
const results=await call('/documents/search?q='+encodeURIComponent('sorting toy blocks'));
assert.equal(results.results.length,1,'Persistent document is missing or duplicated');
const document=await call('/documents/'+results.results[0].id);
assert.equal(document.title,title);
assert.equal(document.content,content);
const marker='/var/lib/omnesis/.smoke-document-id';
if(process.argv[2]==='seed') writeFileSync(marker,document.id,{mode:0o600});
else assert.equal(document.id,readFileSync(marker,'utf8'));
// The raw-document check above does not prove the asynchronous keyword index.
// Exercise the ordinary search pipeline with no embedding model, after every boot.
const deadline=performance.now()+90_000;
const requestBudget=()=>{
  const remaining=Math.ceil(deadline-performance.now());
  assert(remaining>0,'Keyword worker and persistent search result did not become ready within 90s');
  return Math.min(10_000,remaining);
};
for (;;) {
  const stats=await call('/index/stats',undefined,requestBudget());
  if(stats.keywordIndexingActive===true) {
    assert.equal(stats.model,null,'No-model smoke unexpectedly enabled an embedding model');
    const search=await call('/search',{text:'sorting toy blocks',limit:10},requestBudget());
    assert(Array.isArray(search.results),'Search did not return a results array');
    if(search.results.length) {
      assert.deepEqual(search.results.map(hit=>({id:hit.documentId,title:hit.title})),[{id:document.id,title}],
        'Keyword search lost, duplicated or replaced the persistent document');
      break;
    }
  }
  await delay(Math.min(500,Math.max(0,deadline-performance.now())));
}
NODE
}
start
check_encryption
if [ "$fixture_seeded" = 1 ]; then fixture check; fi
check_mcp
fixture seed
fixture_seeded=1
identity=$(docker exec "$name" sha256sum /var/lib/omnesis/token /var/lib/omnesis/tls/cert.pem)
# A second container shares the filesystem but has a different PID namespace
# and hostname. It must refuse ownership before opening any store.
competitor="$name-competitor"
docker run -d --name "$competitor" --network "$network" \
  --mount "type=volume,source=$volume,target=/var/lib/omnesis" \
  "${keyring_env[@]}" -e OMNESIS_GATEWAY_LOCK_WAIT_MS=0 -e OMNESIS_MDNS_DISABLE=1 \
  --entrypoint node "$image" /app/packages/gateway/dist/index.js >/dev/null
for attempt in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Running}}' "$competitor")" = true ] || break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Running}}' "$competitor")" = false ]
[ "$(docker inspect -f '{{.State.ExitCode}}' "$competitor")" != 0 ]
docker logs "$competitor" 2>&1 | grep -q 'already owns this configuration directory'
docker rm "$competitor" >/dev/null
docker exec "$name" curl -fsSk https://localhost:7600/health >/dev/null
if [ "$role" = collector ]; then
  init_volume "$collector_volume"
  # Mint through the authenticated API; redeem through the real CLI with an
  # explicit certificate pin. No bootstrap credential is given to the collector.
  pairing=$(docker exec -e NODE_EXTRA_CA_CERTS=/var/lib/omnesis/tls/cert.pem "$name" node --input-type=module -e '
    import { readTokenFile, primeSecretFileKeyCache } from "/app/packages/core/dist/index.js";
    await primeSecretFileKeyCache({configDir:"/var/lib/omnesis"});
    const response = await fetch("https://localhost:7600/admin/devices/pair", {
      method: "POST", headers: {"Content-Type":"application/json", Authorization: `Bearer ${readTokenFile("/var/lib/omnesis")}`},
      body: JSON.stringify({kind:"collector",name:"Docker smoke collector"})
    });
    if (!response.ok) throw new Error(`Pair code request failed: ${response.status}`);
    console.log((await response.json()).pairingCode);
  ')
  fingerprint=$(docker exec "$name" node -e 'const {X509Certificate}=require("node:crypto"); console.log(new X509Certificate(require("node:fs").readFileSync("/var/lib/omnesis/tls/cert.pem")).fingerprint256.replaceAll(":", ""))')
  docker run --rm --network "$network" \
    --mount "type=volume,source=$collector_volume,target=/var/lib/omnesis" \
    "${keyring_env[@]}" --entrypoint omnesis "$image" pair "$pairing" \
    --gateway-url https://gateway:7600 --trust-fingerprint "$fingerprint" \
    --save /var/lib/omnesis/collector-token >/dev/null
  start_collector() {
    docker run -d --name "$collector_name" --cap-drop ALL --security-opt no-new-privileges \
      --network "$network" --mount "type=volume,source=$collector_volume,target=/var/lib/omnesis" \
      "${keyring_env[@]}" -e OMNESIS_GATEWAY_URL=https://gateway:7600 -e OMNESIS_MDNS_DISABLE=1 "$image" >/dev/null
  }
  start_collector
  check_collector
  collector_identity=$(docker exec "$collector_name" sha256sum /var/lib/omnesis/collector-token)
  stop_cleanly "$collector_name"
  docker rm "$collector_name" >/dev/null
  start_collector
  check_collector
  [ "$collector_identity" = "$(docker exec "$collector_name" sha256sum /var/lib/omnesis/collector-token)" ]
  stop_cleanly "$collector_name"
fi
if [ "$role" = combined ]; then check_collector; fi
stop_cleanly "$name"
docker rm "$name" >/dev/null
start
check_encryption
if [ "$fixture_seeded" = 1 ]; then fixture check; fi
check_mcp
if [ "$role" = combined ]; then check_collector; fi
[ "$identity" = "$(docker exec "$name" sha256sum /var/lib/omnesis/token /var/lib/omnesis/tls/cert.pem)" ]
stop_cleanly "$name"
docker rm "$name" >/dev/null
# Losing the unlock file must fail closed, without replacing encrypted stores
# with a fresh plaintext installation. Restoring it must recover the identity.
docker run --rm --mount "type=volume,source=$volume,target=/var/lib/omnesis" \
  --entrypoint node "$image" -e 'require("node:fs").renameSync("/var/lib/omnesis/keyring.pass", "/var/lib/omnesis/keyring.pass.saved")'
missing_name="$name-locked"
docker run -d --name "$missing_name" --network "$network" \
  --mount "type=volume,source=$volume,target=/var/lib/omnesis" \
  "${keyring_env[@]}" -e OMNESIS_MDNS_DISABLE=1 --entrypoint node "$image" /app/packages/gateway/dist/index.js >/dev/null
for attempt in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Running}}' "$missing_name")" = true ] || break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Running}}' "$missing_name")" = false ]
[ "$(docker inspect -f '{{.State.ExitCode}}' "$missing_name")" != 0 ]
docker rm "$missing_name" >/dev/null
docker run --rm --mount "type=volume,source=$volume,target=/var/lib/omnesis" \
  --entrypoint node "$image" -e 'require("node:fs").renameSync("/var/lib/omnesis/keyring.pass.saved", "/var/lib/omnesis/keyring.pass")'
start
check_encryption
if [ "$fixture_seeded" = 1 ]; then fixture check; fi
[ "$identity" = "$(docker exec "$name" sha256sum /var/lib/omnesis/token /var/lib/omnesis/tls/cert.pem)" ]
# An ungraceful container death must release kernel ownership. Its replacement
# receives a new hostname/PID namespace and recovers the same encrypted stores.
docker kill --signal KILL "$name" >/dev/null
[ "$(docker wait "$name")" = 137 ]
docker rm "$name" >/dev/null
start
check_encryption
if [ "$fixture_seeded" = 1 ]; then fixture check; fi
if [ "$role" = combined ]; then check_collector; fi
[ "$identity" = "$(docker exec "$name" sha256sum /var/lib/omnesis/token /var/lib/omnesis/tls/cert.pem)" ]
stop_cleanly "$name"
echo "Passed $role encrypted boot, TLS/MCP discovery, graceful shutdown and durable identity checks"
