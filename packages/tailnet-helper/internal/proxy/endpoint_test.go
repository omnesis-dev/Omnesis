// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package proxy

import (
    "context"
    "crypto/sha256"
    "crypto/tls"
    "encoding/hex"
    "io"
    "log"
    "net"
    "net/http"
    "net/http/httptest"
    "os"
    "path/filepath"
    "strings"
    "sync/atomic"
    "testing"
    "time"
)

func TestEndpointValidation(t *testing.T) {
    pin := strings.Repeat("a", 64)
    token := strings.Repeat("b", 64)
    for _, tc := range []struct { name string; endpoint Endpoint; valid bool }{
        {"unix permissions", Endpoint{Path: "/private/gateway.sock"}, true},
        {"missing path", Endpoint{}, false},
        {"plain pipe", Endpoint{Path: `\\.\pipe\invented`}, false},
        {"pin without token", Endpoint{Path: `\\.\pipe\invented`, CertificateSHA256: pin}, false},
        {"token without pin", Endpoint{Path: `\\.\pipe\invented`, Token: token}, false},
        {"invalid pin", Endpoint{Path: `\\.\pipe\invented`, CertificateSHA256: "not-hex", Token: token}, false},
        {"short token", Endpoint{Path: `\\.\pipe\invented`, CertificateSHA256: pin, Token: "aa"}, false},
        {"secure pipe", Endpoint{Path: `\\.\pipe\invented`, CertificateSHA256: pin, Token: token}, true},
    } {
        t.Run(tc.name, func(t *testing.T) {
            err := tc.endpoint.Validate()
            if (err == nil) != tc.valid { t.Fatalf("valid=%v, error=%v", tc.valid, err) }
        })
    }
}

func TestPinnedTransportReplacesSpoofedTokenAndDoesNotLeakItToWrongServer(t *testing.T) {
    // Go supports AF_UNIX on Windows as well; the cross-language lane separately
    // proves native Windows pipe dialing against the actual Node listener.
    dir, err := os.MkdirTemp("", "tnh-secure-")
    if err != nil { t.Fatal(err) }
    t.Cleanup(func() { os.RemoveAll(dir) })
    path := filepath.Join(dir, "gw.sock")
    ln, err := net.Listen("unix", path)
    if err != nil { t.Fatal(err) }
    certificateServer := httptest.NewTLSServer(http.NotFoundHandler())
    certificate := certificateServer.TLS.Certificates[0]
    certificateServer.Close()
    fingerprint := sha256.Sum256(certificate.Certificate[0])
    token := strings.Repeat("b", 64)
    var requests atomic.Int32
    seen := make(chan string, 1)
    server := &http.Server{
        Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            requests.Add(1)
            seen <- r.Header.Get(TransportHeader)
            io.WriteString(w, "real local TLS response")
        }),
        ErrorLog: log.New(io.Discard, "", 0),
    }
    done := make(chan error, 1)
    go func() { done <- server.Serve(tls.NewListener(ln, &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12})) }()
    t.Cleanup(func() { server.Close(); <-done })
    endpoint := Endpoint{Path: path, CertificateSHA256: hex.EncodeToString(fingerprint[:]), Token: token}
    handler := NewEndpoint(endpoint, fakeResolver{}, func(string, ...any) {}).Tailnet()
    request := httptest.NewRequest("GET", "http://omnesis/x", nil)
    request.Header.Set(TransportHeader, "spoofed")
    response := httptest.NewRecorder()
    handler.ServeHTTP(response, request)
    if response.Code != 200 || response.Body.String() != "real local TLS response" { t.Fatalf("response=%d %q", response.Code, response.Body.String()) }
    if actual := <-seen; actual != token { t.Fatal("the proxy did not replace the inbound transport credential") }
    endpoint.CertificateSHA256 = strings.Repeat("0", 64)
    bad := NewEndpoint(endpoint, fakeResolver{}, func(string, ...any) {}).Tailnet()
    response = httptest.NewRecorder()
    bad.ServeHTTP(response, httptest.NewRequest("GET", "http://omnesis/x", nil))
    if response.Code != 502 { t.Fatalf("wrong-pin response=%d", response.Code) }
    if requests.Load() != 1 { t.Fatal("a wrong server received an authenticated request") }
    ctx, cancel := context.WithTimeout(context.Background(), time.Second)
    defer cancel()
    if conn, err := endpoint.dial(ctx, false); err == nil { conn.Close(); t.Fatal("a pinned endpoint admitted plaintext") }
}
