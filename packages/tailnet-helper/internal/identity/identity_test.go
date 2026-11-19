// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package identity

import (
	"net/http"
	"testing"
)

func TestSameOwner(t *testing.T) {
	cases := []struct {
		name         string
		self, peer   string
		tagged, want bool
	}{
		{"owner's own device", "7", "7", false, true},
		{"another user's device", "7", "8", false, false},
		{"tagged device owned by nobody", "7", "7", true, false},
		{"tagged device with another user id", "7", "2147455555", true, false},
		{"helper not signed in yet", "", "", false, false},
		{"helper not signed in, peer known", "", "7", false, false},
	}
	for _, c := range cases {
		if got := SameOwner(c.self, c.peer, c.tagged); got != c.want {
			t.Errorf("%s: SameOwner(%q, %q, %v) = %v, want %v", c.name, c.self, c.peer, c.tagged, got, c.want)
		}
	}
}

func TestEncodeDecodeRoundTripsNonASCII(t *testing.T) {
	in := Caller{Via: ViaTailnet, Client: "100.64.0.2:4242", Peer: &Peer{
		NodeID: "nX", NodeName: "maya-laptop", UserID: "7", Login: "maya@example.com",
		UserName: "Maya Rëeves 🚲", Tags: []string{"tag:a"}, SameOwner: true,
	}}
	v := Encode(in)
	for _, r := range v {
		if r > 127 || r == '=' || r == '+' || r == '/' {
			t.Fatalf("header value is not unpadded base64url: %q", v)
		}
	}
	out, err := Decode(v)
	if err != nil {
		t.Fatal(err)
	}
	if out.Peer == nil || out.Peer.UserName != in.Peer.UserName || out.Client != in.Client || !out.Peer.SameOwner {
		t.Fatalf("round trip lost data: %+v", out)
	}
}

func TestStripOwnedRemovesEveryCasing(t *testing.T) {
	h := http.Header{}
	h["X-Omnesis-Tailnet"] = []string{"forged"}
	h["x-omnesis-tailnet-extra"] = []string{"forged"}
	h["X-OMNESIS-TAILNET-PEER"] = []string{"forged"}
	h.Set("Authorization", "Bearer keep")
	h.Set("X-Omnesis-Other", "keep")
	StripOwned(h)
	if len(h) != 2 || h.Get("Authorization") == "" || h.Get("X-Omnesis-Other") == "" {
		t.Fatalf("unexpected headers after strip: %v", h)
	}
}
