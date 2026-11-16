// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package portablecontrol

import (
 "context"
 "encoding/json"
 "io"
 "net/http"
 "net/http/httptest"
 "os"
 "os/exec"
 "path/filepath"
 "runtime"
 "testing"
 "time"

 "tailscale.com/envknob"
 "tailscale.com/ipn/ipnstate"
 "tailscale.com/logtail"
 "tailscale.com/net/netns"
 "tailscale.com/tailcfg"
 "tailscale.com/tsnet"
 "tailscale.com/tstest/integration"
 "tailscale.com/tstest/integration/testcontrol"
)

// This uses the official pinned CLI against the actual tsnet LocalAPI. The
// private socket only adapts transports; no status/identity JSON is invented.
func TestOfficialCLIThroughPrivateLocalAPI(t *testing.T) {
 envknob.SetNoLogsNoSupport()
 logtail.Disable()
 netns.SetEnabled(false)
 t.Cleanup(func() { netns.SetEnabled(true) })
 discard := func(string, ...any) {}
 control := &testcontrol.Server{
  DERPMap: integration.RunDERPAndSTUN(t, discard, "127.0.0.1"),
  DNSConfig: &tailcfg.DNSConfig{Proxied:true},
  MagicDNSDomain:"tailnet.test", Logf:discard,
 }
 mapsWithoutCertificates(t, control)
 control.HTTPTestServer=httptest.NewServer(control)
 t.Cleanup(control.HTTPTestServer.Close)
 ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
 defer cancel()
 node := &tsnet.Server{Dir:t.TempDir(), Hostname:"fixture-cli-laptop", ControlURL:control.HTTPTestServer.URL, Logf:discard, UserLogf:discard}
 t.Cleanup(func() { if err := node.Close(); err != nil { t.Error(err) } })
 status, err := node.Up(ctx)
 if err != nil { t.Fatal(err) }
 addr, _, _, err := node.Loopback()
 if err != nil { t.Fatal(err) }
 // Knowing the loopback port is insufficient to access this privileged API.
 req, err := http.NewRequestWithContext(ctx,"GET","http://"+addr+"/localapi/v0/status",nil)
 if err != nil { t.Fatal(err) }
 response, err := http.DefaultClient.Do(req)
 if err != nil { t.Fatal(err) }
 io.Copy(io.Discard,response.Body)
 response.Body.Close()
 if response.StatusCode!=http.StatusForbidden { t.Fatalf("uncredentialed API returned %d",response.StatusCode) }
 socket,err:=serveFixtureLocalAPI(t,node,t.TempDir())
 if err!=nil { t.Fatal(err) }
 suffix:=""
 if runtime.GOOS=="windows" { suffix=".exe" }
 cli:=filepath.Join(os.Getenv("PORTABLE_TAILSCALE_CLI_DIR"),"tailscale"+suffix)
 command:=exec.CommandContext(ctx,cli,"--socket="+socket,"status","--json")
 var actual ipnstate.Status
 output,err:=command.Output()
 if err!=nil { t.Fatalf("actual CLI: %v",err) }
 if err:=json.Unmarshal(output,&actual);err!=nil { t.Fatal(err) }
 if actual.BackendState!="Running" || actual.Self==nil || actual.Self.ID!=status.Self.ID || actual.Self.DNSName!="fixture-cli-laptop.tailnet.test." { t.Fatal("official CLI did not read the actual approved node") }
 wrapper,err:=makeFixtureCLI(filepath.Join(t.TempDir(),"literal paths 雪"),socket,cli)
 if err!=nil { t.Fatal(err) }
 wrappedOutput,err:=exec.CommandContext(ctx,wrapper,"status","--json").Output()
 if err!=nil { t.Fatalf("compiled fixture CLI adapter: %v",err) }
 var wrapped ipnstate.Status
 if err:=json.Unmarshal(wrappedOutput,&wrapped);err!=nil { t.Fatal(err) }
 if wrapped.BackendState!="Running" || wrapped.Self==nil || wrapped.Self.ID!=actual.Self.ID || wrapped.Self.DNSName!=actual.Self.DNSName { t.Fatal("compiled adapter did not preserve the official CLI identity") }
 t.Log("official pinned CLI read real userspace identity through a private OS socket")
}
