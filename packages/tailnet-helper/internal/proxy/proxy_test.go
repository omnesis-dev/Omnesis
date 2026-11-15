// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package proxy

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/identity"
)

type fakeResolver struct {
	peer *identity.Peer
	err  error
}

func (f fakeResolver) Resolve(context.Context, string) (*identity.Peer, error) { return f.peer, f.err }

// upstream starts an HTTP server on a Unix socket that echoes what it saw.
func upstream(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "tnh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "gw.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/sse", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for i := 0; i < 3; i++ {
			fmt.Fprintf(w, "data: %d\n\n", i)
			w.(http.Flusher).Flush()
			time.Sleep(20 * time.Millisecond)
		}
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Upgrade") == "websocket" {
			conn, buf, _ := w.(http.Hijacker).Hijack()
			buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
			buf.Flush()
			io.Copy(conn, conn)
			return
		}
		seen := map[string]any{
			"path":     r.URL.Path,
			"host":     r.Host,
			"identity": r.Header.Get(identity.Header),
			"owned":    countOwned(r.Header),
			"xff":      r.Header.Get("X-Forwarded-For"),
			"auth":     r.Header.Get("Authorization"),
		}
		json.NewEncoder(w).Encode(seen)
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return sock
}

func countOwned(h http.Header) int {
	n := 0
	for k := range h {
		if strings.HasPrefix(strings.ToLower(k), identity.HeaderPrefix) {
			n++
		}
	}
	return n
}

func get(t *testing.T, h http.Handler, method, target string, hdr map[string]string, ctx context.Context) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	if ctx != nil {
		req = req.WithContext(ctx)
	}
	req.RemoteAddr = "100.64.0.9:5555"
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var body map[string]any
	json.Unmarshal(rec.Body.Bytes(), &body)
	return rec, body
}

