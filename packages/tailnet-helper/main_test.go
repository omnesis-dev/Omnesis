// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"testing"

	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/protocol"
)

type recorder struct {
	calls []string
	fail  bool
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

func TestReadCommandsAppliesEachLineAndSkipsWhatItCannotParse(t *testing.T) {
	input := strings.Join([]string{
		`{"type":"configure","public":{"enabled":true,"paths":["/mcp"]}}`,
		``,
		`not json`,
		`{"type":"reboot"}`,
		`{"type":"login"}`,
		`{"type":"logout"}`,
	}, "\n")
	var logs bytes.Buffer
	rec := &recorder{fail: true}
	readCommands(context.Background(), strings.NewReader(input), rec, log.New(&logs, "", 0))
	want := []string{"configure:/mcp", "login", "logout"}
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
