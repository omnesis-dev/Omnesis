// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package portablecontrol

import (
 "context"
 "net/http/httptest"
 "strings"
 "testing"
 "time"

 "tailscale.com/envknob"
 "tailscale.com/ipn"
 "tailscale.com/logtail"
 "tailscale.com/net/netns"
 "tailscale.com/tailcfg"
 "tailscale.com/tsnet"
 "tailscale.com/tstest/integration"
 "tailscale.com/tstest/integration/testcontrol"
)

func TestInteractiveAuthPersistentRestartAndSignOut(t *testing.T) {
 envknob.SetNoLogsNoSupport()
 logtail.Disable()
 netns.SetEnabled(false)
 t.Cleanup(func() { netns.SetEnabled(true) })
 discard := func(string, ...any) {}
 control := &testcontrol.Server{
  DERPMap: integration.RunDERPAndSTUN(t, discard, "127.0.0.1"),
  DNSConfig: &tailcfg.DNSConfig{Proxied:true},
  MagicDNSDomain:"fixture.example.test",
  RequireAuth:true,
  Logf:discard,
  ModifyFirstMapResponse:func(response *tailcfg.MapResponse, _ *tailcfg.MapRequest) {
   // A real tailnet can provide MagicDNS without issuing HTTPS certificates.
   if response.DNSConfig != nil { response.DNSConfig.CertDomains = nil }
  },
 }
 control.HTTPTestServer = httptest.NewServer(control)
 t.Cleanup(control.HTTPTestServer.Close)
 ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
 defer cancel()
 dir := t.TempDir()
 closed := map[*tsnet.Server]bool{}
 closeNode := func(server *tsnet.Server) {
  if closed[server] { return }
  if err := server.Close(); err != nil { t.Errorf("close: %v",err); return }
  closed[server] = true
 }
 start := func() *tsnet.Server {
  server := &tsnet.Server{Dir:dir, Hostname:"fixture-auth-gateway", ControlURL:control.HTTPTestServer.URL, Logf:discard, UserLogf:discard}
  if err := server.Start(); err != nil { t.Fatal(err) }
  t.Cleanup(func() { closeNode(server) })
  return server
 }
 loginURL := func(server *tsnet.Server) string {
  client, err := server.LocalClient()
  if err != nil { t.Fatal(err) }
  tick := time.NewTicker(20*time.Millisecond)
  defer tick.Stop()
  for {
   status, err := client.Status(ctx)
   if err == nil && status.AuthURL != "" {
    if !strings.HasPrefix(status.AuthURL, control.HTTPTestServer.URL+"/auth/") { t.Fatal("auth link escaped the local control server") }
    return status.AuthURL
   }
   select { case <-ctx.Done(): t.Fatal("no interactive sign-in link"); case <-tick.C: }
  }
 }
 first := start()
 firstURL := loginURL(first)
 if !control.CompleteAuth(firstURL) { t.Fatal("could not approve local interactive sign-in") }
 initial, err := first.Up(ctx)
 if err != nil { t.Fatal(err) }
 if initial.Self == nil || len(initial.CertDomains) != 0 || initial.CurrentTailnet == nil || !initial.CurrentTailnet.MagicDNSEnabled { t.Fatal("wrong local tailnet certificate capability") }
 closeNode(first)
 second := start()
 restarted, err := second.Up(ctx)
 if err != nil { t.Fatal(err) }
 if restarted.AuthURL != "" || restarted.Self == nil || restarted.Self.PublicKey != initial.Self.PublicKey { t.Fatal("restart lost the approved device identity") }
 client, err := second.LocalClient()
 if err != nil { t.Fatal(err) }
 if err := client.Logout(ctx); err != nil { t.Fatal(err) }
 prefs, err := client.GetPrefs(ctx)
 if err != nil { t.Fatal(err) }
 prefs.WantRunning = true
 if err := client.Start(ctx, ipn.Options{UpdatePrefs:prefs}); err != nil { t.Fatal(err) }
 if err := client.StartLoginInteractive(ctx); err != nil { t.Fatal(err) }
 nextURL := loginURL(second)
 if nextURL == firstURL { t.Fatal("sign-out reused an already approved sign-in link") }
 if !control.CompleteAuth(nextURL) { t.Fatal("could not approve sign-in after logout") }
 rejoined, err := second.Up(ctx)
 if err != nil || rejoined.Self == nil { t.Fatalf("did not rejoin: %v",err) }
}
