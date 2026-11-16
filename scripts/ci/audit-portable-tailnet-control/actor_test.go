// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package portablecontrol

import (
 "bufio"
 "bytes"
 "context"
 "encoding/json"
 "fmt"
 "io"
 "net/http/httptest"
 "os"
 "path/filepath"
 "regexp"
 "runtime"
 "strings"
 "testing"
 "time"

 "tailscale.com/envknob"
 "tailscale.com/logtail"
 "tailscale.com/net/netns"
 "tailscale.com/tailcfg"
 "tailscale.com/tsnet"
 "tailscale.com/tstest/integration"
 "tailscale.com/tstest/integration/testcontrol"
 "tailscale.com/types/key"
)

type actorRequest struct {
 ID int `json:"id"`
 Op string `json:"op"`
 Name string `json:"name,omitempty"`
 User string `json:"user,omitempty"`
 Tags []string `json:"tags,omitempty"`
 URL string `json:"url,omitempty"`
}
type actorPeer struct { server *tsnet.Server; key key.NodePublic; owner bool; tags []string }
const actorPrefix="OMNESIS_TAILNET_FIXTURE "

func actorReply(id int, value any, err error) {
 response:=map[string]any{"id":id}
 if err!=nil { response["error"]=err.Error() } else { response["value"]=value }
 encoded,marshalErr:=json.Marshal(response)
 if marshalErr!=nil { panic(marshalErr) }
 fmt.Fprintln(os.Stdout,actorPrefix+string(encoded))
}

