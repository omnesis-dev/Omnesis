// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { WINDOWS_JOB_NATIVE_SOURCE } from "./windows-job-source.js";
import { WINDOWS_PRIVATE_FILE_NATIVE_SOURCE } from "./windows-private-file-source.js";
import { WINDOWS_REGULAR_FILE_NATIVE_SOURCE } from "./windows-regular-file-source.js";

export const WINDOWS_WORKER_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<configuration><startup><supportedRuntime version="v4.0"/></startup><runtime><AppContextSwitchOverrides value="Switch.System.IO.UseLegacyPathHandling=false;Switch.System.IO.BlockLongPaths=false"/></runtime></configuration>`;
export const WINDOWS_WORKER_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><assemblyIdentity type="win32" name="Omnesis.Platform.NativeWorker" version="1.0.0.0" processorArchitecture="*"/><compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1"><application><supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/></application></compatibility><application xmlns="urn:schemas-microsoft-com:asm.v3"><windowsSettings><longPathAware xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">true</longPathAware><supportedArchitectures xmlns="http://schemas.microsoft.com/SMI/2024/WindowsSettings">amd64 arm64</supportedArchitectures></windowsSettings></application></assembly>`;

const ENTRY = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static partial class OmnesisProcessJob {
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  // Deliberately retained through orderly process teardown. Closing a self-job
  // here would terminate this process before its success exit is established.
  static IntPtr fileJob,fileParent;
  static Timer fileWatch;
  public static int Filesystem(int parentPid,Func<int> operation) {
    fileParent=OpenProcess(SYNCHRONIZE|QUERY,false,(uint)parentPid);
    if(fileParent==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    if(Birth(fileParent)>Birth(GetCurrentProcess()) || WaitForSingleObject(fileParent,0)==WAIT_OBJECT) throw new InvalidOperationException();
    fileJob=CreateJobObject(IntPtr.Zero,null);
    if(fileJob==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    Limits limits=new Limits(); limits.basic.flags=KILL_ON_CLOSE;
    Check(SetInformationJobObject(fileJob,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))));
    Check(AssignProcessToJobObject(fileJob,GetCurrentProcess()));
    fileWatch=new Timer(delegate(object state) {
      if(WaitForSingleObject(fileParent,0)==WAIT_OBJECT) { TerminateJobObject(fileJob,1); Environment.Exit(1); }
    },null,0,25);
    Status(0);
    return operation();
  }
}

