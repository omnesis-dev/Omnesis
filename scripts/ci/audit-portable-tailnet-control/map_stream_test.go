// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package portablecontrol

import (
 "context"
 "testing"
 "time"

 "tailscale.com/tailcfg"
 "tailscale.com/tstest/integration/testcontrol"
)

// Keep the SDK coordinator's registration, endpoint updates and stream
// lifecycle intact. Its public raw-map seam suppresses automatic responses;
// every supplied snapshot retains real registered identities and disables
// only HTTPS certificates. In particular, logout expiry updates still flow.
func mapsWithoutCertificates(t *testing.T, control *testcontrol.Server) {
 t.Helper()
 control.ModifyFirstMapResponse = func(response *tailcfg.MapResponse, request *tailcfg.MapRequest) {
  if response.DNSConfig != nil { response.DNSConfig.CertDomains = nil }
  if request.Stream && !request.ReadOnly {
   control.AddRawMapResponse(request.NodeKey, response)
  }
 }
 ctx, cancel := context.WithCancel(context.Background())
 done := make(chan struct{})
 go func() {
  defer close(done)
  tick := time.NewTicker(200*time.Millisecond)
  defer tick.Stop()
  for {
   select {
   case <-ctx.Done(): return
   case <-tick.C:
    for _, node := range control.AllNodes() {
     response, err := control.MapResponse(&tailcfg.MapRequest{NodeKey:node.Key})
     if err != nil || response == nil { continue }
     if response.DNSConfig != nil { response.DNSConfig.CertDomains = nil }
     control.AddRawMapResponse(node.Key, response)
    }
   }
  }
 }()
 t.Cleanup(func() { cancel(); <-done })
}
