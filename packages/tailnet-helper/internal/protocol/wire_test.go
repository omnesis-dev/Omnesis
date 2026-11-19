// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package protocol

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// wire holds the messages the gateway's own tests read too (see
// packages/gateway/src/tailscale-embed/protocol.test.ts).
type wire struct {
	Commands []json.RawMessage `json:"commands"`
	Events   []json.RawMessage `json:"events"`
}

func loadWire(t *testing.T) wire {
	t.Helper()
	raw, err := os.ReadFile("testdata/wire.json")
	if err != nil {
		t.Fatal(err)
	}
	var w wire
	if err := json.Unmarshal(raw, &w); err != nil {
		t.Fatal(err)
	}
	return w
}

func sameJSON(t *testing.T, got []byte, want json.RawMessage) {
	t.Helper()
	var g, w any
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(g, w) {
		t.Fatalf("got %s\nwant %s", got, want)
	}
}

func TestEveryGatewayCommandParses(t *testing.T) {
	for _, line := range loadWire(t).Commands {
		c, err := ParseCommand(line)
		if err != nil {
			t.Fatalf("%s: %v", line, err)
		}
		out, _ := json.Marshal(c)
		sameJSON(t, out, line)
	}
}

func TestEveryEventIsWrittenExactlyAsTheGatewayReadsIt(t *testing.T) {
	for _, line := range loadWire(t).Events {
		var head struct{ Type string }
		json.Unmarshal(line, &head)
		var v any
		switch head.Type {
		case "status":
			v = &Status{}
		case "fatal":
			v = &Fatal{}
		default:
			t.Fatalf("unknown event %s", line)
		}
		dec := json.NewDecoder(bytes.NewReader(line))
		dec.DisallowUnknownFields()
		if err := dec.Decode(v); err != nil {
			t.Fatalf("%s: %v", line, err)
		}
		out, _ := json.Marshal(v)
		sameJSON(t, out, line)
	}
}