// A normal Go test owns the SDK's real testing.T and its DERP/STUN cleanup.
// The external E2E owner holds this process and its input directory until the
// test exits. EOF and an explicit stop both unwind every registered resource.
func TestTailnetFixtureActor(t *testing.T) {
 directory:=os.Getenv("OMNESIS_TEST_TAILNET_ROOT")
 if directory=="" { t.Skip("the external tailnet E2E actor was not requested") }
 if !filepath.IsAbs(directory) { t.Fatal("actor directory must be absolute") }
 envknob.SetNoLogsNoSupport()
 logtail.Disable()
 netns.SetEnabled(false)
 t.Cleanup(func(){netns.SetEnabled(true)})
 discard:=func(string,...any){}
 control:=&testcontrol.Server{
  DERPMap:integration.RunDERPAndSTUN(t,discard,"127.0.0.1"),
  DNSConfig:&tailcfg.DNSConfig{Proxied:true}, MagicDNSDomain:"tailnet.test",
  RequireAuth:true,Logf:discard,
 }
 mapsWithoutCertificates(t,control)
 control.HTTPTestServer=httptest.NewServer(control)
 t.Cleanup(control.HTTPTestServer.Close)
 peers:=map[string]*actorPeer{}
 validName:=regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
 var ownerID tailcfg.UserID
 assignOwner:=func(userID tailcfg.UserID) error {
  for _,peer:=range peers {
   if !peer.owner { continue }
   current:=control.Node(peer.key)
   if current==nil { return fmt.Errorf("missing registered fixture peer") }
   current.User=userID
   current.Tags=peer.tags
   control.UpdateNode(current)
  }
  ownerID=userID
  return nil
 }
 actorReply(0,map[string]string{"controlUrl":control.HTTPTestServer.URL},nil)
 scanner:=bufio.NewScanner(os.Stdin)
 scanner.Buffer(make([]byte,4096),64*1024)
 for scanner.Scan() {
  var request actorRequest
  decoder:=json.NewDecoder(bytes.NewReader(scanner.Bytes()))
  decoder.DisallowUnknownFields()
  if err:=decoder.Decode(&request);err!=nil { t.Fatalf("invalid actor request: %v",err) }
  if err:=decoder.Decode(new(any));err!=io.EOF { t.Fatal("actor request has trailing data") }
  ctx,cancel:=context.WithTimeout(context.Background(),60*time.Second)
  value,err:=func()(any,error){
   switch request.Op {
   case "stop": return true,nil
   case "approve":
    if request.User!="owner" || !strings.HasPrefix(request.URL,control.HTTPTestServer.URL+"/auth/") { return nil,fmt.Errorf("invalid local fixture approval") }
    if !control.CompleteAuth(request.URL) { return nil,fmt.Errorf("fixture approval refused") }
    tick:=time.NewTicker(20*time.Millisecond)
    defer tick.Stop()
    for {
     for _,node:=range control.AllNodes() {
      if node.Hostinfo.Hostname()!="omnesis" || (!node.KeyExpiry.IsZero() && node.KeyExpiry.Before(time.Now())) { continue }
      if err:=assignOwner(node.User);err!=nil { return nil,err }
      response,err:=control.MapResponse(&tailcfg.MapRequest{NodeKey:node.Key})
      if err!=nil { return nil,err }
      for _,profile:=range response.UserProfiles {
       if profile.ID==node.User && profile.LoginName!="" { return map[string]string{"ownerLogin":profile.LoginName},nil }
      }
      return nil,fmt.Errorf("approved gateway has no actual owner profile")
     }
     select { case <-ctx.Done(): return nil,ctx.Err();case <-tick.C: }
    }
   case "machine":
    if !validName.MatchString(request.Name) || peers[request.Name]!=nil { return nil,fmt.Errorf("invalid or duplicate peer name") }
    if (request.User!="owner" && request.User!="stranger") && len(request.Tags)==0 { return nil,fmt.Errorf("invalid peer role") }
    for _,tag:=range request.Tags { if !regexp.MustCompile(`^tag:[a-z][a-z0-9-]*$`).MatchString(tag) { return nil,fmt.Errorf("invalid peer tag") } }
    peer:=&tsnet.Server{Dir:filepath.Join(directory,"machines",request.Name,"state"),Hostname:request.Name,ControlURL:control.HTTPTestServer.URL,Logf:discard,UserLogf:discard}
    if err:=peer.Start();err!=nil { return nil,err }
    t.Cleanup(func(){if err:=peer.Close();err!=nil { t.Error(err) }})
    client,err:=peer.LocalClient()
    if err!=nil { return nil,err }
    tick:=time.NewTicker(20*time.Millisecond)
    defer tick.Stop()
    for {
     state,err:=client.Status(ctx)
     if err!=nil { return nil,err }
     if state.AuthURL!="" {
      if !strings.HasPrefix(state.AuthURL,control.HTTPTestServer.URL+"/auth/") || !control.CompleteAuth(state.AuthURL) { return nil,fmt.Errorf("peer approval refused") }
      break
     }
     select { case <-ctx.Done(): return nil,ctx.Err();case <-tick.C: }
    }
    state,err:=peer.Up(ctx)
    if err!=nil { return nil,err }
    if state.Self==nil || len(state.TailscaleIPs)==0 { return nil,fmt.Errorf("registered peer has no identity or address") }
    entry:=&actorPeer{server:peer,key:state.Self.PublicKey,owner:request.User=="owner" || len(request.Tags)>0,tags:request.Tags}
    peers[request.Name]=entry
    if ownerID!=0 { if err:=assignOwner(ownerID);err!=nil { return nil,err } }
    socketDir,err:=os.MkdirTemp("","omtn-")
    if err!=nil { return nil,err }
    t.Cleanup(func(){if err:=os.RemoveAll(socketDir);err!=nil { t.Error(err) }})
    socket,err:=serveFixtureLocalAPI(t,peer,socketDir)
    if err!=nil { return nil,err }
    cliDirectory:=os.Getenv("PORTABLE_TAILSCALE_CLI_DIR")
    if !filepath.IsAbs(cliDirectory) { return nil,fmt.Errorf("missing pinned official CLI directory") }
    suffix:=""
    if runtime.GOOS=="windows" { suffix=".exe" }
    machineDir:=filepath.Join(directory,"machines",request.Name)
    binDir:=filepath.Join(machineDir,"bin")
    if _,err:=makeFixtureCLI(binDir,socket,filepath.Join(cliDirectory,"tailscale"+suffix));err!=nil { return nil,err }
    proxyURL:=serveFixturePeerProxy(t,peer)
    return map[string]string{"name":request.Name,"address":state.TailscaleIPs[0].String(),"dir":machineDir,"socket":socket,"proxyUrl":proxyURL,"binDir":binDir},nil
   default: return nil,fmt.Errorf("unknown fixture operation")
   }
  }()
  cancel()
  actorReply(request.ID,value,err)
  if request.Op=="stop" { return }
 }
 if err:=scanner.Err();err!=nil { t.Fatal(err) }
}
