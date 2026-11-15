// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package proxy

import (
	"context"
	"net"
	"strings"

	"github.com/tailscale/go-winio"
)

func dialLocal(ctx context.Context, path string) (net.Conn, error) {
	if strings.HasPrefix(path, `\\.\pipe\`) {
		return winio.DialPipeContext(ctx, path)
	}
	return (&net.Dialer{}).DialContext(ctx, "unix", path)
}
