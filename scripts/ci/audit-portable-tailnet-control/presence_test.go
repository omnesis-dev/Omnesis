// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package portablecontrol

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"tailscale.com/envknob"
	"tailscale.com/logtail"
	"tailscale.com/net/netns"
	"tailscale.com/tsnet"
	"tailscale.com/tstest/integration"
	"tailscale.com/tstest/integration/testcontrol"
)

// Discovery consumes the real LocalAPI presence produced from control maps.
// A disconnected peer must not remain online merely to satisfy discovery.
func TestStreamPresenceDrivesActualStatus(t *testing.T) {
	envknob.SetNoLogsNoSupport()
	logtail.Disable()
	netns.SetEnabled(false)
	t.Cleanup(func() { netns.SetEnabled(true) })
	discard := func(string, ...any) {}
	control := &testcontrol.Server{
		DERPMap:        integration.RunDERPAndSTUN(t, discard, "127.0.0.1"),
		MagicDNSDomain: "tailnet.test", Logf: discard,
	}
	mapsWithoutCertificates(t, control)
	control.HTTPTestServer = httptest.NewServer(control)
	t.Cleanup(control.HTTPTestServer.Close)
	gateway := &tsnet.Server{Dir: t.TempDir(), Hostname: "fixture-presence-gateway", ControlURL: control.HTTPTestServer.URL, Logf: discard, UserLogf: discard}
	closed := false
	t.Cleanup(func() {
		if !closed {
			if err := gateway.Close(); err != nil {
				t.Error(err)
			}
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	gatewayStatus, err := gateway.Up(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if gatewayStatus.Self == nil {
		t.Fatal("gateway has no actual registered identity")
	}
	observer := &tsnet.Server{Dir: t.TempDir(), Hostname: "fixture-presence-observer", ControlURL: control.HTTPTestServer.URL, Logf: discard, UserLogf: discard}
	t.Cleanup(func() {
		if err := observer.Close(); err != nil {
			t.Error(err)
		}
	})
	if _, err := observer.Up(ctx); err != nil {
		t.Fatal(err)
	}
	client, err := observer.LocalClient()
	if err != nil {
		t.Fatal(err)
	}
	observe := func(wantOnline bool) {
		t.Helper()
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			state, err := client.Status(ctx)
			if err != nil {
				t.Fatal(err)
			}
			peer := state.Peer[gatewayStatus.Self.PublicKey]
			if peer != nil && peer.Online == wantOnline {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatalf("actual LocalAPI did not observe online=%v: %v", wantOnline, ctx.Err())
			case <-ticker.C:
			}
		}
	}
	observe(true)
	if err := gateway.Close(); err != nil {
		t.Fatal(err)
	}
	closed = true
	observe(false)
}
