// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Package node runs the gateway's own tailnet device: it signs in, serves the
// tailnet and public addresses through the proxy, and reports its state.
package node

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/tsnet"

	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/certs"
	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/identity"
	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/protocol"
	"github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/proxy"
)

// Config is everything the node needs from the command line.
type Config struct {
	StateDir   string
	Hostname   string
	ControlURL string
	SocketPath string
    SocketCertificateSHA256 string
    SocketToken string
	Fallback   *certs.Fallback
	Logf       func(string, ...any)
	// Emit receives every distinct status.
	Emit func(protocol.Status)
}

// Node owns the tsnet server and the listeners in front of the proxy.
type Node struct {
	cfg   Config
	srv   *tsnet.Server
	lc    *local.Client
	proxy *proxy.Proxy

	mu          sync.Mutex
	backend     string
	loginURL    string
	selfUserID  string
	owner       *protocol.Owner
	dnsName     string
	tailnet     string
	ips         []string
	certDomains []string
	magicDNS    bool
	certState   protocol.CertificateStatus
	certFetch   bool // a fetch of the Tailscale certificate is in flight
	certRetryAt time.Time
	public      protocol.PublicStatus
	wantPublic  bool
	enableURL   string
	lastEmitted string
	loginAsked  bool

	tailnetServing bool
	staleCleared   bool
	funnelSrv      *http.Server
	servers        []*http.Server
	kick           chan struct{}
}

// New prepares a node; Run starts it.
func New(cfg Config) *Node {
	n := &Node{
		cfg:       cfg,
		backend:   protocol.BackendStarting,
		certState: protocol.CertificateStatus{Source: protocol.CertificateGateway, Reason: protocol.CertificateReasonPending},
		public:    protocol.PublicStatus{State: protocol.PublicOff},
		kick:      make(chan struct{}, 1),
	}
	n.srv = &tsnet.Server{
		Dir:        cfg.StateDir,
		Hostname:   cfg.Hostname,
		ControlURL: cfg.ControlURL,
		// Backend chatter is noise for the gateway's log. tsnet's user-facing
		// lines repeat the sign-in link, which must not reach any log: whoever
		// opens it first chooses the tailnet this device joins. The gateway
		// learns the link from the status instead.
		Logf:     func(string, ...any) {},
		UserLogf: func(string, ...any) {},
	}
	n.proxy = proxy.NewEndpoint(proxy.Endpoint{Path: cfg.SocketPath, CertificateSHA256: cfg.SocketCertificateSHA256, Token: cfg.SocketToken}, resolver{n}, cfg.Logf)
	return n
}

// Start brings up the Tailscale backend. Commands may be given once it returns.
func (n *Node) Start() error {
	if err := n.srv.Start(); err != nil {
		return err
	}
	lc, err := n.srv.LocalClient()
	if err != nil {
		n.srv.Close()
		return err
	}
	n.lc = lc
	return nil
}

// Run serves the started node and blocks until ctx ends.
func (n *Node) Run(ctx context.Context) error {
	defer n.shutdown()
	lc := n.lc
	watcher, err := lc.WatchIPNBus(ctx, ipn.NotifyInitialState)
	if err != nil {
		return err
	}
	defer watcher.Close()
	notes := make(chan ipn.Notify, 16)
	go func() {
		defer close(notes)
		for {
			note, err := watcher.Next()
			if err != nil {
				return
			}
			notes <- note
		}
	}()
	tick := time.NewTicker(10 * time.Second)
	defer tick.Stop()
	n.emit()
	for {
		select {
		case <-ctx.Done():
			return nil
		case note, ok := <-notes:
			if !ok {
				if ctx.Err() != nil {
					return nil
				}
				return errors.New("tailscale backend stopped")
			}
			n.applyNotify(note)
		case <-n.kick:
		case <-tick.C:
		}
		n.reconcile(ctx)
		n.emit()
	}
}

