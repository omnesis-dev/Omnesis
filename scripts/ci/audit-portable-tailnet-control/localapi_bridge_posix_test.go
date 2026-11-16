//go:build !windows

// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package portablecontrol

import (
 "net"
 "os"
 "path/filepath"
)

func privateLocalAPIListener(directory string) (net.Listener,string,error) {
 socket:=filepath.Join(directory,"local-api.sock")
 listener,err:=net.Listen("unix",socket)
 if err!=nil { return nil,"",err }
 if err:=os.Chmod(socket,0600);err!=nil { listener.Close();return nil,"",err }
 return listener,socket,nil
}
