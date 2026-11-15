// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package proxy

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"net"
	"strings"
	"time"
)

// TransportHeader is private to the local helper-to-gateway connection.
const TransportHeader = "X-Omnesis-Tailnet-Transport"

// Endpoint uses account-private Unix permissions or server-pinned local TLS
// with a per-service helper token.
// Token is injected by the gateway into the helper's private environment.
type Endpoint struct {
	Path              string
	CertificateSHA256 string
	Token             string
}

// Validate refuses a named pipe without both server and helper authentication.
func (e Endpoint) Validate() error {
	if e.Path == "" {
		return errors.New("the private endpoint path is required")
	}
	secured := e.CertificateSHA256 != "" || e.Token != ""
	if strings.HasPrefix(e.Path, `\\.\pipe\`) && !secured {
		return errors.New("the named pipe requires authenticated TLS")
	}
	if !secured {
		return nil
	}
	pin, err := hex.DecodeString(e.CertificateSHA256)
	token, tokenErr := hex.DecodeString(e.Token)
	if err != nil || len(pin) != sha256.Size || tokenErr != nil || len(token) != 32 {
		return errors.New("invalid private endpoint authentication")
	}
	return nil
}

func (e Endpoint) dial(ctx context.Context, secured bool) (net.Conn, error) {
	if err := e.Validate(); err != nil {
		return nil, err
	}
	if secured != (e.CertificateSHA256 != "") {
		return nil, errors.New("private endpoint transport does not match its authentication")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, err := dialLocal(ctx, e.Path)
	if err != nil {
		return nil, err
	}
	if !secured {
		return conn, nil
	}
	pin, _ := hex.DecodeString(e.CertificateSHA256)
	tlsConn := tls.Client(conn, &tls.Config{
		MinVersion: tls.VersionTLS12,
		// The gateway's own certificate may be self-signed. The exact leaf
		// fingerprint replaces PKI verification; no token is sent before this.
		InsecureSkipVerify: true,
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 {
				return errors.New("private endpoint supplied no certificate")
			}
			actual := sha256.Sum256(state.PeerCertificates[0].Raw)
			if subtle.ConstantTimeCompare(actual[:], pin) != 1 {
				return errors.New("private endpoint certificate does not match its pin")
			}
			return nil
		},
	})
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		conn.Close()
		return nil, err
	}
	return tlsConn, nil
}
