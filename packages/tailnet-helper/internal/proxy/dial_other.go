//go:build !windows

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package proxy

import (
    "context"
    "net"
)

func dialLocal(ctx context.Context, path string) (net.Conn, error) {
    return (&net.Dialer{}).DialContext(ctx, "unix", path)
}
