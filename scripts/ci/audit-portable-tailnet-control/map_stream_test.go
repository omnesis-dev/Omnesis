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
					encoded, err := json.Marshal(response)
					if err != nil {
						t.Errorf("encode map: %v", err)
						continue
					}
					current := stamp{generation: currentGeneration, hash: sha256.Sum256(encoded)}
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
