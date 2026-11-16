// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package portablecontrol

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"tailscale.com/tsnet"
	"testing"
	"time"
)

func serveFixtureLocalAPI(t *testing.T, node *tsnet.Server, directory string) (string, error) {
	t.Helper()
	addr, _, password, err := node.Loopback()
	if err != nil {
		return "", err
	}
	listener, socket, err := privateLocalAPIListener(directory)
	if err != nil {
		return "", err
	}
	target, err := url.Parse("http://" + addr)
	if err != nil {
		listener.Close()
		return "", err
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = &http.Transport{}
	director := proxy.Director
	proxy.Director = func(r *http.Request) {
		director(r)
		r.SetBasicAuth("", password)
		r.Header.Set("Sec-Tailscale", "localapi")
	}
	server := &http.Server{Handler: proxy, ReadHeaderTimeout: 5 * time.Second}
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	t.Cleanup(func() {
		if err := server.Close(); err != nil {
			t.Error(err)
		}
		if err := <-done; err != http.ErrServerClosed {
			t.Errorf("LocalAPI bridge: %v", err)
		}
		if transport, ok := proxy.Transport.(*http.Transport); ok {
			transport.CloseIdleConnections()
		}
	})
	return socket, nil
}
