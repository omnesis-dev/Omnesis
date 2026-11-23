// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package protocol

import "testing"

func TestParseCommandAccepts(t *testing.T) {
	ok := []string{
		`{"type":"gateway-certificate","certificate":{"cert":"invented-cert","key":"invented-key"}}`,
		`{"type":"login"}`,
		`{"type":"logout"}`,
		`{"type":"configure","public":{"enabled":false,"paths":[]}}`,
		`{"type":"configure","public":{"enabled":true,"paths":["/mcp","/portal/vendor/"]}}`,
		`{"type":"rename","hostname":"home-box-2"}`,
	}
	for _, line := range ok {
		if _, err := ParseCommand([]byte(line)); err != nil {
			t.Errorf("ParseCommand(%s) = %v, want nil", line, err)
		}
	}
}

func TestParseCommandRejects(t *testing.T) {
	bad := []string{
		``,
		`not json`,
		`{"type":"reboot"}`,
		`{"type":"configure"}`,
		`{"type":"login","public":{"enabled":true,"paths":[]}}`,
		`{"type":"configure","public":{"enabled":true,"paths":["mcp"]}}`,
		`{"type":"configure","public":{"enabled":true,"paths":["/mcp?x=1"]}}`,
		`{"type":"configure","public":{"enabled":true,"paths":["/mcp#frag"]}}`,
		`{"type":"login","extra":1}`,
		`{"type":"gateway-certificate"}`,
		`{"type":"gateway-certificate","certificate":{"cert":"x","key":""}}`,
		`{"type":"gateway-certificate","certificate":{"cert":"x","key":"y","other":true}}`,
		`{"type":"gateway-certificate","certificate":{"cert":"x","key":"y"},"public":{"enabled":false,"paths":[]}}`,
		`{"type":"login","certificate":{"cert":"x","key":"y"}}`,
		`{"type":"configure","certificate":{"cert":"x","key":"y"},"public":{"enabled":false,"paths":[]}}`,
		`{"type":"login"} {"type":"logout"}`,
		`{"type":"rename"}`,
		`{"type":"rename","hostname":"Home-Box"}`,
		`{"type":"rename","hostname":"-box"}`,
		`{"type":"rename","hostname":"box-"}`,
		`{"type":"rename","hostname":"home.box"}`,
		`{"type":"rename","hostname":"a234567890123456789012345678901234567890123456789012345678901234"}`,
		`{"type":"rename","hostname":"box","public":{"enabled":false,"paths":[]}}`,
		`{"type":"login","hostname":"box"}`,
	}
	for _, line := range bad {
		if _, err := ParseCommand([]byte(line)); err == nil {
			t.Errorf("ParseCommand(%q) succeeded, want error", line)
		}
	}
}
