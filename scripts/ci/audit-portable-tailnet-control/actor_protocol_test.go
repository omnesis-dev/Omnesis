// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package portablecontrol

import (
 "bufio"
 "bytes"
 "context"
 "encoding/json"
 "net/netip"
 "os"
 "os/exec"
 "path/filepath"
 "runtime"
 "tailscale.com/ipn/ipnstate"
 "strings"
 "testing"
 "time"
 "tailscale.com/net/tsaddr"
)

func TestActorProtocolCreatesRealPeersAndJoins(t *testing.T) {
 directory:=t.TempDir()
 executable,err:=os.Executable()
 if err!=nil { t.Fatal(err) }
 ctx,cancel:=context.WithTimeout(context.Background(),90*time.Second)
 command:=exec.CommandContext(ctx,executable,"-test.run=^TestTailnetFixtureActor$","-test.timeout=80s")
 command.Env=append(os.Environ(),"OMNESIS_TEST_TAILNET_ROOT="+directory)
 input,err:=command.StdinPipe()
 if err!=nil { cancel();t.Fatal(err) }
 output,err:=command.StdoutPipe()
 if err!=nil { cancel();t.Fatal(err) }
 var stderr bytes.Buffer
 command.Stderr=&stderr
 if err:=command.Start();err!=nil { cancel();t.Fatal(err) }
 joined:=false
 t.Cleanup(func(){
  input.Close()
  cancel()
  if !joined { command.Wait() }
  if t.Failed() { t.Logf("actor stderr after join: %s",stderr.String()) }
 })
 scanner:=bufio.NewScanner(output)
 scanner.Buffer(make([]byte,4096),64*1024)
 read:=func(id int) map[string]string {
  for scanner.Scan() {
   line:=scanner.Text()
   if !strings.HasPrefix(line,actorPrefix) { continue }
   var response struct { ID int `json:"id"`; Value json.RawMessage `json:"value"`; Error string `json:"error"` }
   if err:=json.Unmarshal([]byte(strings.TrimPrefix(line,actorPrefix)),&response);err!=nil { t.Fatal(err) }
   if response.ID!=id || response.Error!="" { t.Fatalf("actor operation %d: %s",response.ID,response.Error) }
   if id==4 { return nil }
   var value map[string]string
   if err:=json.Unmarshal(response.Value,&value);err!=nil { t.Fatal(err) }
   return value
  }
  t.Fatalf("actor output ended: %v",scanner.Err())
  return nil
 }
 if ready:=read(0);!strings.HasPrefix(ready["controlUrl"],"http://127.0.0.1:") { t.Fatal("actor control plane is not local") }
 encoder:=json.NewEncoder(input)
 addresses:=map[netip.Addr]bool{}
 for index,role:=range []string{"owner","stranger","tagged"} {
  request:=actorRequest{ID:index+1,Op:"machine",Name:"fixture-"+role,User:role}
  if role=="tagged" { request.User="";request.Tags=[]string{"tag:fixture"} }
  if err:=encoder.Encode(request);err!=nil { t.Fatal(err) }
  value:=read(index+1)
  address,err:=netip.ParseAddr(value["address"])
  if err!=nil || !tsaddr.CGNATRange().Contains(address) || addresses[address] || value["name"]!=request.Name { t.Fatal("actor did not create a distinct real registered peer") }
  addresses[address]=true
  suffix:=""
  if runtime.GOOS=="windows" { suffix=".exe" }
  output,err:=exec.CommandContext(ctx,filepath.Join(value["binDir"],"tailscale"+suffix),"status","--json").Output()
  if err!=nil { t.Fatalf("actor peer official CLI: %v",err) }
  var actual ipnstate.Status
  if err:=json.Unmarshal(output,&actual);err!=nil { t.Fatal(err) }
  if actual.BackendState!="Running" || actual.Self==nil || actual.Self.DNSName!=request.Name+".tailnet.test." || len(actual.TailscaleIPs)==0 || actual.TailscaleIPs[0]!=address { t.Fatal("actor peer CLI differs from actual userspace identity") }
 }
 if err:=encoder.Encode(actorRequest{ID:4,Op:"stop"});err!=nil { t.Fatal(err) }
 read(4)
 for scanner.Scan() {} // Drain the Go test's final verdict before Wait closes output.
 if err:=scanner.Err();err!=nil { t.Fatal(err) }
 err=command.Wait()
 joined=true
 if err!=nil { t.Fatalf("actor did not join cleanly: %v; %s",err,stderr.String()) }
 t.Log("three real peer registrations and actor shutdown confirmed through the bounded protocol")
}
