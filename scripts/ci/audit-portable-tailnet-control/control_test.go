// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package portablecontrol

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"tailscale.com/envknob"
	"tailscale.com/ipn/store/mem"
	"tailscale.com/logtail"
	"tailscale.com/net/netns"
	"tailscale.com/tailcfg"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration"
	"tailscale.com/tstest/integration/testcontrol"
)

// This diagnostic proves a real local control plane and encrypted userspace
// network on Windows, without a Linux-only coordinator binary or host VPN.
func TestPortableControlAndWireGuard(t *testing.T) {
	envknob.SetNoLogsNoSupport()
	logtail.Disable()
	netns.SetEnabled(false)
	defer netns.SetEnabled(true)
	discard := func(string, ...any) {}
	control := &testcontrol.Server{
		DERPMap: integration.RunDERPAndSTUN(t, discard, "127.0.0.1"),
		DNSConfig: &tailcfg.DNSConfig{Proxied: true},
		MagicDNSDomain: "fixture.example.test",
		AllNodesSameUser: true,
		Logf: discard,
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	start := func(name string) (*tsnet.Server, string) {
		s := &tsnet.Server{Dir: t.TempDir(), ControlURL: control.HTTPTestServer.URL, Hostname: name, Store: new(mem.Store), Ephemeral: true, Logf: discard, UserLogf: discard}
		t.Cleanup(func() { if err := s.Close(); err != nil { t.Errorf("node close: %v", err) } })
		status, err := s.Up(ctx)
		if err != nil { t.Fatalf("node startup: %v", err) }
		if len(status.TailscaleIPs) == 0 { t.Fatal("node has no address") }
		return s, status.TailscaleIPs[0].String()
	}
	gateway, address := start("fixture-gateway")
	peer, _ := start("fixture-peer")
	listener, err := gateway.Listen("tcp", ":8080")
	if err != nil { t.Fatal(err) }
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "invented encrypted network response") })}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	t.Cleanup(func() { server.Close(); <-done })
	request, err := http.NewRequestWithContext(ctx, "GET", "http://"+address+":8080/", nil)
	if err != nil { t.Fatal(err) }
	response, err := peer.HTTPClient().Do(request)
	if err != nil { t.Fatalf("userspace network request: %v", err) }
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1024))
	if err != nil { t.Fatal(err) }
	if response.StatusCode != 200 || string(body) != "invented encrypted network response" { t.Fatalf("unexpected network response: %d", response.StatusCode) }
	if control.NumNodes() != 2 { t.Fatalf("expected two real registered peers, got %d", control.NumNodes()) }
}