public static class WindowsWorker {
  static JavaScriptSerializer Json() { return new JavaScriptSerializer { MaxJsonLength=2097152, RecursionLimit=32 }; }
  static Dictionary<string,object> Object(object value) {
    Dictionary<string,object> result=value as Dictionary<string,object>;
    if(result==null) throw new InvalidDataException(); return result;
  }
  static string Text(Dictionary<string,object> data,string key,string fallback) {
    object value; if(!data.TryGetValue(key,out value)) { if(fallback!=null) return fallback; throw new InvalidDataException(); }
    string result=value as string; if(result==null) throw new InvalidDataException(); return result;
  }
  static bool Flag(Dictionary<string,object> data,string key,bool fallback) {
    object value; if(!data.TryGetValue(key,out value)) return fallback;
    if(!(value is bool)) throw new InvalidDataException(); return (bool)value;
  }
  static long Number(Dictionary<string,object> data,string key) {
    object value; if(!data.TryGetValue(key,out value) || !(value is int || value is long || value is decimal)) throw new InvalidDataException();
    return Convert.ToInt64(value,System.Globalization.CultureInfo.InvariantCulture);
  }
  static int Filesystem() {
    Dictionary<string,object> data=Object(Json().DeserializeObject(OmnesisPrivateFile.Configuration()));
    string action=Text(data,"action",null);
    if(action=="create" || action=="atomic") {
      OmnesisPrivateFile.Write(Text(data,"path",null),Number(data,"length"),action=="atomic",Flag(data,"readOnly",false),Text(data,"staging",""),Flag(data,"receipt",false),Flag(data,"replaceExisting",true));
    } else if(action=="regular-prefix") {
      OmnesisPrivateFile.ReadRegularPrefix(Text(data,"path",null),Number(data,"limit"));
    } else if(action=="read") {
      OmnesisPrivateFile.Read(Text(data,"path",null),Number(data,"limit"),Text(data,"exactBasename",""),Text(data,"exactParentBasename",""));
    } else if(action=="delete") {
      OmnesisPrivateFile.DeleteExact(Text(data,"path",null),Text(data,"exactBasename",""),Text(data,"exactParentBasename",""));
    } else if(action=="cleanup") {
      OmnesisPrivateFile.Cleanup(Text(data,"path",null),Text(data,"identity",null));
    } else if(action=="inspect") {
      object[] paths=data["paths"] as object[]; if(paths==null || paths.Length>5000) throw new InvalidDataException();
      List<Dictionary<string,object>> results=new List<Dictionary<string,object>>();
      foreach(object item in paths) {
        Dictionary<string,object> result=new Dictionary<string,object>();
        try {
          Dictionary<string,object> path=Object(item); string kind=Text(path,"kind",null);
          if(kind!="file" && kind!="directory") throw new InvalidDataException();
          string state=OmnesisPrivateFile.Inspect(Text(path,"path",null),kind=="directory",Flag(data,"repair",false),Flag(data,"protect",false));
          result["private"]=state!="unsafe";result["fixed"]=state=="fixed";
        } catch {result["private"]=false;result["fixed"]=false;result["error"]="EPRIVATE";}
        results.Add(result);
      }
      Console.Out.Write(Json().Serialize(results));
    } else throw new InvalidDataException();
    return 0;
  }
  static string ErrorCode(Exception error) {
    object cleanupCode=null;
    for(;;) {
      if(error.Data.Contains("PrivateCleanupCode")) cleanupCode=error.Data["PrivateCleanupCode"];
      if(error.InnerException==null) break;
      error=error.InnerException;
    }
    if(cleanupCode!=null) Console.Error.WriteLine("OMNESIS_PRIVATE_CLEANUP_FAILED:"+Convert.ToString(cleanupCode,System.Globalization.CultureInfo.InvariantCulture));
    Win32Exception windows=error as Win32Exception;
    int code=windows==null ? error.HResult&65535 : windows.NativeErrorCode;
    string category=code==2 || code==3 ? "ENOENT" : code==80 || code==183 ? "EEXIST" : "EPRIVATE";
    return category+":"+OmnesisPrivateFile.Stage+":"+code.ToString(System.Globalization.CultureInfo.InvariantCulture);
  }
  public static int Main(string[] args) {
    Console.OutputEncoding=new UTF8Encoding(false);
    try {
      if(args.Length==2 && args[0]=="filesystem") {
        int parent; if(!Int32.TryParse(args[1],out parent) || parent<=0) throw new InvalidDataException();
        return OmnesisProcessJob.Filesystem(parent,Filesystem);
      }
      if(args.Length==1 && args[0]=="job") {
        Dictionary<string,object> data=Object(Json().DeserializeObject(OmnesisProcessJob.ReadConfiguration()));
        object[] values=data["args"] as object[];if(values==null) throw new InvalidDataException();
        string[] arguments=new string[values.Length];
        for(int i=0;i<values.Length;i++) { arguments[i]=values[i] as string; if(arguments[i]==null) throw new InvalidDataException(); }
        return OmnesisProcessJob.Run(Text(data,"command",null),arguments,checked((int)Number(data,"parentPid")));
      }
      throw new InvalidDataException();
    } catch(Exception error) {Console.Error.Write(ErrorCode(error));return 1;}
  }
}
`;

const namespace = (source: string): string => `namespace OmnesisPlatform {\n${source}\n}\n`;
export const WINDOWS_WORKER_SOURCE =
  namespace(WINDOWS_JOB_NATIVE_SOURCE) +
  namespace(WINDOWS_PRIVATE_FILE_NATIVE_SOURCE) +
  namespace(WINDOWS_REGULAR_FILE_NATIVE_SOURCE) +
  namespace(ENTRY);
