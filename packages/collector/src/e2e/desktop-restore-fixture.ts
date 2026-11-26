// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnOwnedChildProcess } from "@omnesis/core";
import { createMailbox, deliverMessage } from "@omnesis/provider-maildir/testing";
import { waitForCondition } from "./multi-collector-harness.js";
import type { DesktopRuntimeFixture } from "./desktop-runtime-fixture.js";

const moduleUrl = (name: string) =>
  new URL(`../../../cli/src/desktop/${name}.ts`, import.meta.url).href;

/** Ordinary headless collection seeds a real backup; desktop account gating remains intact. */
export async function addRestoreMaildirSource(
  source: DesktopRuntimeFixture,
  options: { pairing?: "admin" | "code" } = {},
): Promise<string> {
  const path = join(source.root, "restore-mail");
  deliverMessage(createMailbox(join(path, "INBOX")), "restore-fixture-message", {
    from: { address: "sender@example.org" },
    to: [{ address: "owner@example.com" }],
    subject: "Fictional restore mail marker",
    date: "2026-01-01T09:00:00Z",
    text: "Invented mail content for encrypted restore verification.",
    messageId: "restore-fixture@example.org",
  });
  const home = join(source.root, "headless-home"),
    configDir = join(home, "config");
  const setup = JSON.parse(
    await source.script(`
    const {mkdir,writeFile,readFile}=await import('node:fs/promises');
    const {join}=await import('node:path');
    const {createHash,X509Certificate}=await import('node:crypto');
    const {defaultScopesForDeviceKind}=await import('@omnesis/types');
    const {ensureInstallRootKey,markSecretFileEncryptionRequired,markStorageEncryptionRequired,readInstallRootKey,verifySecureMarker,readMarkerKeyringState,
      writeSecretTextFile,writeCollectorPairingState,tokenFingerprint,secureMarkerStateKeyName}=await import('@omnesis/core');
    const {readDesktopConnection,requestDesktopGateway}=await import(${JSON.stringify(moduleUrl("gateway-access"))});
    const home=${JSON.stringify(home)},configDir=${JSON.stringify(configDir)};
    await mkdir(configDir,{recursive:true,mode:0o700});
    const service='dev.omnesis.fixture.'+createHash('sha256').update(configDir).digest('hex');
    const accounts=['install-root-key-v1',...['secret-files','storage-encryption'].map(kind=>secureMarkerStateKeyName(kind,configDir))];
    // Only the external OS credential adapter is replaced; its existing private file format is shared with the child fixture command.
    const runCommand=async(command,args)=>{
      if(command!=='security'&&command!=='/usr/bin/security')throw new Error('Unexpected fixture credential command');
      if(args.length===1&&args[0]==='-h')return {code:0,stdout:'',stderr:''};
      const option=flag=>args[args.indexOf(flag)+1],account=option('-a');
      if(option('-s')!==service||!accounts.includes(account))throw new Error('The fixture credential selector changed');
      const file=join(${JSON.stringify(join(source.root, "keychain"))},createHash('sha256').update(JSON.stringify([service,account])).digest('hex'));
      let existing=null;
      try{existing=await readFile(file,'utf8');}catch(error){if(error.code!=='ENOENT')throw new Error('The fixture credential could not be read');}
      if(args[0]==='find-generic-password')return existing===null?{code:44,stdout:'',stderr:''}:{code:0,stdout:args.includes('-w')?existing+'\\n':'',stderr:''};
      if(args[0]!=='add-generic-password')throw new Error('Unexpected fixture credential mutation');
      const value=option('-w');
      if(existing!==null)return {code:existing===value?0:45,stdout:'',stderr:''};
      await writeFile(file,value,{mode:0o600,flag:'wx'});
      return {code:0,stdout:'',stderr:''};
    };
    const keyOptions={configDir,service,backend:'macos-keychain',runCommand};
    const root=await ensureInstallRootKey(keyOptions);
    if(!root.valid||!root.store.secure)throw new Error('The fixture headless root is not protected');
    await markSecretFileEncryptionRequired(configDir,keyOptions);
    await markStorageEncryptionRequired(configDir,keyOptions);
    const rootValue=await readInstallRootKey(keyOptions);
    if(!rootValue)throw new Error('The fixture headless root could not be read');
    for(const kind of ['secret-files','storage-encryption']){
      if(await verifySecureMarker(kind,rootValue,configDir)!=='valid'||await readMarkerKeyringState(kind,keyOptions)!=='required')
        throw new Error('The fixture headless protection was not confirmed');
    }
    const connection=await readDesktopConnection(profile);
    const paired=${JSON.stringify(options.pairing === "code")} ? await (async()=>{
      const {redeemPairingCode}=await import(${JSON.stringify(new URL("../../../cli/src/commands/devices.ts", import.meta.url).href)});
      const issued=await requestDesktopGateway(profile,'/admin/devices/pair',{method:'POST',body:{kind:'collector',name:'source Linux reader'}});
      if(typeof issued.pairingCode!=='string')throw new Error('The collector pairing code was not issued');
      return redeemPairingCode(connection.url,issued.pairingCode,configDir,new X509Certificate(connection.certificatePEM).fingerprint256,'source Linux reader');
    })() : await requestDesktopGateway(profile,'/admin/devices',{method:'POST',body:{
      name:'restore fixture reader',kind:'collector',scopes:defaultScopesForDeviceKind('collector'),
      capabilities:{hostname:'restore-reader.example.org',platform:'linux'}
    }});
    if(typeof paired.token!=='string'||!paired.device?.id)throw new Error('The real headless pairing was refused');
    if(${JSON.stringify(options.pairing === "code")}){
      if(!Array.isArray(paired.scopes)||paired.scopes.includes('admin')||!paired.scopes.includes('read')||!paired.scopes.includes('write:*'))throw new Error('The collector grant did not preserve its role');
      const {request}=await import('node:https');
      const status=await new Promise((resolve,reject)=>{
        const req=request(new URL('/admin/devices',connection.url),{ca:connection.certificatePEM,rejectUnauthorized:true,headers:{authorization:'Bearer '+paired.token},signal:AbortSignal.timeout(15000)},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));response.once('error',reject);});
        req.once('error',reject);req.end();
      });
      if(status!==403)throw new Error('The source collector unexpectedly acquired gateway administration');
    }
    await writeSecretTextFile(join(configDir,'collector-token'),paired.token,keyOptions);
    if(!writeCollectorPairingState(configDir,{
      state:'paired',deviceName:paired.device.name,deviceId:paired.device.id,gatewayUrl:connection.url,
      tokenFingerprint:tokenFingerprint(paired.token),lastAuthenticatedAt:null,unauthorizedAt:null,repairCommand:null
    }))throw new Error('The owned collector pairing could not be saved');
    await writeFile(join(home,'parent-lifetime.mjs'),"process.stdin.resume();process.stdin.once('end',()=>process.kill(process.pid,'SIGTERM'));",{mode:0o600,flag:'wx'});
    // Public connection metadata only: the real paired credential remains sealed in its own config.
    process.stdout.write(JSON.stringify({deviceId:paired.device.id,service,url:connection.url,
      fingerprint:new X509Certificate(connection.certificatePEM).fingerprint256}));
  `),
  ) as { deviceId: string; service: string; url: string; fingerprint: string };
  if (!setup.deviceId || !/^dev\.omnesis\.fixture\.[a-f0-9]{64}$/u.test(setup.service))
    throw new Error("The real headless collector setup was not confirmed");
  // A fresh ordinary-headless environment excludes inherited desktop capabilities and credentials.
  const owner = spawnOwnedChildProcess(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      join(home, "parent-lifetime.mjs"),
      fileURLToPath(new URL("../../../cli/src/index.ts", import.meta.url)),
      "collector",
      "run",
    ],
    {
      env: {
        HOME: home,
        USERPROFILE: home,
        PATH: source.environment.PATH,
        LANG: "C.UTF-8",
        OMNESIS_CONFIG_DIR: configDir,
        OMNESIS_SECRET_STORE: "macos-keychain",
        OMNESIS_SECRET_SERVICE: setup.service,
        OMNESIS_GATEWAY_URL: setup.url,
        OMNESIS_CLOUD_RELAY_URL: source.relayUrl,
        OMNESIS_ACME_DIRECTORY_URL: source.relayUrl + "/directory",
        OMNESIS_TRUST_FINGERPRINT: setup.fingerprint,
        NODE_EXTRA_CA_CERTS: join(source.profile.configDir, "tls", "cert.pem"),
      },
    },
  );
  let exit: number | null = null;
  let classification = "none";
  owner.child.once("exit", (code) => {
    exit = code;
  });
  let syncLogSeen = false;
  const observe = (block: Buffer) => {
    const text = block.toString("utf8");
    if (text.includes("TLS trust failed")) classification = "tls-refused";
    else if (text.includes("No auth token")) classification = "credential-missing";
    else if (text.includes("needs-pairing")) classification = "pairing-required";
    else if (
      text.includes("Failed to set up provider maildir:") ||
      text.includes("Skipping maildir:")
    )
      classification = "source-setup-refused";
    else if (text.includes("refusing to sync")) classification = "state-contract-refused";
    if (text.includes("Sync complete for maildir:")) syncLogSeen = true;
  };
  owner.child.stdout?.on("data", observe);
  owner.child.stderr?.on("data", observe);
  try {
    await owner.ready;
    await waitForCondition(
      async () => {
        if (owner.joinedConfirmed)
          throw new Error(`The fixture headless reader exited: ${classification}`);
        const devices = (await source.request("/admin/devices")) as {
          items: Array<{ id: string; online: boolean }>;
        };
        return devices.items.some(
          (device) => device.id === setup.deviceId && device.online === true,
        );
      },
      20_000,
      "the separately paired headless collector authenticates its actual WebSocket",
    );
    const resolved = (await source.request("/admin/sources/resolve-account", {
      method: "POST",
      body: {
        deviceId: setup.deviceId,
        descriptorId: "maildir",
        params: { path },
      },
    })) as { accountId: string };
    if (typeof resolved.accountId !== "string" || !resolved.accountId)
      throw new Error("The real headless account resolution failed");
    const added = (await source.request("/admin/sources/add", {
      method: "POST",
      body: {
        deviceId: setup.deviceId,
        descriptorId: "maildir",
        params: { path },
        accountIds: [resolved.accountId],
      },
    })) as { sourceIds: unknown };
    const id = `maildir:${resolved.accountId}`;
    if (
      !Array.isArray(added.sourceIds) ||
      added.sourceIds.length !== 1 ||
      added.sourceIds[0] !== id
    )
      throw new Error("The real collector did not acknowledge the exact requested source ID");
    const evidence = {
      rowFound: false,
      enabled: false,
      rowHadSync: false,
      statusIdMatched: false,
      statusHadSync: false,
      state: "unknown",
      hasError: false,
      denied: false,
    };
    let completed = false;
    try {
      await waitForCondition(
        async () => {
          if (owner.joinedConfirmed)
            throw new Error(`The fixture headless reader exited: ${classification}`);
          const configured = (await source.request("/admin/sources")) as {
            items: Array<{ id: string; enabled: boolean; lastSyncedAt: string | null }>;
          };
          const row = configured.items.find((candidate) => candidate.id === id);
          evidence.rowFound = row !== undefined;
          evidence.enabled = row?.enabled === true;
          evidence.rowHadSync =
            typeof row?.lastSyncedAt === "string" && row.lastSyncedAt.length > 0;
          if (!row) return false;
          // Query even before a success timestamp: otherwise setup/read failures are hidden by the wait.
          const status = (await source.request(`/admin/sync/status/${encodeURIComponent(id)}`)) as {
            sourceId: string;
            state: string;
            lastSyncAt: string | null;
            errorMessage?: string;
            remediation?: { access?: { status?: string } };
          };
          evidence.statusIdMatched = status.sourceId === id;
          evidence.statusHadSync =
            typeof status.lastSyncAt === "string" && status.lastSyncAt.length > 0;
          evidence.state = [
            "idle",
            "synced",
            "syncing",
            "error",
            "paused",
            "needs-auth",
            "rate-limited",
            "permission-degraded",
            "background-access-missing",
            "unavailable",
            "auth-expiring",
            "stale",
          ].includes(status.state)
            ? status.state
            : "unknown";
          evidence.hasError = Boolean(status.errorMessage);
          evidence.denied = status.remediation?.access?.status === "denied";
          if (evidence.hasError || evidence.denied || !evidence.statusIdMatched)
            throw new Error("The real headless fixture source reported a scoped sync failure");
          // The public projection calls a completed successful sync 'synced'; 'idle' means never synced.
          return (
            evidence.enabled &&
            evidence.rowHadSync &&
            evidence.statusHadSync &&
            status.state === "synced"
          );
        },
        20_000,
        "the exact enabled headless Maildir source completes actual synchronization",
      );
      completed = true;
    } catch {
      // Raw collector/provider messages can contain private paths or SQL: report only bounded facts.
    }
    if (!completed)
      throw new Error(
        `Headless source completion refused: ${JSON.stringify({ ...evidence, classification, syncLogSeen })}`,
      );
    await owner.stop();
    if (!owner.joinedConfirmed || exit !== 0)
      throw new Error("The headless reader did not drain and join cleanly");
    return id;
  } finally {
    if (!owner.joinedConfirmed) await owner.stop();
  }
}