// Configure applies the gateway's wish for the public address.
func (n *Node) Configure(cfg protocol.PublicConfig) {
	n.mu.Lock()
	n.wantPublic = cfg.Enabled
	n.mu.Unlock()
	n.proxy.SetPublicPaths(cfg.Paths)
	n.poke()
}

// Login asks Tailscale for a fresh sign-in link.
func (n *Node) Login(ctx context.Context) error {
	n.mu.Lock()
	n.loginURL = ""
	n.loginAsked = true
	n.mu.Unlock()
	defer n.poke()
	return n.startSignIn(ctx)
}

// startSignIn asks Tailscale for a fresh sign-in link. Signing out resets the
// device's preferences, so a sign-in after it would go to Tailscale's default
// coordination server under the machine's own hostname; what tsnet applies
// at start is applied again first.
func (n *Node) startSignIn(ctx context.Context) error {
	prefs := ipn.NewPrefs()
	prefs.Hostname = n.cfg.Hostname
	prefs.WantRunning = true
	prefs.ControlURL = n.cfg.ControlURL
	if prefs.ControlURL == "" {
		prefs.ControlURL = ipn.DefaultControlURL
	}
	if err := n.lc.Start(ctx, ipn.Options{UpdatePrefs: prefs}); err != nil {
		return err
	}
	return n.lc.StartLoginInteractive(ctx)
}

// Logout signs the device out of the tailnet.
func (n *Node) Logout(ctx context.Context) error {
	n.closeFunnel()
	n.mu.Lock()
	n.loginURL = ""
	n.loginAsked = false
	n.mu.Unlock()
	defer n.poke()
	return n.lc.Logout(ctx)
}

func (n *Node) poke() {
	select {
	case n.kick <- struct{}{}:
	default:
	}
}

func (n *Node) applyNotify(note ipn.Notify) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if note.BrowseToURL != nil && *note.BrowseToURL != "" {
		n.loginURL = *note.BrowseToURL
	}
	if note.State != nil {
		switch *note.State {
		case ipn.NeedsLogin:
			n.backend = protocol.BackendNeedsLogin
		case ipn.NeedsMachineAuth:
			n.backend = protocol.BackendNeedsApproval
			n.loginURL = ""
		case ipn.Running:
			n.backend = protocol.BackendRunning
			n.loginURL = ""
			n.loginAsked = false
		case ipn.Stopped:
			n.backend = protocol.BackendStopped
		default:
			n.backend = protocol.BackendStarting
		}
	}
}

// reconcile brings listeners, certificate and public address in line with the
// latest Tailscale state and the gateway's wishes.
func (n *Node) reconcile(ctx context.Context) {
	n.mu.Lock()
	backend := n.backend
	needLogin := backend == protocol.BackendNeedsLogin && n.loginURL == "" && !n.loginAsked
	if needLogin {
		n.loginAsked = true
	}
	n.mu.Unlock()
	if needLogin {
		if err := n.startSignIn(ctx); err != nil {
			n.cfg.Logf("tailnet: start sign-in: %v", err)
		}
	}
	if backend != protocol.BackendRunning {
		n.closeFunnel()
		n.mu.Lock()
		if n.wantPublic {
			n.public = protocol.PublicStatus{State: protocol.PublicUnavailable, Reason: "not-signed-in"}
		} else {
			n.public = protocol.PublicStatus{State: protocol.PublicOff}
		}
		n.mu.Unlock()
		return
	}
	n.mu.Lock()
	clearStale := !n.staleCleared
	n.mu.Unlock()
	if clearStale && n.ClearStalePublicAccess(ctx) {
		n.mu.Lock()
		n.staleCleared = true
		n.mu.Unlock()
	}
	n.refreshSelf(ctx)
	n.ensureTailnetListeners()
	n.reconcileCertificate(ctx)
	n.reconcilePublic(ctx)
}

