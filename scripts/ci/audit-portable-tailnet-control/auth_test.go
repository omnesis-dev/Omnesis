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
 runInteractiveAuth(t, false)
}

func TestMagicDNSOnlyInteractiveAuthPersistentRestartAndSignOut(t *testing.T) {
 runInteractiveAuth(t, true)
}

func runInteractiveAuth(t *testing.T, magicDNSOnly bool) {
 t.Helper()
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

 }
 // Own the map stream so later full responses cannot silently re-enable
 // HTTPS certificates after the initial MagicDNS-only response.
 if magicDNSOnly {
 control.AltMapStream = func(ctx context.Context, writer testcontrol.MapStreamWriter, request *tailcfg.MapRequest) {
  if !request.Stream { _ = writer.SendMapMessage(new(tailcfg.MapResponse)); return }
  // Preserve the SDK fixture's registration/profile identity. Hand-building
  // UserProfiles with a different LoginName can switch Windows profiles and
  // discard the persisted key while a prior netmap is still active.
  response, err := control.MapResponse(request)
  if err != nil || response == nil { t.Errorf("map response: %v", err); return }
  if response.DNSConfig != nil { response.DNSConfig.CertDomains = nil }
  if err := writer.SendMapMessage(response); err != nil { return }
  <-ctx.Done()
 }
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
 if initial.Self == nil || (magicDNSOnly && len(initial.CertDomains) != 0) || (!magicDNSOnly && len(initial.CertDomains) == 0) || initial.CurrentTailnet == nil || !initial.CurrentTailnet.MagicDNSEnabled { t.Fatalf("wrong capabilities: self=%t certificates=%d tailnet=%t magicDNS=%t", initial.Self != nil, len(initial.CertDomains), initial.CurrentTailnet != nil, initial.CurrentTailnet != nil && initial.CurrentTailnet.MagicDNSEnabled) }
 t.Logf("local sign-in capabilities accepted (HTTPS disabled=%t)", magicDNSOnly)
 closeNode(first)
 second := start()
 restarted, err := second.Up(ctx)
 if err != nil { t.Fatal(err) }
 if restarted.AuthURL != "" || restarted.Self == nil || restarted.Self.PublicKey != initial.Self.PublicKey { t.Fatal("restart lost the approved device identity") }
 t.Log("persisted restart restored the same approved node key")
 client, err := second.LocalClient()
 if err != nil { t.Fatal(err) }
 t.Log("begin sign-out")
 if err := client.Logout(ctx); err != nil { t.Fatal(err) }
 t.Log("sign-out returned; restoring explicit local coordinator")
 prefs := ipn.NewPrefs()
 prefs.Hostname = "fixture-auth-gateway"
 prefs.ControlURL = control.HTTPTestServer.URL
 // Keep data-plane reconfiguration stopped until the SDK has committed the
 // new login keys. LoginFinished is emitted before that write on Windows.
 prefs.WantRunning = false
 if err := client.Start(ctx, ipn.Options{UpdatePrefs:prefs}); err != nil { t.Fatal(err) }
 t.Log("local-client Start returned; requesting interactive login")
 if err := client.StartLoginInteractive(ctx); err != nil { t.Fatal(err) }
 t.Log("interactive login requested; waiting for local approval URL")
 nextURL := loginURL(second)
 if nextURL == firstURL { t.Fatal("sign-out reused an already approved sign-in link") }
 if !control.CompleteAuth(nextURL) { t.Fatal("could not approve sign-in after logout") }
 // Use persisted-key readiness, not a sleep or an assumed LoginFinished
 // ordering, before permitting the SDK to reconfigure the data plane.
 readyTick := time.NewTicker(20*time.Millisecond)
 defer readyTick.Stop()
 for {
  current, err := client.GetPrefs(ctx)
  if err != nil { t.Fatal(err) }
  if current.Persist != nil && current.Persist.NodeID != "" && current.Persist.UserProfile.ID != 0 { break }
  select { case <-ctx.Done(): t.Fatal("new sign-in keys were not committed"); case <-readyTick.C: }
 }
 // LocalAPI intentionally strips private keys, so use committed public
 // profile/node identity rather than waiting for a secret it never returns.
 if _, err := client.EditPrefs(ctx, &ipn.MaskedPrefs{WantRunningSet:true, Prefs:ipn.Prefs{WantRunning:true}}); err != nil { t.Fatal(err) }
 t.Log("new login keys committed before resuming the network")
 rejoined, err := second.Up(ctx)
 if err != nil || rejoined.Self == nil { t.Fatalf("did not rejoin: %v",err) }
}