/** Generated credentials belong only to the isolated fixture; never print them in test diagnostics. */
export async function prepareRestoreProof(source: DesktopRuntimeFixture): Promise<string> {
  const path = join(source.root, "restore-proof.json");
  await source.script(`
    const {writeFile}=await import('node:fs/promises');
    const {readTokenFile}=await import('@omnesis/core');
    const {DesktopRecoveryService}=await import(${JSON.stringify(moduleUrl("recovery"))});
    const recovery=new DesktopRecoveryService(profile);
    const signal=new AbortController().signal;
    const draft=await recovery.prepare({signal});
    await recovery.commit(draft.draftId,signal);
    await writeFile(${JSON.stringify(path)},JSON.stringify({code:draft.recoveryCode,token:readTokenFile(profile.configDir)}),{mode:0o600,flag:'wx'});
  `);
  return path;
}

/** Stream the actual authenticated backup endpoint; preserve its encrypted entry bytes. */
export async function downloadRestoreArchive(
  source: DesktopRuntimeFixture,
  id: string,
): Promise<string> {
  const path = join(source.root, "completed-backup.tar");
  await source.script(`
    const {request}=await import('node:https');
    const {createWriteStream}=await import('node:fs');
    const {pipeline}=await import('node:stream/promises');
    const {readDesktopConnection}=await import(${JSON.stringify(moduleUrl("gateway-access"))});
    const connection=await readDesktopConnection(profile);
    await new Promise((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',servername:'localhost',port:new URL(connection.url).port,path:'/admin/artifacts/'+${JSON.stringify(id)}+'/download',
        ca:connection.certificatePEM,rejectUnauthorized:true,headers:{authorization:'Bearer '+connection.token},signal:AbortSignal.timeout(60000)
      },response=>{
        if(response.statusCode!==200){response.resume();reject(new Error('The owned backup download was refused'));return;}
        let bytes=0;
        response.on('data',block=>{bytes+=block.length;if(bytes>128*1024**2)req.destroy(new Error('The fixture backup exceeds its bound'));});
        pipeline(response,createWriteStream(${JSON.stringify(path)},{mode:0o600,flags:'wx'})).then(resolve,reject);
      });req.on('error',reject);req.end();
    });
  `);
  return path;
}