func (n *Node) refreshSelf(ctx context.Context) {
	st, err := n.lc.StatusWithoutPeers(ctx)
	if err != nil || st.Self == nil {
		return
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	n.selfUserID = strconv.FormatInt(int64(st.Self.UserID), 10)
	n.dnsName = strings.TrimSuffix(st.Self.DNSName, ".")
	n.certDomains = slices.Clone(st.CertDomains)
	n.magicDNS = st.CurrentTailnet != nil && st.CurrentTailnet.MagicDNSEnabled
	if st.CurrentTailnet != nil {
		n.tailnet = strings.TrimSuffix(st.CurrentTailnet.MagicDNSSuffix, ".")
	}
	n.ips = n.ips[:0]
	for _, ip := range st.Self.TailscaleIPs {
		n.ips = append(n.ips, ip.String())
	}
	if profile, ok := st.User[st.Self.UserID]; ok {
		n.owner = &protocol.Owner{ID: n.selfUserID, Login: profile.LoginName, DisplayName: profile.DisplayName}
	} else {
		n.owner = &protocol.Owner{ID: n.selfUserID}
	}
}

// trustedName reports whether Tailscale can issue a certificate for name.
func (n *Node) trustedName(name string) bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return name != "" && n.certState.Source == protocol.CertificateTailscale && slices.Contains(n.certDomains, name)
}

// tailnetTLS presents the Tailscale certificate to visitors who ask for the
// tailnet name once it is ready, and the gateway's own certificate otherwise
// (an address typed as an IP, or a tailnet without HTTPS certificates).
func (n *Node) tailnetTLS() *tls.Config {
	return &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetCertificate: func(hi *tls.ClientHelloInfo) (*tls.Certificate, error) {
			if n.trustedName(strings.ToLower(hi.ServerName)) {
				return n.lc.GetCertificate(hi)
			}
			return n.cfg.Fallback.Certificate()
		},
	}
}

func (n *Node) ensureTailnetListeners() {
	n.mu.Lock()
	if n.tailnetServing {
		n.mu.Unlock()
		return
	}
	n.tailnetServing = true
	n.mu.Unlock()
	ln443, err := n.srv.Listen("tcp", ":443")
	if err != nil {
		n.cfg.Logf("tailnet: listen 443: %v", err)
		n.mu.Lock()
		n.tailnetServing = false
		n.mu.Unlock()
		return
	}
	n.track(n.serve(tls.NewListener(ln443, n.tailnetTLS()), n.proxy.Tailnet(), nil))
	if ln80, err := n.srv.Listen("tcp", ":80"); err == nil {
		n.track(n.serve(ln80, proxy.RedirectToHTTPS(n.publicHost), nil))
	}
}

// track keeps a tailnet server for shutdown.
func (n *Node) track(s *http.Server) {
	n.mu.Lock()
	n.servers = append(n.servers, s)
	n.mu.Unlock()
}

// serve answers connections on ln with h until the node shuts down.
func (n *Node) serve(ln net.Listener, h http.Handler, connCtx func(context.Context, net.Conn) context.Context) *http.Server {
	s := &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 20 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ConnContext:       connCtx,
		ErrorLog:          nil,
	}
	go func() {
		if err := s.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
			n.cfg.Logf("tailnet: serve: %v", err)
		}
	}()
	return s
}

