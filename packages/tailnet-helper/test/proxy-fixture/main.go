// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// A local-only proxy fixture for the cross-language private-transport lane.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"

	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/identity"
	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/proxy"
)

type resolver struct{}

func (resolver) Resolve(context.Context, string) (*identity.Peer, error) {
	return &identity.Peer{NodeID: "invented-node", NodeName: "invented-device", UserID: "invented-owner", Login: "operator@example.com", SameOwner: true}, nil
}

func main() {
	socket := flag.String("socket", "", "local endpoint")
	pin := flag.String("pin", "", "local server pin")
	flag.Parse()
	endpoint := proxy.Endpoint{Path: *socket, CertificateSHA256: *pin, Token: os.Getenv("OMNESIS_TAILNET_IPC_TOKEN")}
	os.Unsetenv("OMNESIS_TAILNET_IPC_TOKEN")
	if err := endpoint.Validate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	p := proxy.NewEndpoint(endpoint, resolver{}, func(string, ...any) {})
	server := &http.Server{Handler: p.Tailnet()}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	json.NewEncoder(os.Stdout).Encode(map[string]string{"address": listener.Addr().String()})
	// The owning test closes stdin only after its requests and WebSockets join.
	bufio.NewScanner(os.Stdin).Scan()
	server.Close()
	<-done
}
