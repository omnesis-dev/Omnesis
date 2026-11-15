// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Command omnesis-tailnet joins the gateway to the owner's Tailscale network
// as its own device and forwards requests to the gateway's private socket.
//
// The gateway starts it, speaks to it over standard input and output (see
// internal/protocol), and stops it by closing standard input.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"

	"tailscale.com/envknob"
	"tailscale.com/logtail"

	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/certs"
	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/node"
	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/protocol"
	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/proxy"
)

// version is set at build time.
var version = "dev"

func main() {
	stateDir := flag.String("state-dir", "", "directory for this device's Tailscale state (required)")
	hostname := flag.String("hostname", "omnesis", "device name on the tailnet")
	controlURL := flag.String("control-url", "", "coordination server URL; empty for Tailscale's own")
	socket := flag.String("socket", "", "the gateway's private local endpoint (required)")
	socketPin := flag.String("socket-certificate-sha256", "", "pinned certificate for the authenticated local transport")
	certFile := flag.String("fallback-cert", "", "the gateway's certificate, served when Tailscale's cannot be")
	keyFile := flag.String("fallback-key", "", "the key for -fallback-cert")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	logger := log.New(os.Stderr, "", 0)
	if *stateDir == "" || *socket == "" {
		logger.Println("omnesis-tailnet: -state-dir and -socket are required")
		os.Exit(2)
	}
	token := os.Getenv("OMNESIS_TAILNET_IPC_TOKEN")
	os.Unsetenv("OMNESIS_TAILNET_IPC_TOKEN")
	endpoint := proxy.Endpoint{Path: *socket, CertificateSHA256: *socketPin, Token: token}
	if err := endpoint.Validate(); err != nil {
		logger.Printf("omnesis-tailnet: %v", err)
		os.Exit(2)
	}
	isolateFromEnvironment()

	out := newEmitter(os.Stdout)
	n := node.New(node.Config{
		StateDir:                *stateDir,
		Hostname:                *hostname,
		ControlURL:              *controlURL,
		SocketPath:              *socket,
		SocketCertificateSHA256: *socketPin,
		SocketToken:             token,
		Fallback:                certs.NewFallback(*certFile, *keyFile),
		Logf:                    logger.Printf,
		Emit:                    func(st protocol.Status) { out.send(st) },
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	if err := n.Start(); err != nil {
		out.send(protocol.Fatal{Type: "fatal", Message: err.Error()})
		logger.Printf("omnesis-tailnet: %v", err)
		os.Exit(1)
	}
	// The gateway holds the other end of standard input. When it goes away,
	// for any reason, so does the helper.
	go func() {
		defer cancel()
		readCommands(ctx, os.Stdin, n, logger)
	}()

	if err := n.Run(ctx); err != nil {
		out.send(protocol.Fatal{Type: "fatal", Message: err.Error()})
		logger.Printf("omnesis-tailnet: %v", err)
		os.Exit(1)
	}
}

// isolateFromEnvironment keeps the device's behaviour independent of the
// environment the gateway happens to run in, and keeps its logs local.
func isolateFromEnvironment() {
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		// A stray TS_AUTHKEY or TS_CLIENT_SECRET would sign this device in to
		// whatever account it names without the owner choosing it.
		if strings.HasPrefix(strings.ToUpper(name), "TS_") {
			os.Unsetenv(name)
		}
	}
	// Tailscale clients upload their logs to Tailscale by default. This device
	// carries the owner's private traffic, so its logs never leave the machine.
	envknob.SetNoLogsNoSupport()
	logtail.Disable()
}

// commander is what the gateway's commands act on: the node, or a test double.
type commander interface {
	Configure(protocol.PublicConfig)
	Login(context.Context) error
	Logout(context.Context) error
}

// readCommands applies the gateway's commands, one JSON line each, until r
// ends. A line it cannot parse is logged and skipped.
func readCommands(ctx context.Context, r io.Reader, n commander, logger *log.Logger) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		cmd, err := protocol.ParseCommand(line)
		if err != nil {
			logger.Printf("omnesis-tailnet: %v", err)
			continue
		}
		switch cmd.Type {
		case protocol.CommandConfigure:
			n.Configure(*cmd.Public)
		case protocol.CommandLogin:
			if err := n.Login(ctx); err != nil {
				logger.Printf("omnesis-tailnet: sign-in: %v", err)
			}
		case protocol.CommandLogout:
			if err := n.Logout(ctx); err != nil {
				logger.Printf("omnesis-tailnet: sign-out: %v", err)
			}
		}
	}
}

// emitter writes one JSON value per line, one line at a time.
type emitter struct {
	mu sync.Mutex
	w  io.Writer
}

func newEmitter(w io.Writer) *emitter { return &emitter{w: w} }

func (e *emitter) send(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.w.Write(append(b, '\n'))
}
