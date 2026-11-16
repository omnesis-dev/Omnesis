// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package portablecontrol

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"tailscale.com/tailcfg"
	"tailscale.com/tstest/integration/testcontrol"
	"tailscale.com/types/key"
)

// Keep the SDK coordinator's registration, endpoint updates and stream
// lifecycle intact. Its public raw-map seam suppresses automatic responses;
// every supplied snapshot retains real registered identities and disables
// only HTTPS certificates. In particular, logout expiry updates still flow.
func mapsWithoutCertificates(t *testing.T, control *testcontrol.Server) {
	t.Helper()
	var mu sync.Mutex
	active := map[key.NodePublic]int{}
	generation := map[key.NodePublic]uint64{}
	control.HoldMapRequest = func(request *tailcfg.MapRequest) func() {
		if !request.Stream || request.ReadOnly {
			return nil
		}
		mu.Lock()
		active[request.NodeKey]++
		generation[request.NodeKey]++
		mu.Unlock()
		return func() { mu.Lock(); active[request.NodeKey]--; mu.Unlock() }
	}
	control.ModifyFirstMapResponse = func(response *tailcfg.MapResponse, request *tailcfg.MapRequest) {
		if response.DNSConfig != nil {
			response.DNSConfig.CertDomains = nil
		}
		if request.Stream && !request.ReadOnly {
			control.AddRawMapResponse(request.NodeKey, response)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		type stamp struct {
			generation uint64
			hash       [32]byte
		}
		sent := map[key.NodePublic]stamp{}
		tick := time.NewTicker(200 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				for _, node := range control.AllNodes() {
					mu.Lock()
					connected, currentGeneration := active[node.Key] > 0, generation[node.Key]
					mu.Unlock()
					if !connected {
						continue
					}
					response, err := control.MapResponse(&tailcfg.MapRequest{NodeKey: node.Key})
					if err != nil || response == nil {
						continue
					}
					if response.DNSConfig != nil {
						response.DNSConfig.CertDomains = nil
					}
					fingerprint, err := mapFingerprint(response)
					if err != nil {
						t.Errorf("encode map: %v", err)
						continue
					}
					current := stamp{generation: currentGeneration, hash: fingerprint}
					if previous, ok := sent[node.Key]; ok && previous == current {
						continue
					}
					if control.AddRawMapResponse(node.Key, response) {
						sent[node.Key] = current
					}
				}
			}
		}
	}()
	t.Cleanup(func() { cancel(); <-done })
}


// Server snapshots carry the current wall clock even when no topology changed.
// Ignore it only for deduplication; the delivered map keeps its real clock.
func mapFingerprint(response *tailcfg.MapResponse) ([32]byte,error) {
 copy:=*response
 copy.ControlTime=nil
 encoded,err:=json.Marshal(&copy)
 if err!=nil { return [32]byte{},err }
 return sha256.Sum256(encoded),nil
}

func TestMapFingerprintPreservesTopologyChangesWithoutClockTraffic(t *testing.T) {
 now:=time.Now()
 later:=now.Add(time.Second)
 original:=&tailcfg.MapResponse{ControlTime:&now,Node:&tailcfg.Node{ID:1,User:10}}
 same:=*original
 same.ControlTime=&later
 first,err:=mapFingerprint(original)
 if err!=nil { t.Fatal(err) }
 next,err:=mapFingerprint(&same)
 if err!=nil { t.Fatal(err) }
 if first!=next { t.Fatal("clock-only snapshots emitted duplicate topology") }
 if original.ControlTime!=&now || same.ControlTime!=&later { t.Fatal("deduplication changed the delivered control clock") }
 for _,node:=range []*tailcfg.Node{
  {ID:1,User:11},
  {ID:1,User:10,Tags:[]string{"tag:fixture"}},
  {ID:1,User:10,KeyExpiry:later},
 } {
  changed:=same
  changed.Node=node
  result,err:=mapFingerprint(&changed)
  if err!=nil { t.Fatal(err) }
  if result==first { t.Fatal("identity, tag or key-expiry update was suppressed") }
 }
}