func TestTailnetForwardsIdentityAndReplacesForgedHeaders(t *testing.T) {
	sock := upstream(t)
	peer := &identity.Peer{NodeID: "n1", NodeName: "maya-laptop", UserID: "7", Login: "maya@example.com", SameOwner: true}
	p := New(sock, fakeResolver{peer: peer}, t.Logf)
	_, body := get(t, p.Tailnet(), "GET", "https://omnesis.example-net.ts.net/api/x", map[string]string{
		"X-Omnesis-Tailnet":        identity.Encode(identity.Caller{Via: identity.ViaTailnet, Peer: &identity.Peer{SameOwner: true, UserID: "1"}}),
		"X-Omnesis-Tailnet-Forged": "x",
		"X-Forwarded-For":          "203.0.113.9",
		"Authorization":            "Bearer abc",
	}, nil)
	if body["path"] != "/api/x" || body["host"] != "omnesis.example-net.ts.net" {
		t.Fatalf("path/host not preserved: %v", body)
	}
	if body["owned"].(float64) != 1 {
		t.Fatalf("expected exactly the helper's own header, got %v", body["owned"])
	}
	if body["xff"] != "" {
		t.Fatalf("X-Forwarded-For must not reach the gateway: %v", body["xff"])
	}
	if body["auth"] != "Bearer abc" {
		t.Fatalf("Authorization must pass through: %v", body["auth"])
	}
	c, err := identity.Decode(body["identity"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if c.Via != identity.ViaTailnet || c.Client != "100.64.0.9:5555" || c.Peer == nil || c.Peer.UserID != "7" || c.Peer.Login != "maya@example.com" {
		t.Fatalf("unexpected caller: %+v", c)
	}
}

func TestTailnetUnidentifiedCallerStillForwardedWithoutPeer(t *testing.T) {
	sock := upstream(t)
	p := New(sock, fakeResolver{err: errors.New("no such peer")}, t.Logf)
	_, body := get(t, p.Tailnet(), "GET", "https://omnesis/x", nil, nil)
	c, err := identity.Decode(body["identity"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if c.Peer != nil || c.Via != identity.ViaTailnet {
		t.Fatalf("unidentified caller must have no peer: %+v", c)
	}
}

func TestPublicAllowlist(t *testing.T) {
	p := New("/nonexistent", fakeResolver{}, t.Logf)
	p.SetPublicPaths([]string{"/mcp", "/oauth/", "/.well-known/oauth-protected-resource", "/portal/vendor/"})
	cases := map[string]bool{
		"/mcp":                                  true,
		"/mcp/":                                 false,
		"/mcpx":                                 false,
		"/oauth/token":                          true,
		"/oauth/":                               true,
		"/oauth":                                false,
		"/oauth/../portal/":                     false,
		"/oauth/./token":                        false,
		"/oauth//token":                         false,
		"/oauth/%2e%2e/admin":                   false,
		"/oauth/x%2Fy":                          false,
		"/.well-known/oauth-protected-resource": true,
		"/.well-known/oauth-protected-resource/x": false,
		"/portal/vendor/preact.js":                true,
		"/portal/":                                false,
		"/admin/tailscale":                        false,
		"/":                                       false,
	}
	for target, want := range cases {
		req := httptest.NewRequest("GET", "https://omnesis"+target, nil)
		if got := p.PublicAllows(req); got != want {
			t.Errorf("PublicAllows(%q) = %v, want %v", target, got, want)
		}
	}
}

func TestPublicRefusesOutsideAllowlistWithoutReachingGateway(t *testing.T) {
	sock := upstream(t)
	p := New(sock, fakeResolver{}, t.Logf)
	p.SetPublicPaths([]string{"/mcp"})
	rec, _ := get(t, p.Public(deviceHost), "GET", "https://omnesis/portal/", nil, nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("got %d, want 404", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "identity") {
		t.Fatal("refused request reached the gateway")
	}
}

func TestPublicCarriesRelayedClientAndNoPeer(t *testing.T) {
	sock := upstream(t)
	p := New(sock, fakeResolver{peer: &identity.Peer{SameOwner: true}}, t.Logf)
	p.SetPublicPaths([]string{"/mcp"})
	ctx := WithClient(context.Background(), "198.51.100.4:61000")
	_, body := get(t, p.Public(deviceHost), "POST", "https://omnesis/mcp", map[string]string{"X-Omnesis-Tailnet": "forged"}, ctx)
	c, err := identity.Decode(body["identity"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if c.Via != identity.ViaPublic || c.Client != "198.51.100.4:61000" || c.Peer != nil {
		t.Fatalf("public caller must be relayed address with no peer: %+v", c)
	}
}

func deviceHost() string { return "omnesis.example.ts.net" }

func TestPublicForwardsAsTheDeviceWhateverHostTheCallerSent(t *testing.T) {
	sock := upstream(t)
	p := New(sock, fakeResolver{}, t.Logf)
	p.SetPublicPaths([]string{"/mcp"})
	_, body := get(t, p.Public(deviceHost), "POST", "https://localhost:7600/mcp", nil, nil)
	if body["host"] != "omnesis.example.ts.net" {
		t.Fatalf("public request forwarded as host %v", body["host"])
	}
}

func TestPublicRefusesBeforeTheDeviceHasAName(t *testing.T) {
	sock := upstream(t)
	p := New(sock, fakeResolver{}, t.Logf)
	p.SetPublicPaths([]string{"/mcp"})
	rec, _ := get(t, p.Public(func() string { return "" }), "POST", "https://omnesis/mcp", nil, nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("got %d, want 503", rec.Code)
	}
}

func TestUpstreamDownAnswers502(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), "missing.sock"), fakeResolver{}, t.Logf)
	rec, _ := get(t, p.Tailnet(), "GET", "https://omnesis/x", nil, nil)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("got %d, want 502", rec.Code)
	}
}

func TestUpgradeAndStreamingPassThrough(t *testing.T) {
	sock := upstream(t)
	p := New(sock, fakeResolver{}, t.Logf)
	front := httptest.NewServer(p.Tailnet())
	defer front.Close()

	resp, err := http.Get(front.URL + "/sse")
	if err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(resp.Body)
	first, _ := r.ReadString('\n')
	if first != "data: 0\n" {
		t.Fatalf("stream did not arrive incrementally: %q", first)
	}
	resp.Body.Close()

	conn, err := net.Dial("tcp", strings.TrimPrefix(front.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	fmt.Fprintf(conn, "GET /ws HTTP/1.1\r\nHost: omnesis\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
	br := bufio.NewReader(conn)
	status, _ := br.ReadString('\n')
	if !strings.Contains(status, "101") {
		t.Fatalf("upgrade not passed through: %q", status)
	}
	for {
		line, _ := br.ReadString('\n')
		if line == "\r\n" || line == "" {
			break
		}
	}
	conn.Write([]byte("ping"))
	buf := make([]byte, 4)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.ReadFull(br, buf); err != nil || string(buf) != "ping" {
		t.Fatalf("upgraded stream did not echo: %q %v", buf, err)
	}
}

func TestRedirectToHTTPS(t *testing.T) {
	h := RedirectToHTTPS(func() string { return "omnesis.example-net.ts.net" })
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "http://omnesis/portal/?a=1", nil))
	if rec.Code != http.StatusPermanentRedirect || rec.Header().Get("Location") != "https://omnesis.example-net.ts.net/portal/?a=1" {
		t.Fatalf("got %d %q", rec.Code, rec.Header().Get("Location"))
	}
}
