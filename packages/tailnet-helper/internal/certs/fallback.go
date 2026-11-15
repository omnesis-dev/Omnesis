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

// Fallback serves the active gateway certificate supplied by its parent.
// Standalone helpers can instead reload legacy PEM files from disk.
type Fallback struct {
	certPath, keyPath string

	mu       sync.Mutex
	parentManaged bool
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

// SetPEM atomically installs a validated pair and stops reading legacy files.
// A rejected update leaves the last good pair intact.
func (f *Fallback) SetPEM(cert, key string) error {
	if f == nil {
		return errors.New("no gateway certificate configured")
	}
	pair, err := tls.X509KeyPair([]byte(cert), []byte(key))
	if err != nil {
		return errors.New("invalid gateway certificate pair")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cert, f.parentManaged = &pair, true
	return nil
}

// Certificate returns the current certificate, reloading it when either file
// has changed since the last load. A failed reload keeps serving the last
// good certificate.
func (f *Fallback) Certificate() (*tls.Certificate, error) {
	if f == nil {
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
