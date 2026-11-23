// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/certs"
	"io"
	"log"
	"math/big"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/protocol"
)

type recorder struct {
	calls []string
	fail  bool
}

func (r *recorder) SetGatewayCertificate(protocol.GatewayCertificate) error {
	r.calls = append(r.calls, "certificate")
	if r.fail {
		return errors.New("invalid gateway certificate pair")
	}
	return nil
}

func (r *recorder) Configure(cfg protocol.PublicConfig) {
	r.calls = append(r.calls, "configure:"+strings.Join(cfg.Paths, ","))
}

func (r *recorder) Login(context.Context) error {
	r.calls = append(r.calls, "login")
	if r.fail {
		return errors.New("control server unreachable")
	}
	return nil
}

func (r *recorder) Logout(context.Context) error {
	r.calls = append(r.calls, "logout")
	return nil
}

func (r *recorder) Rename(_ context.Context, hostname string) error {
	r.calls = append(r.calls, "rename:"+hostname)
	return nil
}

func TestReadCommandsAppliesEachLineAndSkipsWhatItCannotParse(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"configure","public":{"enabled":true,"paths":["/mcp"]}}`,
		``,
		`not json`,
		`{"type":"reboot"}`,
		`{"type":"login"}`,
		`{"type":"logout"}`,
		`{"type":"rename","hostname":"Not A Name"}`,
		`{"type":"rename","hostname":"home-box"}`,
	}, "\n")
	var logs bytes.Buffer
	rec := &recorder{fail: true}
	readCommands(context.Background(), strings.NewReader(input), rec, log.New(&logs, "", 0))
	want := []string{"configure:/mcp", "login", "logout", "rename:home-box"}
	if strings.Join(rec.calls, " ") != strings.Join(want, " ") {
		t.Fatalf("calls = %v, want %v", rec.calls, want)
	}
	for _, expected := range []string{"reboot", "sign-in: control server unreachable"} {
		if !strings.Contains(logs.String(), expected) {
			t.Fatalf("log %q lacks %q", logs.String(), expected)
		}
	}
}

func TestEmitterWritesOneJSONValuePerLine(t *testing.T) {
	var out bytes.Buffer
	e := newEmitter(&out)
	e.send(protocol.Fatal{Type: "fatal", Message: "first"})
	e.send(protocol.Fatal{Type: "fatal", Message: "second\nline"})
	lines := strings.Split(strings.TrimSuffix(out.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d lines: %q", len(lines), out.String())
	}
	var second protocol.Fatal
	if err := json.Unmarshal([]byte(lines[1]), &second); err != nil || second.Message != "second\nline" {
		t.Fatalf("second line %q: %v", lines[1], err)
	}
}

func TestEnvironmentIsolationIncludesCaseInsensitiveWindowsNames(t *testing.T) {
	t.Setenv("TS_AUTHKEY", "invented-ambient-key")
	t.Setenv("ts_client_secret", "invented-ambient-secret")
	t.Setenv("OMNESIS_INVENTED_TEST_VARIABLE", "keep")
	isolateFromEnvironment()
	if os.Getenv("TS_AUTHKEY") != "" || os.Getenv("ts_client_secret") != "" {
		t.Fatal("ambient sign-in credentials survived isolation")
	}
	if os.Getenv("OMNESIS_INVENTED_TEST_VARIABLE") != "keep" {
		t.Fatal("unrelated environment changed")
	}
	if os.Getenv("TS_USE_CACHED_NETMAP") != "false" {
		t.Fatal("the device may start from a network map kept by an earlier run")
	}
}

func TestGatewayCertificateBootstrapFailsClosedAndPreservesBufferedCommands(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kb, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	pair := protocol.GatewayCertificate{Cert: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), Key: string(pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}))}
	frame, err := json.Marshal(protocol.Command{Type: protocol.CommandGatewayCertificate, Certificate: &pair})
	if err != nil {
		t.Fatal(err)
	}
	sc := commandScanner(strings.NewReader(string(frame) + "\n" + `{"type":"login"}` + "\n"))
	f := certs.NewFallback("", "")
	if err := readGatewayCertificateBootstrap(sc, f); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Certificate(); err != nil {
		t.Fatal(err)
	}
	rec := &recorder{}
	readCommandScanner(context.Background(), sc, rec, log.New(io.Discard, "", 0))
	if strings.Join(rec.calls, " ") != "login" {
		t.Fatalf("lost buffered command: %v", rec.calls)
	}
	for _, input := range []string{"", "\n", `{"type":"login"}`, `{"type":"gateway-certificate","certificate":{"cert":"invalid","key":"invented-private-secret"}}`} {
		f := certs.NewFallback("", "")
		err := readGatewayCertificateBootstrap(commandScanner(strings.NewReader(input)), f)
		if err == nil {
			t.Fatalf("accepted invalid bootstrap")
		}
		if strings.Contains(err.Error(), "invented-private-secret") {
			t.Fatal("leaked private material")
		}
		if _, err := f.Certificate(); err == nil {
			t.Fatal("invalid bootstrap installed a certificate")
		}
	}
}

func TestCertificateRefreshFailureDoesNotStopLaterCommandsOrLogMaterial(t *testing.T) {
	var logs bytes.Buffer
	rec := &recorder{fail: true}
	input := `{"type":"gateway-certificate","certificate":{"cert":"invented-private-cert","key":"invented-private-key"}}` + "\n" + `{"type":"logout"}` + "\n"
	readCommands(context.Background(), strings.NewReader(input), rec, log.New(&logs, "", 0))
	if strings.Join(rec.calls, " ") != "certificate logout" {
		t.Fatalf("calls: %v", rec.calls)
	}
	if !strings.Contains(logs.String(), "refresh rejected") || strings.Contains(logs.String(), "invented-private") {
		t.Fatalf("unexpected log: %s", logs.String())
	}
}
