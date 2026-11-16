// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package portablecontrol

import (
 "encoding/json"
 "errors"
 "fmt"
 "io"
 "os"
 "os/exec"
 "path/filepath"
 "runtime"
 "testing"
)

type fixtureCLIConfig struct { Executable string `json:"executable"`; Socket string `json:"socket"` }

// A compiled adapter supplies only the fixture socket to the official CLI.
// Windows receives an actual executable, with no shell or fabricated status.
func TestMain(m *testing.M) {
 name:=filepath.Base(os.Args[0])
 if name!="tailscale" && name!="tailscale.exe" { os.Exit(m.Run()) }
 if err:=runFixtureCLI();err!=nil {
  var exited *exec.ExitError
  if errors.As(err,&exited) { os.Exit(exited.ExitCode()) }
  fmt.Fprintln(os.Stderr,err)
  os.Exit(1)
 }
 os.Exit(0)
}

func runFixtureCLI() error {
 executable,err:=os.Executable()
 if err!=nil { return err }
 configFile,err:=os.Open(filepath.Join(filepath.Dir(executable),"fixture-cli.json"))
 if err!=nil { return err }
 defer configFile.Close()
 info,err:=configFile.Stat()
 if err!=nil { return err }
 if !info.Mode().IsRegular() || info.Size()>16*1024 { return fmt.Errorf("invalid fixture CLI configuration file") }
 decoder:=json.NewDecoder(io.LimitReader(configFile,16*1024))
 decoder.DisallowUnknownFields()
 var config fixtureCLIConfig
 if err:=decoder.Decode(&config);err!=nil { return err }
 if err:=decoder.Decode(new(any));err!=io.EOF { return fmt.Errorf("invalid fixture CLI configuration") }
 if !filepath.IsAbs(config.Executable) || config.Socket=="" { return fmt.Errorf("missing fixture CLI executable or socket") }
 command:=exec.Command(config.Executable,append([]string{"--socket="+config.Socket},os.Args[1:]...)...)
 command.Stdin,command.Stdout,command.Stderr=os.Stdin,os.Stdout,os.Stderr
 return command.Run()
}

func makeFixtureCLI(directory,socket,officialCLI string)(string,error) {
 if !filepath.IsAbs(officialCLI) { return "",fmt.Errorf("official CLI path must be absolute") }
 if err:=os.MkdirAll(directory,0700);err!=nil { return "",err }
 executable,err:=os.Executable()
 if err!=nil { return "",err }
 source,err:=os.Open(executable)
 if err!=nil { return "",err }
 defer source.Close()
 suffix:=""
 if runtime.GOOS=="windows" { suffix=".exe" }
 target:=filepath.Join(directory,"tailscale"+suffix)
 output,err:=os.OpenFile(target,os.O_CREATE|os.O_EXCL|os.O_WRONLY,0755)
 if err!=nil { return "",err }
 _,copyErr:=io.Copy(output,source)
 closeErr:=output.Close()
 if copyErr!=nil || closeErr!=nil { return "",errors.Join(copyErr,closeErr) }
 config,err:=json.Marshal(fixtureCLIConfig{Executable:officialCLI,Socket:socket})
 if err!=nil { return "",err }
 if err:=os.WriteFile(filepath.Join(directory,"fixture-cli.json"),config,0600);err!=nil { return "",err }
 return target,nil
}
