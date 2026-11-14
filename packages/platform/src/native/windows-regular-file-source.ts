// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Arbitrary source files are read through held directory handles, without changing their ACLs. */
export const WINDOWS_REGULAR_FILE_NATIVE_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static partial class OmnesisPrivateFile {
  [StructLayout(LayoutKind.Sequential)] struct RelativeName {
    public ushort length,maximum; public IntPtr buffer;
  }
  [StructLayout(LayoutKind.Sequential)] struct RelativeAttributes {
    public int length; public IntPtr root,name; public uint attributes;
    public IntPtr security,quality;
  }
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr handle,uint access,ref RelativeAttributes attributes,out RenameIoStatus io,IntPtr allocation,uint fileAttributes,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);

  static SafeFileHandle RelativeRead(SafeFileHandle parent,string name,bool directory) {
    if(String.IsNullOrEmpty(name) || name=="." || name==".." || name.IndexOfAny(new char[]{'\\','/',':','\0'})>=0) throw new InvalidDataException();
    IntPtr text=Marshal.StringToHGlobalUni(name),unicode=IntPtr.Zero;
    try {
      RelativeName value=new RelativeName();value.length=checked((ushort)(name.Length*2));value.maximum=value.length;value.buffer=text;
      unicode=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(RelativeName)));Marshal.StructureToPtr(value,unicode,false);
      RelativeAttributes attributes=new RelativeAttributes();attributes.length=Marshal.SizeOf(typeof(RelativeAttributes));attributes.root=parent.DangerousGetHandle();attributes.name=unicode;attributes.attributes=0x40;
      RenameIoStatus io;IntPtr raw;
      // FILE_OPEN_REPARSE_POINT applies to this single component. RootDirectory
      // is the already-held parent object, never another lookup of its path.
      int status=NtCreateFile(out raw,directory?0x1000A0U:0x80100000U,ref attributes,out io,IntPtr.Zero,0,directory?3U:5U,1,0x200020U|(directory?1U:0x40U),IntPtr.Zero,0);
      SafeFileHandle handle=new SafeFileHandle(raw,true);
      try {
        if(status<0) throw new Win32Exception((int)RtlNtStatusToDosError(status));
        if(handle.IsInvalid) throw new InvalidDataException();
        Information(handle,directory);return handle;
      } catch {handle.Dispose();throw;}
    } finally {if(unicode!=IntPtr.Zero) Marshal.FreeHGlobal(unicode);Marshal.FreeHGlobal(text);}
  }

  public static void ReadRegularPrefix(string path,long maximum) {
    Stage="regular-resolve";path=FullPath(path);
    if(path.Length>32767 || maximum<0 || maximum>33554432) throw new InvalidDataException();
    string root=Path.GetPathRoot(path);
    string[] components=path.Substring(root.Length).Split(new char[]{'\\','/'},StringSplitOptions.RemoveEmptyEntries);
    if(components.Length==0) throw new InvalidDataException();
    List<SafeFileHandle> parents=new List<SafeFileHandle>();
    try {
      Stage="regular-root";
      SafeFileHandle volume=CreateFile(root,0x1000A0,3,IntPtr.Zero,3,0x2200000,IntPtr.Zero);
      if(volume.IsInvalid) {int error=Marshal.GetLastWin32Error();volume.Dispose();throw new Win32Exception(error);}
      parents.Add(volume);Information(volume,true);
      for(int index=0;index<components.Length-1;index++) {
        Stage="regular-parent";parents.Add(RelativeRead(parents[parents.Count-1],components[index],true));
      }
      Stage="regular-leaf";
      using(SafeFileHandle leaf=RelativeRead(parents[parents.Count-1],components[components.Length-1],false)) {
        Info info=Information(leaf,false);
        if(info.sizeHigh>Int32.MaxValue) throw new InvalidDataException();
        long size=((long)info.sizeHigh<<32)|info.sizeLow;
        int length=(int)Math.Min(maximum,size);
        byte[] bytes=new byte[length];int count=0;
        using(FileStream file=new FileStream(leaf,FileAccess.Read)) {
          while(count<length) {int read=file.Read(bytes,count,length-count);if(read==0) break;count+=read;}
        }
        // Frame only after the bounded read succeeds, retaining all parents
        // through the read. The file may be larger than its requested prefix.
        Stage="regular-output";Stream output=Console.OpenStandardOutput();
        byte[] header=BitConverter.GetBytes(size);output.Write(header,0,header.Length);output.Write(bytes,0,count);
      }
    } finally {for(int index=parents.Count-1;index>=0;index--) parents[index].Dispose();}
  }
}
`;
