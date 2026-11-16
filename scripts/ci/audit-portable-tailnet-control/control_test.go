// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package portablecontrol

import (
	"context"
	"encoding/json"
	"net"
	"tailscale.com/types/key"
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
	t.Cleanup(func() { netns.SetEnabled(true) })
	discard := func(string, ...any) {}
	control := &testcontrol.Server{
		DERPMap: integration.RunDERPAndSTUN(t, discard, "127.0.0.1"),
		DNSConfig: &tailcfg.DNSConfig{Proxied: true},
		MagicDNSDomain: "fixture.example.test",
		Logf: discard,
	}
	control.HTTPTestServer = httptest.NewUnstartedServer(control)
	control.HTTPTestServer.Start()
	t.Cleanup(control.HTTPTestServer.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	start := func(name string) (*tsnet.Server, string, key.NodePublic) {
		s := &tsnet.Server{Dir: t.TempDir(), ControlURL: control.HTTPTestServer.URL, Hostname: name, Store: new(mem.Store), Ephemeral: true, Logf: discard, UserLogf: discard}
		t.Cleanup(func() { if err := s.Close(); err != nil { t.Errorf("node close: %v", err) } })
		status, err := s.Up(ctx)
		if err != nil { t.Fatalf("node startup: %v", err) }
		if len(status.TailscaleIPs) == 0 { t.Fatal("node has no address") }
		return s, status.TailscaleIPs[0].String(), status.Self.PublicKey
	}
	gateway, address, gatewayKey := start("fixture-gateway")
	owner := control.Node(gatewayKey)
	if owner == nil { t.Fatal("missing gateway control node") }
	lc, err := gateway.LocalClient()
	if err != nil { t.Fatal(err) }
	type observed struct {
		User tailcfg.UserID `json:"user"`
		Login string `json:"login"`
		Tagged bool `json:"tagged"`
		SameOwner bool `json:"sameOwner"`
		OS string `json:"os"`
	}
	listener, err := gateway.Listen("tcp", ":8080")
	if err != nil { t.Fatal(err) }
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		who, err := lc.WhoIs(r.Context(), r.RemoteAddr)
		if err != nil { http.Error(w, "whois failed", http.StatusInternalServerError); return }
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(observed{User:who.Node.User, Login:who.UserProfile.LoginName, Tagged:who.Node.IsTagged(), SameOwner:who.Node.User == owner.User && !who.Node.IsTagged(), OS:who.Node.Hostinfo.OS()})
	})}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	t.Cleanup(func() { server.Close(); <-done })
	for _, role := range []string{"owner", "stranger", "tagged"} {
		t.Run(role, func(t *testing.T) {
			peer, peerAddress, peerKey := start("fixture-"+role)
			node := control.Node(peerKey)
			if node == nil { t.Fatal("missing peer control node") }
			if role != "stranger" { node.User = owner.User }
			if role == "tagged" { node.Tags = []string{"tag:fixture"} }
			control.UpdateNode(node)
			// Wait for the real gateway's netmap, not the control plane's stored clone.
			tick := time.NewTicker(20*time.Millisecond)
			defer tick.Stop()
			for {
				who, err := lc.WhoIs(ctx, net.JoinHostPort(peerAddress, "1234"))
				if err == nil && who.Node.User == node.User && who.Node.IsTagged() == (role == "tagged") { break }
				select { case <-ctx.Done(): t.Fatal("gateway netmap did not learn peer ownership"); case <-tick.C: }
			}
			target := address
			if role == "owner" { target = "fixture-gateway.fixture.example.test" }
			request, err := http.NewRequestWithContext(ctx, "GET", "http://"+net.JoinHostPort(target,"8080")+"/", nil)
			if err != nil { t.Fatal(err) }
			response, err := peer.HTTPClient().Do(request)
			if err != nil { t.Fatalf("userspace network request: %v", err) }
			defer response.Body.Close()
			var actual observed
			if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&actual); err != nil { t.Fatal(err) }
			if response.StatusCode != 200 || actual.User != node.User || actual.SameOwner != (role == "owner") || actual.Tagged != (role == "tagged") || actual.Login == "" || actual.OS == "" { t.Fatalf("wrong peer identity: %+v status=%d", actual, response.StatusCode) }
			if role == "stranger" && actual.User == owner.User { t.Fatal("stranger inherited gateway owner") }
		})
	}
	if control.NumNodes() != 4 { t.Fatalf("expected four real registered nodes, got %d", control.NumNodes()) }
}
