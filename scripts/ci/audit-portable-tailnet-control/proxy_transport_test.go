// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package portablecontrol

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/net/tsaddr"
	"tailscale.com/tsnet"
)

type fixtureTunnel struct {
	net.Conn
	reader *bufio.Reader
}

func (connection fixtureTunnel) Read(bytes []byte) (int, error) { return connection.reader.Read(bytes) }

func fixturePeerProxyClient(t *testing.T, peer *tsnet.Server) *http.Client {
	t.Helper()
	endpoint, err := url.Parse(serveFixturePeerProxy(t, peer))
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, network, target string) (net.Conn, error) {
		connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", endpoint.Host)
		if err != nil {
			return nil, err
		}
		if err := connection.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
			connection.Close()
			return nil, err
		}
		request := &http.Request{Method: http.MethodConnect, URL: &url.URL{Host: target}, Host: target}
		if err := request.Write(connection); err != nil {
			connection.Close()
			return nil, err
		}
		reader := bufio.NewReader(connection)
		response, err := http.ReadResponse(reader, request)
		if err != nil {
			connection.Close()
			return nil, err
		}
		if response.StatusCode != http.StatusOK {
			connection.Close()
			return nil, fmt.Errorf("fixture proxy status %d", response.StatusCode)
		}
		if err := connection.SetDeadline(time.Time{}); err != nil {
			connection.Close()
			return nil, err
		}
		return fixtureTunnel{Conn: connection, reader: reader}, nil
	}}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport}
}

// Each tunnel dials through this peer's real encrypted userspace network.
// Track hijacked connections explicitly: http.Server.Close does not own them.
func serveFixturePeerProxy(t *testing.T, peer *tsnet.Server) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := peer.LocalClient()
	if err != nil {
		t.Fatal(err)
	}
	state, err := client.Status(ctx)
	if err != nil || state.CurrentTailnet == nil || state.CurrentTailnet.MagicDNSSuffix == "" {
		t.Fatal("fixture peer has no actual tailnet suffix")
	}
	suffix := strings.ToLower(strings.TrimSuffix(state.CurrentTailnet.MagicDNSSuffix, "."))
	var mu sync.Mutex
	stopping := false
	tunnels := map[net.Conn]net.Conn{}
	proxy := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect {
			http.Error(w, "CONNECT required", http.StatusMethodNotAllowed)
			return
		}
		host, port, err := net.SplitHostPort(r.Host)
		number, portErr := strconv.Atoi(port)
		address, addressErr := netip.ParseAddr(host)
		localName := strings.HasSuffix(strings.TrimSuffix(strings.ToLower(host), "."), "."+suffix)
		if err != nil || portErr != nil || number < 1 || number > 65535 || (!localName && (addressErr != nil || !tsaddr.CGNATRange().Contains(address))) {
			http.Error(w, "fixture tailnet target required", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		upstream, err := peer.Dial(ctx, "tcp", r.Host)
		cancel()
		if err != nil {
			http.Error(w, "fixture tailnet dial failed", http.StatusBadGateway)
			return
		}
		mu.Lock()
		if stopping {
			mu.Unlock()
			upstream.Close()
			http.Error(w, "fixture stopping", http.StatusServiceUnavailable)
			return
		}
		client, buffered, err := w.(http.Hijacker).Hijack()
		if err != nil {
			mu.Unlock()
			upstream.Close()
			return
		}
		tunnels[client] = upstream
		mu.Unlock()
		defer func() {
			client.Close()
			upstream.Close()
			mu.Lock()
			delete(tunnels, client)
			mu.Unlock()
		}()
		if _, err := buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
			return
		}
		if err := buffered.Flush(); err != nil {
			return
		}
		copied := make(chan struct{})
		go func() {
			defer close(copied)
			io.Copy(client, upstream)
			client.Close()
			upstream.Close()
		}()
		io.Copy(upstream, buffered.Reader)
		client.Close()
		upstream.Close()
		<-copied
	}))
	proxy.Config.ReadHeaderTimeout = 5 * time.Second
	proxy.Start()
	t.Cleanup(func() {
		mu.Lock()
		stopping = true
		for client, upstream := range tunnels {
			client.Close()
			upstream.Close()
		}
		mu.Unlock()
		proxy.Close()
	})
	return proxy.URL
}