/** The explicit source OS seam replaces only native EX authorization, never crypto/stores/HTTP. */
export async function applyRestoreArchive(
  target: DesktopRuntimeFixture,
  archivePath: string,
  proofPath: string,
  options: { tampered?: boolean } = {},
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await target.script(`
    const {readFile,stat}=await import('node:fs/promises');
    const {DesktopBackupRestoreService}=await import(${JSON.stringify(moduleUrl("restore-service"))});
    const {runDesktopRestoreOperation}=await import(${JSON.stringify(moduleUrl("restore-operation"))});
    const {restoreUnderDesktopDataAuthority}=await import(${JSON.stringify(moduleUrl("data-operation-restore"))});
    const {readDesktopRestoreIntent}=await import(${JSON.stringify(moduleUrl("restore-intent"))});
    const {DesktopRestoreEntries}=await import(${JSON.stringify(moduleUrl("restore-entries"))});
    const {DesktopRestoreStoreKeys}=await import(${JSON.stringify(moduleUrl("restore-store-keys"))});
    // Diagnostic wrappers observe actual calls; they never replace data, crypto or outcomes.
    let previewStage='unpack-protection';
    for(const [name,stage] of [['unlock','unlock'],['inspectMain','main'],['prepareConversation','history']]) {
      const original=DesktopRestoreEntries.prototype[name];
      DesktopRestoreEntries.prototype[name]=function(...args){previewStage=stage;return original.apply(this,args);};
    }
    const prepareAuxiliary=DesktopRestoreEntries.prototype.prepareAuxiliary;
    DesktopRestoreEntries.prototype.prepareAuxiliary=function(...args){
      const kind=args[1]?.kind;
      previewStage=kind==='analytics'?'auxiliary-analytics':kind==='watch'?'auxiliary-watch':'auxiliary-unknown';
      return prepareAuxiliary.apply(this,args);
    };
    const prepareKeys=DesktopRestoreStoreKeys.prepare;
    DesktopRestoreStoreKeys.prepare=function(...args){previewStage='storage-keys';return prepareKeys.apply(this,args);};
    const signal=new AbortController().signal;
    const service=new DesktopBackupRestoreService(profile,{
      apply:(actual,input,active)=>runDesktopRestoreOperation(actual,input,active,{
        execute:async(request,operationSignal)=>restoreUnderDesktopDataAuthority(request,operationSignal,{
          authorize:(scope,purpose,id)=>{
            if(scope.configDir!==profile.configDir||scope.instance!==profile.instance||scope.secretService!==profile.secretService||purpose!=='restore'||id!==request.operationId)
              throw new Error('The fixture restore OS authority changed');
          },
        }),
      }),
      recover:async()=>{throw new Error('Unexpected fixture recovery');},
    });
    try {
      const slot=await service.prepare(signal);
      const metadata=await stat(${JSON.stringify(archivePath)},{bigint:true});
      await service.ingest(slot.importId,{
        path:${JSON.stringify(archivePath)},device:String(metadata.dev),inode:String(metadata.ino),bytes:Number(metadata.size),
        mtimeSeconds:String(metadata.mtimeNs/1000000000n),mtimeNanoseconds:String(metadata.mtimeNs%1000000000n)
      },signal);
      const proof=JSON.parse(await readFile(${JSON.stringify(proofPath)},'utf8'));
      let preview;
      try {preview=await service.preview(slot.importId,{recoveryCode:proof.code},signal);}
      catch(error) {
        const known=new Map([
          ['The backup storage keys could not be reconciled with this Mac','keys-refused'],
          ['The backup database could not be prepared safely','worker-refused'],
          ['The backup database process could not be started safely','worker-start-refused'],
          ['The backup could not be verified with this recovery file','authentication-refused'],
          ['The recovery code does not open this backup','recovery-code-refused'],
          ['Choose the recovery file that belongs to this backup','recovery-file-missing'],
          ['The backup manifests disagree','manifest-mismatch'],
          ['This backup contains an uncheckpointed database sidecar; create a completed online backup before restoring it','sidecar-refused'],
        ]);
        const failureCodes=new Set(['unknown','input-schema','worker-load-or-exit','process-exit','invalid-reply','invalid-result',
          'missing-key','page-authentication','truncated-pages','private-input','unsupported-table','generated-column',
          'unreviewed-table','incomplete-schema','integrity','schema-version','entry-scope','envelope-truncated',
          'sqlite-notadb','sqlite-corrupt','sqlite-error','sqlite-nomem','sqlite-cantopen','sqlite-readonly','sqlite-busy','sqlite-full']);
        const internalReason=error instanceof Error&&'failureCode' in error&&failureCodes.has(error.failureCode)?error.failureCode:null;
        const classification=internalReason??(error instanceof Error?known.get(error.message)??'unclassified':'unclassified');
        if(!${JSON.stringify(options.tampered === true)})throw new Error('The real backup preview was refused: last-boundary='+previewStage+'/'+classification);
        if(await readDesktopRestoreIntent(profile))throw new Error('Tampered preview created a destructive intent');
        process.stdout.write(JSON.stringify({tamperRefused:true}));preview=null;
      }
      if(preview&&${JSON.stringify(options.tampered === true)})throw new Error('Tampered ciphertext was accepted');
      if(preview){
      if(preview.status!=='ready')throw new Error('The original backup was not ready');
      const result=await service.apply(preview.confirmationId,signal);
      const intent=await readDesktopRestoreIntent(profile);
      if(intent?.phase!=='committed')throw new Error('The actual restore did not retain its verification fence');
      process.stdout.write(JSON.stringify({...result,phase:intent.phase}));
      }
    }finally{await service.close();}
  `),
  );
}