func (n *Node) reconcileCertificate(ctx context.Context) {
	n.mu.Lock()
	switch {
	case !n.magicDNS:
		n.certState = protocol.CertificateStatus{Source: protocol.CertificateGateway, Reason: protocol.CertificateReasonMagicDNSDisabled}
		n.mu.Unlock()
		return
	case !slices.Contains(n.certDomains, n.dnsName):
		n.certState = protocol.CertificateStatus{Source: protocol.CertificateGateway, Reason: protocol.CertificateReasonHTTPSDisabled}
		n.mu.Unlock()
		return
	case n.certState.Source == protocol.CertificateTailscale || n.certFetch || time.Now().Before(n.certRetryAt):
		n.mu.Unlock()
		return
	}
	n.certFetch = true
	n.certState = protocol.CertificateStatus{Source: protocol.CertificateGateway, Reason: protocol.CertificateReasonPending}
	domain := n.dnsName
	n.mu.Unlock()
	// The first certificate can take a while: Tailscale obtains it from a
	// public certificate authority on the device's behalf.
	go func() {
		fetchCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
		defer cancel()
		_, _, err := n.lc.CertPair(fetchCtx, domain)
		n.mu.Lock()
		n.certFetch = false
		if err != nil {
			n.certState = protocol.CertificateStatus{Source: protocol.CertificateGateway, Reason: protocol.CertificateReasonFailed, Error: err.Error()}
			n.certRetryAt = time.Now().Add(5 * time.Minute)
		} else {
			n.certState = protocol.CertificateStatus{Source: protocol.CertificateTailscale}
		}
		n.mu.Unlock()
		n.poke()
	}()
}

func (n *Node) reconcilePublic(ctx context.Context) {
	n.mu.Lock()
	want := n.wantPublic
	open := n.funnelSrv != nil
	certReady := n.certState.Source == protocol.CertificateTailscale
	certReason := n.certState.Reason
	dnsName := n.dnsName
	staleCleared := n.staleCleared
	n.mu.Unlock()

	if !want {
		n.closeFunnel()
		n.setPublic(protocol.PublicStatus{State: protocol.PublicOff})
		return
	}
	if open {
		n.setPublic(protocol.PublicStatus{State: protocol.PublicOn, URL: "https://" + dnsName})
		return
	}
	// Opening before a previous run's entry is known to be gone would let the
	// retried cleanup remove this run's own entry and leave a dead address.
	if !staleCleared {
		n.setPublic(protocol.PublicStatus{State: protocol.PublicStarting})
		return
	}
	if !certReady {
		if certReason == protocol.CertificateReasonPending {
			n.setPublic(protocol.PublicStatus{State: protocol.PublicStarting})
		} else {
			n.setPublic(protocol.PublicStatus{State: protocol.PublicUnavailable, Reason: certReason})
		}
		return
	}
	st, err := n.lc.StatusWithoutPeers(ctx)
	if err != nil || st.Self == nil {
		return
	}
	if err := ipn.CheckFunnelAccess(443, st.Self); err != nil {
		n.setPublic(protocol.PublicStatus{State: protocol.PublicNeedsEnable, EnableURL: n.funnelEnableURL(ctx), Reason: err.Error()})
		return
	}
	n.mu.Lock()
	n.enableURL = ""
	n.mu.Unlock()
	ln, err := n.srv.ListenFunnel("tcp", ":443", tsnet.FunnelOnly(), tsnet.FunnelTLSConfig(&tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: n.lc.GetCertificate,
	}))
	if err != nil {
		n.setPublic(protocol.PublicStatus{State: protocol.PublicUnavailable, Reason: err.Error()})
		return
	}
	srv := n.serve(ln, n.proxy.Public(n.publicHost), func(c context.Context, conn net.Conn) context.Context {
		if tc, ok := conn.(*tls.Conn); ok {
			conn = tc.NetConn()
		}
		if fc, ok := conn.(*ipn.FunnelConn); ok {
			return proxy.WithClient(c, fc.Src.String())
		}
		return c
	})
	n.mu.Lock()
	n.funnelSrv = srv
	n.mu.Unlock()
	n.setPublic(protocol.PublicStatus{State: protocol.PublicOn, URL: "https://" + dnsName})
}

// funnelEnableURL asks Tailscale for the page where the account owner allows
// public access for this device. The answer is cached until access is granted.
func (n *Node) funnelEnableURL(ctx context.Context) string {
	n.mu.Lock()
	cached := n.enableURL
	n.mu.Unlock()
	if cached != "" {
		return cached
	}
	qctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	res, err := n.lc.QueryFeature(qctx, "funnel")
	if err != nil || res == nil {
		return ""
	}
	n.mu.Lock()
	n.enableURL = res.URL
	n.mu.Unlock()
	return res.URL
}

