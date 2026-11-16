// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package portablecontrol

import (
 "context"
 "crypto/ecdsa"
 "crypto/elliptic"
 "crypto/rand"
 "crypto/x509"
 "crypto/x509/pkix"
 "encoding/pem"
 "math/big"
 "net/http/httptest"
 "os"
 "path/filepath"
 "strings"
 "testing"
 "time"

 productnode "github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/node"
 "github.com/omnesis-dev/omnesis/packages/tailnet-helper/internal/protocol"
 "tailscale.com/envknob"
 "tailscale.com/logtail"
 "tailscale.com/net/netns"
 "tailscale.com/tailcfg"
 "tailscale.com/tstest/integration"
 "tailscale.com/tstest/integration/testcontrol"
)

// Exercise the actual product actor and its notification/reconciliation loop,
// including the valid immediate logout/login command sequence. A passing raw
// SDK experiment alone does not prove this production path has been fixed.
func TestActualProductNodeSignInRestartAndImmediateRelogin(t *testing.T) {
 envknob.SetNoLogsNoSupport()
 logtail.Disable()
 netns.SetEnabled(false)
 t.Cleanup(func() { netns.SetEnabled(true) })
 discard := func(string, ...any) {}
 control := &testcontrol.Server{
  DERPMap:integration.RunDERPAndSTUN(t, discard, "127.0.0.1"),
  DNSConfig:&tailcfg.DNSConfig{Proxied:true},
  MagicDNSDomain:"fixture.example.test", RequireAuth:true, Logf:discard,
 }
 mapsWithoutCertificates(t, control)
 control.HTTPTestServer = httptest.NewServer(control)
 t.Cleanup(control.HTTPTestServer.Close)
 ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
 defer cancel()
 directory, err := os.MkdirTemp("", "product node fixture-")
 if err != nil { t.Fatal(err) }
 retain := false
 t.Cleanup(func() {
  if !retain { if err := os.RemoveAll(directory); err != nil { t.Error(err) } }
 })
 private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
 if err != nil { t.Fatal(err) }
 template := &x509.Certificate{
  SerialNumber:big.NewInt(1), Subject:pkix.Name{CommonName:"fixture gateway"},
  DNSNames:[]string{"localhost", "fixture-product-node.fixture.example.test"},
  NotBefore:time.Now().Add(-time.Minute), NotAfter:time.Now().Add(time.Hour),
  KeyUsage:x509.KeyUsageDigitalSignature, ExtKeyUsage:[]x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
 }
 cert, err := x509.CreateCertificate(rand.Reader, template, template, &private.PublicKey, private)
 if err != nil { t.Fatal(err) }
 key, err := x509.MarshalPKCS8PrivateKey(private)
 if err != nil { t.Fatal(err) }
 pair := protocol.GatewayCertificate{
  Cert:string(pem.EncodeToMemory(&pem.Block{Type:"CERTIFICATE",Bytes:cert})),
  Key:string(pem.EncodeToMemory(&pem.Block{Type:"PRIVATE KEY",Bytes:key})),
 }
 start := func() (*productnode.Node, func()) {
  node := productnode.New(productnode.Config{
   StateDir:filepath.Join(directory,"node state"), Hostname:"fixture-product-node",
   ControlURL:control.HTTPTestServer.URL, Logf:discard, Emit:func(protocol.Status){},
  })
  if err := node.SetGatewayCertificate(pair); err != nil { t.Fatal(err) }
  if err := node.Start(); err != nil { retain=true; t.Fatal(err) }
  running, stop := context.WithCancel(ctx)
  done := make(chan error,1)
  go func() { done <- node.Run(running) }()
  closed := false
  closeNode := func() {
   if closed { return }
   stop()
   select {
   case err := <-done:
    closed=true
    if err != nil { retain=true; t.Errorf("product loop close: %v",err) }
   case <-time.After(15*time.Second):
    retain=true
    t.Error("product loop closure is unconfirmed; inputs retained")
   }
  }
  t.Cleanup(closeNode)
  return node, closeNode
 }
 until := func(node *productnode.Node, label string, ready func(protocol.Status)bool) protocol.Status {
  tick := time.NewTicker(20*time.Millisecond)
  defer tick.Stop()
  for {
   state := node.Snapshot()
   if ready(state) { return state }
   select { case <-ctx.Done(): t.Fatalf("%s: last backend=%s linkPresent=%t",label,state.Backend,state.LoginURL!=""); case <-tick.C: }
  }
 }
 approve := func(url string) {
  if !strings.HasPrefix(url,control.HTTPTestServer.URL+"/auth/") { t.Fatal("product sign-in escaped the local control server") }
  if !control.CompleteAuth(url) { t.Fatal("product sign-in approval was refused") }
 }
 connected := func(state protocol.Status)bool {
  return state.Backend==protocol.BackendRunning && state.Node!=nil && state.Node.DNSName!="" && state.Owner!=nil && state.Owner.ID!=""
 }
 first, closeFirst := start()
 waiting := until(first,"initial product sign-in",func(state protocol.Status)bool { return state.Backend==protocol.BackendNeedsLogin && state.LoginURL!="" })
 approve(waiting.LoginURL)
 original := until(first,"initial product connection",connected)
 t.Log("actual product actor signed in")
 closeFirst()
 second, _ := start()
 restarted := until(second,"persisted product restart",connected)
 if restarted.Owner.ID!=original.Owner.ID || restarted.Node.DNSName!=original.Node.DNSName { t.Fatal("product restart changed its approved identity") }
 t.Log("actual product actor restored persisted approval")
 if err := second.Logout(ctx); err != nil { t.Fatal(err) }
 // This is a supported pair of sequential helper commands, even when the
 // background reconcile loop concurrently observes the logged-out profile.
 if err := second.Login(ctx); err != nil { t.Fatal(err) }
 fresh := until(second,"product re-login URL",func(state protocol.Status)bool { return state.Backend==protocol.BackendNeedsLogin && state.LoginURL!="" && state.LoginURL!=waiting.LoginURL })
 if fresh.Node!=nil || fresh.Owner!=nil { t.Fatal("signed-out product advertised a connected identity") }
 approve(fresh.LoginURL)
 until(second,"product rejoined after logout",func(state protocol.Status)bool { return connected(state) && state.Owner.ID!=original.Owner.ID })
 t.Log("actual product actor rejoined with a newly approved identity")
}
