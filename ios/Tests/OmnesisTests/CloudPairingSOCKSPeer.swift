// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

#if os(macOS)
import Foundation

@MainActor
final class CloudPairingSOCKSPeer {
    struct Info: Decodable {
        let plainPort: Int
        let proxyPort: Int
        let targetPort: Int
        let secondTargetPort: Int
        let resetPort: Int
        let statsPath: String
        let spkiFingerprint: String
        let fingerprint: String
        let certificateDER: String
    }

    let info: Info
    private let process: Process
    private let input = Pipe()

    init(ignoreFirstHello: Bool = false, ignoreFirstPongs: Bool = false, refuseDirectDiscovery: Bool = false) throws {
        process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
            "python3",
            "-u",
            "-c",
            Self.server,
            ignoreFirstHello ? "1" : "0",
            ignoreFirstPongs ? "1" : "0",
            refuseDirectDiscovery ? "1" : "0",
        ]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        var line = Data()
        while let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty, byte != Data([10]) {
            line.append(byte)
        }
        do { info = try JSONDecoder().decode(Info.self, from: line) } catch {
            if process.isRunning { process.terminate() }
            process.waitUntilExit()
            throw error
        }
    }

    func stop() {
        if process.isRunning { process.terminate() }
        process.waitUntilExit()
    }

    private static let server = #"""
    import base64, hashlib, json, os, select, signal, socket, ssl, struct, subprocess, sys, tempfile, threading
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    def watch_parent():
        while sys.stdin.buffer.read(1): pass
        os.kill(os.getpid(), signal.SIGTERM)
    threading.Thread(target=watch_parent,daemon=True).start()
    def exact(conn, size):
        data = b''
        while len(data) < size:
            chunk = conn.recv(size - len(data))
            if not chunk: raise EOFError()
            data += chunk
        return data
    def ws_send(conn, value):
        data = json.dumps(value).encode()
        prefix = bytes([0x81,len(data)]) if len(data) < 126 else bytes([0x81,126])+struct.pack('!H',len(data))
        conn.sendall(prefix+data)
    def control_socket(conn):
        with stats_lock:
            stats['controlConnections'] += 1
            connection_number = stats['controlConnections']
        conn.settimeout(45)
        authenticated = False
        while True:
            first, second = exact(conn,2)
            length = second & 127
            if length == 126: length = struct.unpack('!H',exact(conn,2))[0]
            elif length == 127: length = struct.unpack('!Q',exact(conn,8))[0]
            if length > 65536 or not second & 128: raise ValueError('Invalid control frame')
            mask = exact(conn,4)
            payload = bytes(byte ^ mask[index % 4] for index,byte in enumerate(exact(conn,length)))
            opcode = first & 15
            if opcode == 8:
                conn.sendall(b'\x88\x00')
                return
            if opcode == 9:
                with stats_lock:
                    stats['pings'] += 1
                    with open(stats_path+'.tmp','w') as out: json.dump(stats,out)
                    os.replace(stats_path+'.tmp',stats_path)
                if sys.argv[2] == '1' and connection_number == 1: continue
                conn.sendall(bytes([0x8a,len(payload)])+payload)
                continue
            if opcode != 1: continue
            frame = json.loads(payload)
            if not authenticated:
                if frame.get('kind') != 'command' or frame.get('type') != 'hello': raise ValueError('Expected hello')
                if frame.get('payload',{}).get('protocolVersion') != 1: raise ValueError('Wrong protocol')
                if sys.argv[1] == '1' and connection_number == 1: continue
                ws_send(conn, {'kind':'response','correlationId':frame['id'],'ok':True,'result':{
                    'deviceId':'00000000-0000-4000-8000-000000000901','deviceName':'Synthetic production pairing',
                    'scopes':['read','admin'],'protocolVersion':1}})
                authenticated = True
                key = 'hellos'
            elif frame.get('kind') == 'event' and frame.get('type') == 'connection.path':
                key = {'local':'pathLocal','relay':'pathRelay'}.get(frame.get('payload',{}).get('path'))
                if key is None: raise ValueError('Invalid path telemetry')
            else: continue
            with stats_lock:
                stats[key] += 1
                with open(stats_path+'.tmp','w') as out: json.dump(stats,out)
                os.replace(stats_path+'.tmp',stats_path)
    def handle_target(raw, context):
        try:
            with context.wrap_socket(raw, server_side=True) as conn:
                conn.settimeout(8)
                request = b''
                while b'\r\n\r\n' not in request:
                    if len(request) > 16384: raise ValueError('Headers too large')
                    request += exact(conn, 1)
                headers = {k.lower():v.strip() for k,v in
                    (line.split(':',1) for line in request.decode().split('\r\n')[1:] if ':' in line)}
                with stats_lock:
                    stats['requests'] += 1
                    with open(stats_path+'.tmp','w') as out: json.dump(stats,out)
                    os.replace(stats_path+'.tmp',stats_path)
                path = request.split(b'\r\n',1)[0].split()[1].decode()
                length = int(headers.get('content-length','0'))
                if length > 65536: raise ValueError('Body too large')
                body = exact(conn,length) if length else b''
                result = json.dumps({'sni':conn.canonical_sni, 'host':headers.get('host',''),
                    'authorization':headers.get('authorization',''), 'proxyAuthentication':'verified'}).encode()
                if path == '/devices/pair':
                    json.loads(body)
                    result = json.dumps({'device':{'id':'00000000-0000-4000-8000-000000000901',
                        'name':'Synthetic production pairing','kind':'ios'},
                        'tokenId':'00000000-0000-4000-8000-000000000902',
                        'token':'device-test-token','scopes':['read','admin']}).encode()
                elif path == '/devices/direct-candidates':
                    if sys.argv[3] == '1' or headers.get('authorization') != 'Bearer device-test-token':
                        conn.sendall(b'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                        return
                    result = b'{"version":1,"candidates":[]}'
                elif path == '/admin/tokens':
                    minted = json.loads(body)
                    if headers.get('authorization') != 'Bearer device-test-token' or minted.get('scopes') != ['push:claim']:
                        conn.sendall(b'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                        return
                    result = json.dumps({'deviceId':minted['deviceId'],'scopes':['push:claim'],'token':'claim-test-token'}).encode()
                elif path in ['/notifications/claim','/notifications/confirm']:
                    if headers.get('authorization') != 'Bearer claim-test-token':
                        conn.sendall(b'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                        return
                    if path == '/notifications/claim':
                        conn.sendall(b'HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                        return
                    result = b'{}'
                elif path.startswith('/tasks'):
                    if headers.get('authorization') != 'Bearer widget-test-token':
                        conn.sendall(b'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                        return
                    result = b'{"tasks":[]}' if path.startswith('/tasks?') else b'{}'
                if headers.get('upgrade','').lower() == 'websocket':
                    if path == '/device/ws' and headers.get('authorization') != 'Bearer device-test-token':
                        conn.sendall(b'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                        return
                    accept = base64.b64encode(hashlib.sha1((headers['sec-websocket-key'] +
                        '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
                    conn.sendall(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                        'Sec-WebSocket-Accept: '+accept+'\r\n\r\n').encode())
                    if path == '/device/ws': control_socket(conn)
                    else:
                        prefix = bytes([0x81,len(result)]) if len(result) < 126 else bytes([0x81,126])+struct.pack('!H',len(result))
                        conn.sendall(prefix+result)
                        conn.recv(1024)
                else:
                    conn.sendall(('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: '+
                        str(len(result))+'\r\nConnection: close\r\n\r\n').encode()+result)
        except Exception: raw.close()
    def handle_proxy(conn, target_port):
        try:
            with conn:
                conn.settimeout(8)
                version, count = exact(conn,2)
                methods = exact(conn,count)
                if version != 5 or 2 not in methods: raise ValueError('Authentication required')
                conn.sendall(b'\x05\x02')
                version, count = exact(conn,2)
                user = exact(conn,count)
                password = exact(conn,exact(conn,1)[0])
                if version != 1 or user != b'fixture-proxy' or password != b'fixture-password':
                    conn.sendall(b'\x01\x01')
                    return
                conn.sendall(b'\x01\x00')
                version, command, reserved, kind = exact(conn,4)
                if (version,command,reserved,kind) != (5,1,0,3): raise ValueError('Expected canonical domain')
                hostname = exact(conn,exact(conn,1)[0])
                port = struct.unpack('!H',exact(conn,2))[0]
                if hostname != b'gateway.example.test' or port != 443: raise ValueError('Wrong target')
                with socket.create_connection(('127.0.0.1',target_port),timeout=5) as upstream:
                    conn.sendall(b'\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00')
                    total = 0
                    while total < 524288:
                        readers, _, _ = select.select([conn,upstream],[],[],8)
                        if not readers: return
                        for source in readers:
                            data = source.recv(16384)
                            if not data: return
                            total += len(data)
                            (upstream if source is conn else conn).sendall(data)
        except Exception: conn.close()
    stats_lock = threading.Lock()
    stats = {'controlConnections':0,'pings':0,'plainTLS':0,'plaintext':0,'primary':0,'secondary':0,
        'requests':0,'hellos':0,'pathLocal':0,'pathRelay':0}
    def accept_plain(listener):
        while True:
            conn, _ = listener.accept()
            with conn:
                conn.settimeout(1)
                try:
                    incoming = conn.recv(16384)
                    if not incoming: continue
                    with stats_lock:
                        # A rejected WSS handshake may reach this owned socket,
                        # but no HTTP request or credential may precede trust.
                        key = 'plainTLS' if incoming[0] == 22 else 'plaintext'
                        stats[key] += 1
                        with open(stats_path+'.tmp','w') as out: json.dump(stats,out)
                        os.replace(stats_path+'.tmp',stats_path)
                    conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
                except Exception: pass
    def accept_targets(listener, context, kind, stats_path):
        while True:
            conn, _ = listener.accept()
            with stats_lock:
                stats[kind] += 1
                with open(stats_path+'.tmp','w') as out: json.dump(stats,out)
                os.replace(stats_path+'.tmp',stats_path)
            threading.Thread(target=handle_target,args=(conn,context),daemon=True).start()
    def reset_connections(listener):
        while True:
            conn, _ = listener.accept()
            conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack('ii',1,0))
            conn.close()
    with tempfile.TemporaryDirectory(prefix='omnesis-socks-fixture-') as directory:
        key, cert, config = [os.path.join(directory,name) for name in ['key.pem','cert.pem','openssl.cnf']]
        with open(config,'w') as out:
            out.write('[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ext\n[dn]\nCN=gateway.example.test\n'
                '[ext]\nsubjectAltName=DNS:gateway.example.test,DNS:localhost,IP:127.0.0.1\n'
                'basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n')
        subprocess.run(['openssl','req','-new','-x509','-newkey','rsa:2048','-nodes','-days','1',
            '-keyout',key,'-out',cert,'-config',config],check=True,timeout=8,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert,key)
        context.set_servername_callback(lambda conn,name,_: setattr(conn,'canonical_sni',name))
        stats_path = os.path.join(directory,'stats.json')
        with open(stats_path,'w') as out: json.dump(stats,out)
        with socket.socket() as target, socket.socket() as secondary, socket.socket() as proxy, \
            socket.socket() as reset, socket.socket() as plain:
            target.bind(('127.0.0.1',0)); target.listen(8)
            secondary.bind(('127.0.0.1',0)); secondary.listen(8)
            proxy.bind(('127.0.0.1',0)); proxy.listen(8)
            plain.bind(('127.0.0.1',0)); plain.listen(8)
            threading.Thread(target=accept_plain,args=(plain,),daemon=True).start()
            reset.bind(('127.0.0.1',0)); reset.listen(8)
            threading.Thread(target=reset_connections,args=(reset,),daemon=True).start()
            threading.Thread(target=accept_targets,args=(target,context,'primary',stats_path),daemon=True).start()
            threading.Thread(target=accept_targets,args=(secondary,context,'secondary',stats_path),daemon=True).start()
            with open(cert) as source: der=ssl.PEM_cert_to_DER_cert(source.read())
            public_key = subprocess.run(['openssl','x509','-in',cert,'-pubkey','-noout'],
                check=True,capture_output=True,timeout=5).stdout
            spki = subprocess.run(['openssl','pkey','-pubin','-outform','DER'],input=public_key,
                check=True,capture_output=True,timeout=5).stdout
            print(json.dumps({'plainPort':plain.getsockname()[1],'proxyPort':proxy.getsockname()[1],'targetPort':target.getsockname()[1],
                'secondTargetPort':secondary.getsockname()[1],'resetPort':reset.getsockname()[1],
                'statsPath':stats_path,'spkiFingerprint':hashlib.sha256(spki).hexdigest(),
                'fingerprint':hashlib.sha256(der).hexdigest(),'certificateDER':base64.b64encode(der).decode()}),flush=True)
            while True:
                conn, _ = proxy.accept()
                threading.Thread(target=handle_proxy,args=(conn,target.getsockname()[1]),daemon=True).start()
    """#
}
#endif
