// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Package identity turns what Tailscale knows about a connection into the
// single header the gateway reads, and decides whether the caller's device
// belongs to the helper's own owner.
package identity

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
)

// Header carries the caller description to the gateway. The gateway trusts it
// only on requests that arrive through the helper's private socket, and the
// helper removes any copy a caller sends.
const Header = "X-Omnesis-Tailnet"

// HeaderPrefix covers every header name the helper owns. Inbound headers with
// this prefix are removed before forwarding.
const HeaderPrefix = "x-omnesis-tailnet"

// Via values.
const (
	ViaTailnet = "tailnet"
	ViaPublic  = "public"
)

// Caller is what the gateway learns about one request.
type Caller struct {
	// Via is "tailnet" for a device on the tailnet, "public" for a request
	// that arrived through the public (Funnel) address.
	Via string `json:"via"`
	// Client is the caller's address: a tailnet address, or for a public
	// request the Internet address Tailscale relayed it from.
	Client string `json:"client"`
	// Peer is set for tailnet requests whose device Tailscale could identify.
	Peer *Peer `json:"peer,omitempty"`
}

// Peer describes the caller's tailnet device and its owner.
type Peer struct {
	NodeID   string   `json:"nodeId"`
	NodeName string   `json:"nodeName"`
	OS       string   `json:"os,omitempty"`
	UserID   string   `json:"userId"`
	Login    string   `json:"login"`
	UserName string   `json:"userName,omitempty"`
	Tags     []string `json:"tags,omitempty"`
	// SameOwner is true when the device belongs to the same Tailscale user as
	// the helper's own device and is not a tagged device.
	SameOwner bool `json:"sameOwner"`
}

// SameOwner applies the one ownership rule: an untagged device whose user is
// the helper's own user. A tagged device belongs to no person, and a device
// shared in from another tailnet reports its own owner, so neither passes.
func SameOwner(selfUserID, peerUserID string, tagged bool) bool {
	return !tagged && selfUserID != "" && peerUserID == selfUserID
}

// Encode renders a caller as the header value: unpadded base64url of JSON, so
// non-ASCII names survive any proxy.
func Encode(c Caller) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

// Decode is the inverse of Encode, used by tests.
func Decode(v string) (Caller, error) {
	var c Caller
	b, err := base64.RawURLEncoding.DecodeString(v)
	if err != nil {
		return c, err
	}
	err = json.Unmarshal(b, &c)
	return c, err
}

// StripOwned removes every inbound header the helper owns, whatever its case.
func StripOwned(h http.Header) {
	for name := range h {
		if strings.HasPrefix(strings.ToLower(name), HeaderPrefix) {
			delete(h, name)
		}
	}
}
