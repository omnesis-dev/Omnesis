// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Package protocol defines the JSON-lines conversation between the gateway
// and the helper. The gateway writes one Command per line on the helper's
// standard input; the helper writes one Event per line on its standard
// output. Logs go to standard error and are never part of the protocol.
//
// The TypeScript side mirrors these shapes in
// packages/gateway/src/tailscale-embed/protocol.ts; a change here is a
// change there, and Version moves when either side could misread the other.
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// Version is the protocol revision the helper speaks. The gateway refuses a
// helper whose first status event reports a different value.
const Version = 2

// Command types the gateway may send.
const (
	CommandGatewayCertificate = "gateway-certificate"
	CommandConfigure = "configure"
	CommandLogin     = "login"
	CommandLogout    = "logout"
)

// Command is one instruction from the gateway.
type Command struct {
	Type string `json:"type"`
	// Public is set on configure: whether the public address is wanted and
	// which paths it may serve.
	Public *PublicConfig `json:"public,omitempty"`
	Certificate *GatewayCertificate `json:"certificate,omitempty"`
}

// GatewayCertificate is private parent-to-helper material, never emitted in status.
type GatewayCertificate struct {
	Cert string `json:"cert"`
	Key string `json:"key"`
}

// PublicConfig is the gateway's wish for the public (Funnel) address.
type PublicConfig struct {
	Enabled bool `json:"enabled"`
	// Paths are exact paths or prefixes ending in "/" that the public address
	// may serve. Anything else answers 404 without reaching the gateway.
	Paths []string `json:"paths"`
}

// ParseCommand decodes and validates one command line.
func ParseCommand(line []byte) (Command, error) {
	var c Command
	dec := json.NewDecoder(strings.NewReader(string(line)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&c); err != nil {
		return Command{}, fmt.Errorf("decode command: %w", err)
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return Command{}, errors.New("command must contain exactly one JSON object")
	}
	if c.Type != CommandGatewayCertificate && c.Certificate != nil {
		return Command{}, errors.New("certificate material requires gateway-certificate")
	}
	switch c.Type {
	case CommandGatewayCertificate:
		if c.Public != nil || c.Certificate == nil || len(c.Certificate.Cert) == 0 || len(c.Certificate.Cert) > 256*1024 || len(c.Certificate.Key) == 0 || len(c.Certificate.Key) > 64*1024 {
			return Command{}, errors.New("gateway-certificate needs a bounded certificate pair and no public settings")
		}
	case CommandLogin, CommandLogout:
		if c.Public != nil {
			return Command{}, fmt.Errorf("%s takes no public settings", c.Type)
		}
	case CommandConfigure:
		if c.Public == nil {
			return Command{}, errors.New("configure needs public settings")
		}
		for _, p := range c.Public.Paths {
			if !strings.HasPrefix(p, "/") || strings.ContainsAny(p, "?#") {
				return Command{}, fmt.Errorf("public path %q must be an absolute path without query or fragment", p)
			}
		}
	default:
		return Command{}, fmt.Errorf("unknown command type %q", c.Type)
	}
	return c, nil
}

// Backend states, simplified from Tailscale's own for the gateway.
const (
	BackendStarting      = "starting"
	BackendNeedsLogin    = "needs-login"
	BackendNeedsApproval = "needs-approval"
	BackendRunning       = "running"
	BackendStopped       = "stopped"
)

// Certificate sources for the tailnet address.
const (
	// CertificateTailscale is a publicly trusted certificate for the node's
	// tailnet name.
	CertificateTailscale = "tailscale"
	// CertificateGateway is the gateway's own certificate, used when the
	// tailnet has HTTPS certificates switched off or one is not ready yet.
	CertificateGateway = "gateway"
)

// Reasons the Tailscale certificate is not in use.
const (
	CertificateReasonHTTPSDisabled    = "https-disabled"
	CertificateReasonMagicDNSDisabled = "magicdns-disabled"
	CertificateReasonPending          = "pending"
	CertificateReasonFailed           = "failed"
)

// Public address states.
const (
	PublicOff         = "off"
	PublicStarting    = "starting"
	PublicOn          = "on"
	PublicNeedsEnable = "needs-enable"
	PublicUnavailable = "unavailable"
)

// Status is the helper's complete state, sent whenever any part changes.
type Status struct {
	Type        string            `json:"type"` // always "status"
	Protocol    int               `json:"protocol"`
	Backend     string            `json:"backend"`
	LoginURL    string            `json:"loginUrl,omitempty"`
	Node        *NodeStatus       `json:"node,omitempty"`
	Owner       *Owner            `json:"owner,omitempty"`
	Certificate CertificateStatus `json:"certificate"`
	Public      PublicStatus      `json:"public"`
}

// NodeStatus describes the helper's own tailnet device.
type NodeStatus struct {
	DNSName  string   `json:"dnsName"`
	HostName string   `json:"hostName"`
	Tailnet  string   `json:"tailnet,omitempty"`
	IPs      []string `json:"ips"`
}

// Owner is the Tailscale user the helper's device belongs to.
type Owner struct {
	ID          string `json:"id"`
	Login       string `json:"login"`
	DisplayName string `json:"displayName,omitempty"`
}

// CertificateStatus says which certificate the tailnet address presents.
type CertificateStatus struct {
	Source string `json:"source"`
	Reason string `json:"reason,omitempty"`
	Error  string `json:"error,omitempty"`
}

// PublicStatus describes the public (Funnel) address.
type PublicStatus struct {
	State     string `json:"state"`
	URL       string `json:"url,omitempty"`
	EnableURL string `json:"enableUrl,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// Fatal is the last event before the helper exits on an unrecoverable error.
type Fatal struct {
	Type    string `json:"type"` // always "fatal"
	Message string `json:"message"`
}
