// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Package certs serves the gateway's own certificate on the tailnet address
// whenever Tailscale's publicly trusted one cannot be used.
package certs

import (
	"crypto/tls"
	"errors"
	"os"
	"sync"
	"time"
)

// Fallback loads the gateway's certificate and key from disk and reloads them
// when the gateway rotates its certificate, so a device that pinned the
// gateway's certificate keeps trusting the tailnet address.
type Fallback struct {
	certPath, keyPath string

	mu       sync.Mutex
	cert     *tls.Certificate
	certMod  time.Time
	keyMod   time.Time
	checked  time.Time
	interval time.Duration
	now      func() time.Time
}

// NewFallback returns a loader for the given PEM files.
func NewFallback(certPath, keyPath string) *Fallback {
	return &Fallback{certPath: certPath, keyPath: keyPath, interval: 5 * time.Second, now: time.Now}
}

// Certificate returns the current certificate, reloading it when either file
// has changed since the last load. A failed reload keeps serving the last
// good certificate.
func (f *Fallback) Certificate() (*tls.Certificate, error) {
	if f == nil || f.certPath == "" || f.keyPath == "" {
		return nil, errors.New("no gateway certificate configured")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	if f.cert != nil && now.Sub(f.checked) < f.interval {
		return f.cert, nil
	}
	f.checked = now
	cs, cerr := os.Stat(f.certPath)
	ks, kerr := os.Stat(f.keyPath)
	if cerr != nil || kerr != nil {
		if f.cert != nil {
			return f.cert, nil
		}
		return nil, errors.Join(cerr, kerr)
	}
	if f.cert != nil && cs.ModTime().Equal(f.certMod) && ks.ModTime().Equal(f.keyMod) {
		return f.cert, nil
	}
	pair, err := tls.LoadX509KeyPair(f.certPath, f.keyPath)
	if err != nil {
		if f.cert != nil {
			return f.cert, nil
		}
		return nil, err
	}
	f.cert, f.certMod, f.keyMod = &pair, cs.ModTime(), ks.ModTime()
	return f.cert, nil
}