func (n *Node) setPublic(p protocol.PublicStatus) {
	n.mu.Lock()
	n.public = p
	n.mu.Unlock()
}

func (n *Node) closeFunnel() {
	n.mu.Lock()
	srv := n.funnelSrv
	n.funnelSrv = nil
	n.mu.Unlock()
	if srv != nil {
		// Closing the listener removes this device's public-access entry from
		// Tailscale; closing the server also cuts connections still open, so
		// a stream that began while the address was public does not outlive it.
		srv.Close()
	}
}

// ClearStalePublicAccess removes any public-access entry a previous run left
// behind, so the public address is never open unless this run opened it. It
// reports whether the entry is known to be gone; otherwise it is tried again.
func (n *Node) ClearStalePublicAccess(ctx context.Context) bool {
	sc, err := n.lc.GetServeConfig(ctx)
	if err != nil {
		return false
	}
	if sc == nil || len(sc.AllowFunnel) == 0 {
		return true
	}
	sc.AllowFunnel = nil
	if err := n.lc.SetServeConfig(ctx, sc); err != nil {
		n.cfg.Logf("tailnet: clear previous public access: %v", err)
		return false
	}
	return true
}

// publicHost is the device's own name: the host the public address forwards
// requests as, whatever Host header the caller sent, and where plain-HTTP
// visitors are redirected.
func (n *Node) publicHost() string {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.dnsName
}

func (n *Node) shutdown() {
	n.closeFunnel()
	n.mu.Lock()
	servers := n.servers
	n.servers = nil
	n.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for _, s := range servers {
		s.Shutdown(ctx)
	}
	n.srv.Close()
}

// Snapshot returns the current status.
func (n *Node) Snapshot() protocol.Status {
	n.mu.Lock()
	defer n.mu.Unlock()
	st := protocol.Status{
		Type:        "status",
		Protocol:    protocol.Version,
		Backend:     n.backend,
		Certificate: n.certState,
		Public:      n.public,
	}
	if n.backend == protocol.BackendNeedsLogin {
		st.LoginURL = n.loginURL
	}
	if n.backend == protocol.BackendRunning && n.dnsName != "" {
		st.Node = &protocol.NodeStatus{DNSName: n.dnsName, HostName: strings.SplitN(n.dnsName, ".", 2)[0], Tailnet: n.tailnet, IPs: slices.Clone(n.ips)}
		if n.owner != nil {
			o := *n.owner
			st.Owner = &o
		}
	}
	return st
}

func (n *Node) emit() {
	st := n.Snapshot()
	b, _ := json.Marshal(st)
	n.mu.Lock()
	same := string(b) == n.lastEmitted
	n.lastEmitted = string(b)
	n.mu.Unlock()
	if !same {
		n.cfg.Emit(st)
	}
}

// resolver adapts Tailscale's WhoIs to the proxy's needs.
type resolver struct{ n *Node }

func (r resolver) Resolve(ctx context.Context, remoteAddr string) (*identity.Peer, error) {
	who, err := r.n.lc.WhoIs(ctx, remoteAddr)
	if err != nil {
		return nil, err
	}
	if who.Node == nil {
		return nil, errors.New("no device for address")
	}
	r.n.mu.Lock()
	self := r.n.selfUserID
	r.n.mu.Unlock()
	userID := strconv.FormatInt(int64(who.Node.User), 10)
	peer := &identity.Peer{
		NodeID:   string(who.Node.StableID),
		NodeName: who.Node.ComputedName,
		UserID:   userID,
		Tags:     slices.Clone(who.Node.Tags),
	}
	if who.Node.Hostinfo.Valid() {
		peer.OS = who.Node.Hostinfo.OS()
	}
	if who.UserProfile != nil {
		peer.Login = who.UserProfile.LoginName
		peer.UserName = who.UserProfile.DisplayName
	}
	peer.SameOwner = identity.SameOwner(self, userID, who.Node.IsTagged())
	return peer, nil
}
