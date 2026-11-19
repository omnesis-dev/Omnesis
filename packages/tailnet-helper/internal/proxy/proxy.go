// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Package proxy forwards HTTP requests from the tailnet and from the public
// address to the gateway's private Unix socket, telling the gateway who is
// calling and refusing public requests outside the paths it allows.
package proxy

import (
	"context"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"strings"
	"sync/atomic"
	"time"

	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/identity"
)

// Resolver identifies the tailnet device behind a remote address.
type Resolver interface {
	Resolve(ctx context.Context, remoteAddr string) (*identity.Peer, error)
}

// Proxy is the reverse proxy in front of the gateway.
type Proxy struct {
	resolver    Resolver
	publicPaths atomic.Pointer[[]string]
	upstream    *httputil.ReverseProxy
	logf        func(string, ...any)
}

type clientKey struct{}

// WithClient records the caller's address on a connection's context. The
// public listener uses it to carry the Internet address Tailscale relayed the
// connection from; the tailnet listener leaves it unset.
func WithClient(ctx context.Context, client string) context.Context {
	return context.WithValue(ctx, clientKey{}, client)
}

// New returns a proxy that dials the gateway at socketPath.
func New(socketPath string, resolver Resolver, logf func(string, ...any)) *Proxy {
	return NewEndpoint(Endpoint{Path: socketPath}, resolver, logf)
}

// NewEndpoint forwards over the protected local transport described by endpoint.
func NewEndpoint(endpoint Endpoint, resolver Resolver, logf func(string, ...any)) *Proxy {
	if logf == nil {
		logf = log.Printf
	}
	p := &Proxy{resolver: resolver, logf: logf}
	empty := []string{}
	p.publicPaths.Store(&empty)
	p.upstream = &httputil.ReverseProxy{
		// The gateway reads the caller from the identity header only; the
		// standard forwarding headers are dropped by Rewrite and not re-added.
		Rewrite: func(pr *httputil.ProxyRequest) {
			scheme := "http"
			if endpoint.CertificateSHA256 != "" {
				scheme = "https"
			}
			pr.SetURL(&url.URL{Scheme: scheme, Host: "gateway"})
			pr.Out.Header.Del(TransportHeader)
			if endpoint.Token != "" {
				pr.Out.Header.Set(TransportHeader, endpoint.Token)
			}
			pr.Out.Host = pr.In.Host
		},
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return endpoint.dial(ctx, false)
			},
			DialTLSContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return endpoint.dial(ctx, true)
			},
			MaxIdleConns:          64,
			IdleConnTimeout:       90 * time.Second,
			ResponseHeaderTimeout: 0, // streaming answers may take long to start
		},
		// Stream server-sent events and long answers as they are written.
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			p.logf("proxy: %s %s: %v", r.Method, r.URL.Path, err)
			http.Error(w, "The Omnesis gateway is not answering.", http.StatusBadGateway)
		},
	}
	return p
}

// SetPublicPaths replaces the set of paths the public address may serve.
func (p *Proxy) SetPublicPaths(paths []string) {
	c := append([]string(nil), paths...)
	p.publicPaths.Store(&c)
}

// PublicAllows reports whether the public address may serve this request
// path. Paths ending in "/" match as prefixes; any other entry matches only
// itself. A path that is not already in clean form, or that carries an
// encoded slash, is refused so no spelling can step outside an allowed prefix.
func (p *Proxy) PublicAllows(r *http.Request) bool {
	if r.URL.RawPath != "" && strings.Contains(strings.ToLower(r.URL.RawPath), "%2f") {
		return false
	}
	reqPath := r.URL.Path
	if reqPath == "" || reqPath[0] != '/' {
		return false
	}
	clean := path.Clean(reqPath)
	if clean != reqPath && clean+"/" != reqPath {
		return false
	}
	for _, allowed := range *p.publicPaths.Load() {
		if strings.HasSuffix(allowed, "/") {
			if strings.HasPrefix(reqPath, allowed) {
				return true
			}
			continue
		}
		if reqPath == allowed {
			return true
		}
	}
	return false
}

// Tailnet returns the handler for connections from tailnet devices.
func (p *Proxy) Tailnet() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		caller := identity.Caller{Via: identity.ViaTailnet, Client: r.RemoteAddr}
		peer, err := p.resolver.Resolve(r.Context(), r.RemoteAddr)
		if err != nil {
			// An unidentified caller still reaches the gateway, which then
			// treats it as an ordinary client that must authenticate.
			p.logf("proxy: identify %s: %v", r.RemoteAddr, err)
		} else {
			caller.Peer = peer
		}
		p.forward(w, r, caller)
	})
}

// Public returns the handler for connections through the public address.
// Requests are forwarded as addressed to host(), so a caller on the Internet
// cannot choose which of the gateway's names it is talking to.
func (p *Proxy) Public(host func() string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !p.PublicAllows(r) {
			http.NotFound(w, r)
			return
		}
		h := host()
		if h == "" {
			http.Error(w, "The Omnesis gateway is not ready.", http.StatusServiceUnavailable)
			return
		}
		r.Host = h
		client, _ := r.Context().Value(clientKey{}).(string)
		if client == "" {
			client = r.RemoteAddr
		}
		p.forward(w, r, identity.Caller{Via: identity.ViaPublic, Client: client})
	})
}

func (p *Proxy) forward(w http.ResponseWriter, r *http.Request, caller identity.Caller) {
	identity.StripOwned(r.Header)
	r.Header.Set(identity.Header, identity.Encode(caller))
	p.upstream.ServeHTTP(w, r)
}

// RedirectToHTTPS sends plain-HTTP tailnet visitors to the HTTPS address.
func RedirectToHTTPS(host func() string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := host()
		if h == "" {
			h = r.Host
		}
		target := url.URL{Scheme: "https", Host: h, Path: r.URL.Path, RawQuery: r.URL.RawQuery}
		http.Redirect(w, r, target.String(), http.StatusPermanentRedirect)
	})
}
