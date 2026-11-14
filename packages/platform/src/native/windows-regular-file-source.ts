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

  static SafeFileHandle RelativeRead(SafeFileHandle parent,string name,bool directory,uint fileSharing=5U) {
    if(String.IsNullOrEmpty(name) || name=="." || name==".." || name.IndexOfAny(new char[]{'\\','/',':','\0'})>=0) throw new InvalidDataException();
    IntPtr text=Marshal.StringToHGlobalUni(name),unicode=IntPtr.Zero;
    try {
      RelativeName value=new RelativeName();value.length=checked((ushort)(name.Length*2));value.maximum=value.length;value.buffer=text;
      unicode=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(RelativeName)));Marshal.StructureToPtr(value,unicode,false);
      RelativeAttributes attributes=new RelativeAttributes();attributes.length=Marshal.SizeOf(typeof(RelativeAttributes));attributes.root=parent.DangerousGetHandle();attributes.name=unicode;attributes.attributes=0x40;
      RenameIoStatus io;IntPtr raw;
      // FILE_OPEN_REPARSE_POINT applies to this single component. RootDirectory
      // is the already-held parent object, never another lookup of its path.
      int status=NtCreateFile(out raw,directory?0x1000A0U:0x80100000U,ref attributes,out io,IntPtr.Zero,0,directory?3U:fileSharing,1,0x200020U|(directory?1U:0x40U),IntPtr.Zero,0);
      SafeFileHandle handle=new SafeFileHandle(raw,true);
      try {
        if(status<0) throw new Win32Exception((int)RtlNtStatusToDosError(status));
        if(handle.IsInvalid) throw new InvalidDataException();
        Information(handle,directory);return handle;
      } catch {handle.Dispose();throw;}
    } finally {if(unicode!=IntPtr.Zero) Marshal.FreeHGlobal(unicode);Marshal.FreeHGlobal(text);}
  }

  static void WithRegularRead(string path,uint sharing,Action<FileStream,Info> consume) {
    Stage="regular-resolve";path=FullPath(path);
    if(path.Length>32767) throw new InvalidDataException();
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
      using(SafeFileHandle leaf=RelativeRead(parents[parents.Count-1],components[components.Length-1],false,sharing))
      using(FileStream file=new FileStream(leaf,FileAccess.Read)) {
        consume(file,Information(file.SafeFileHandle,false));
      }
    } finally {for(int index=parents.Count-1;index>=0;index--) parents[index].Dispose();}
  }
  public static void ReadRegularPrefix(string path,long maximum) {
    if(maximum<0 || maximum>33554432) throw new InvalidDataException();
    WithRegularRead(path,5U,delegate(FileStream file,Info info) {
      if(info.sizeHigh>Int32.MaxValue) throw new InvalidDataException();
      long size=((long)info.sizeHigh<<32)|info.sizeLow;
      int length=(int)Math.Min(maximum,size);
      byte[] bytes=new byte[length];int count=0;
      while(count<length) {int read=file.Read(bytes,count,length-count);if(read==0) break;count+=read;}
      Stage="regular-output";Stream output=Console.OpenStandardOutput();
      byte[] header=BitConverter.GetBytes(size);output.Write(header,0,header.Length);output.Write(bytes,0,count);
    });
  }

  // Keep the source's component handles through publication. Live SQLite
  // sources allow concurrent writers; their caller also checks all companion
  // fingerprints before accepting the resulting snapshot.
  static void RefuseSourceDestination(string destination,Info source) {
    Stage="copy-target";
    using(SafeFileHandle target=CreateFile(FullPath(destination),0x80,7,IntPtr.Zero,3,0x200000,IntPtr.Zero)) {
      if(target.IsInvalid) {int error=Marshal.GetLastWin32Error();if(error==2 || error==3) return;throw new Win32Exception(error);}
      Info existing=Information(target,false);
      if(source.volume==existing.volume && source.indexHigh==existing.indexHigh && source.indexLow==existing.indexLow)
        throw new IOException("Private copy source and destination identify the same file");
    }
  }
  public static void CopyRegularToPrivate(string source,string destination) {
    // Writers remain compatible, while denying delete sharing prevents a late
    // destination alias from replacing the held source object at publication.
    WithRegularRead(source,3U,delegate(FileStream file,Info before) {
      RefuseSourceDestination(destination,before);
      if(before.sizeHigh>Int32.MaxValue) throw new InvalidDataException();
      long size=((long)before.sizeHigh<<32)|before.sizeLow;
      WriteInput(destination,size,true,false,"",false,true,file,false,delegate() {
        Stage="copy-source";Info after=Information(file.SafeFileHandle,false);
        if(before.volume!=after.volume || before.indexHigh!=after.indexHigh || before.indexLow!=after.indexLow || before.creation!=after.creation || before.write!=after.write || before.sizeHigh!=after.sizeHigh || before.sizeLow!=after.sizeLow)
          {Stage="copy-source-changed";throw new IOException("Source changed while copying");}
        RefuseSourceDestination(destination,before);
      });
    });
  }

}
`;
