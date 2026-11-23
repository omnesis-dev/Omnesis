// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package node

import (
	"testing"

	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/protocol"
)

func TestReportedBackendWaitsForTheCoordinationServer(t *testing.T) {
	cases := []struct {
		name            string
		backend         string
		confirmed       bool
		controlLoginURL string
		want            string
	}{
		{"confirmed in this run", protocol.BackendRunning, true, "", protocol.BackendRunning},
		{"running from a kept network map", protocol.BackendRunning, false, "", protocol.BackendStarting},
		{"a kept network map for a device the server no longer knows", protocol.BackendRunning, false, "https://login.example.com/a/1", protocol.BackendNeedsLogin},
		{"needs login", protocol.BackendNeedsLogin, false, "", protocol.BackendNeedsLogin},
		{"needs approval", protocol.BackendNeedsApproval, false, "", protocol.BackendNeedsApproval},
		{"starting", protocol.BackendStarting, false, "", protocol.BackendStarting},
	}
	for _, c := range cases {
		if got := reportedBackend(c.backend, c.confirmed, c.controlLoginURL); got != c.want {
			t.Errorf("%s: reportedBackend = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestSnapshotShowsNoAddressUntilTheServerConfirmsTheDevice(t *testing.T) {
	n := &Node{
		backend:         protocol.BackendRunning,
		dnsName:         "omnesis-1.example-net.ts.net",
		askedName:       "omnesis",
		controlLoginURL: "https://login.example.com/a/1",
		loginURL:        "https://login.example.com/a/2",
		public:          protocol.PublicStatus{State: protocol.PublicOff},
	}
	st := n.Snapshot()
	if st.Backend != protocol.BackendNeedsLogin || st.Node != nil || st.LoginURL != "https://login.example.com/a/2" {
		t.Fatalf("unconfirmed device reported %+v", st)
	}
	n.confirmed = true
	st = n.Snapshot()
	if st.Backend != protocol.BackendRunning || st.Node == nil {
		t.Fatalf("confirmed device reported %+v", st)
	}
	if st.Node.HostName != "omnesis-1" || st.Node.AskedName != "omnesis" || st.LoginURL != "" {
		t.Fatalf("node = %+v", st.Node)
	}
}
