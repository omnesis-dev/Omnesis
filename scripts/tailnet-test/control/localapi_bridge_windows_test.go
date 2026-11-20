// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package portablecontrol

import (
	"crypto/rand"
	"encoding/hex"
	"net"

	"github.com/tailscale/go-winio"
	"golang.org/x/sys/windows"
)

func privateLocalAPIListener(_ string) (net.Listener, string, error) {
	tokenUser, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, "", err
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, "", err
	}
	socket := `\\.\pipe\omnesis-fixture-` + hex.EncodeToString(nonce[:])
	listener, err := winio.ListenPipe(socket, &winio.PipeConfig{
		SecurityDescriptor: "D:P(A;;GA;;;" + tokenUser.User.Sid.String() + ")",
		InputBufferSize:    65536, OutputBufferSize: 65536,
	})
	return listener, socket, err
}
