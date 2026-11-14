// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package certs

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writePair(t *testing.T, dir, cn string, mod time.Time) (string, string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: cn},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kb, _ := x509.MarshalECPrivateKey(key)
	cp, kp := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	os.WriteFile(cp, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600)
	os.WriteFile(kp, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600)
	os.Chtimes(cp, mod, mod)
	os.Chtimes(kp, mod, mod)
	return cp, kp
}

func leafCN(t *testing.T, f *Fallback) string {
	t.Helper()
	c, err := f.Certificate()
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(c.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	return leaf.Subject.CommonName
}

func TestFallbackReloadsAfterRotation(t *testing.T) {
	dir := t.TempDir()
	base := time.Now().Add(-time.Minute)
	cp, kp := writePair(t, dir, "first", base)
	clock := base
	f := NewFallback(cp, kp)
	f.now = func() time.Time { return clock }
	if got := leafCN(t, f); got != "first" {
		t.Fatalf("got %q", got)
	}
	writePair(t, dir, "second", base.Add(10*time.Second))
	if got := leafCN(t, f); got != "first" {
		t.Fatalf("reloaded before the check interval: %q", got)
	}
	clock = clock.Add(6 * time.Second)
	if got := leafCN(t, f); got != "second" {
		t.Fatalf("did not reload after rotation: %q", got)
	}
}

func TestFallbackKeepsLastGoodOnBrokenFiles(t *testing.T) {
	dir := t.TempDir()
	base := time.Now().Add(-time.Minute)
	cp, kp := writePair(t, dir, "good", base)
	clock := base
	f := NewFallback(cp, kp)
	f.now = func() time.Time { return clock }
	leafCN(t, f)
	os.WriteFile(cp, []byte("garbage"), 0o600)
	os.Chtimes(cp, base.Add(time.Second), base.Add(time.Second))
	clock = clock.Add(time.Minute)
	if got := leafCN(t, f); got != "good" {
		t.Fatalf("lost the last good certificate: %q", got)
	}
	os.Remove(cp)
	clock = clock.Add(time.Minute)
	if got := leafCN(t, f); got != "good" {
		t.Fatalf("lost the last good certificate after removal: %q", got)
	}
}

func TestFallbackWithoutPaths(t *testing.T) {
	if _, err := NewFallback("", "").Certificate(); err == nil {
		t.Fatal("want error without paths")
	}
	var nilFallback *Fallback
	if _, err := nilFallback.Certificate(); err == nil {
		t.Fatal("want error from nil fallback")
	}
}