/** Repack a syntactically valid TAR with one authenticated database payload byte changed. */
export async function tamperRestoreArchive(
  source: DesktopRuntimeFixture,
  original: string,
): Promise<string> {
  const path = join(source.root, "tampered-backup.tar");
  await source.script(`
    const {createReadStream,createWriteStream}=await import('node:fs');
    const {pipeline}=await import('node:stream/promises');
    const {extract,pack}=await import('tar-stream');
    const input=extract(),output=pack();let changed=false;
    input.on('entry',(header,stream,next)=>{
      (async()=>{
        const blocks=[];let length=0;
        for await(const block of stream){length+=block.length;if(length>64*1024**2)throw new Error('Fixture entry too large');blocks.push(block);}
        const bytes=Buffer.concat(blocks);
        if(header.name.endsWith('/omnesis.db.enc')){if(bytes.length<32)throw new Error('Missing encrypted database');bytes[bytes.length-1]^=1;changed=true;}
        await new Promise((resolve,reject)=>output.entry(header,bytes,error=>error?reject(error):resolve()));next();
      })().catch(error=>{input.destroy(error);output.destroy(error);});
    });
    input.on('finish',()=>output.finalize());
    await Promise.all([pipeline(createReadStream(${JSON.stringify(original)}),input),pipeline(output,createWriteStream(${JSON.stringify(path)},{flags:'wx',mode:0o600}))]);
    if(!changed)throw new Error('The real backup did not contain encrypted database payload');
  `);
  return path;
}

export async function proofAuthority(target: DesktopRuntimeFixture, proofPath: string) {
  return JSON.parse(
    await target.script(`
    const {request}=await import('node:https');const {readFile}=await import('node:fs/promises');
    const {readDesktopConnection}=await import(${JSON.stringify(moduleUrl("gateway-access"))});
    const connection=await readDesktopConnection(profile),proof=JSON.parse(await readFile(${JSON.stringify(proofPath)},'utf8'));
    if(typeof proof.token!=='string'||proof.token.trim().length===0)throw new Error('The fixture proof has no usable source credential');
    const status=await new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',servername:'localhost',port:new URL(connection.url).port,path:'/whoami',ca:connection.certificatePEM,rejectUnauthorized:true,headers:{authorization:'Bearer '+proof.token},signal:AbortSignal.timeout(10000)},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
    process.stdout.write(JSON.stringify({status}));
  `),
  );
}
