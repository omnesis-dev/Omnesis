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
  static void WithRegularRead(string path,uint sharing,Action<FileStream,Info> consume) {
    Stage="regular-resolve";path=FullPath(path);
    // Source directories retain their original TRAVERSE/attributes access;
    // unlike private operations, no READ_CONTROL or private ancestor ACL is required.
    using(PinnedParent parent=new PinnedParent(path,false)) {
      Stage="regular-leaf";
      using(SafeFileHandle leaf=RelativeOpen(parent.Handle,parent.Leaf,false,0x80100000U,sharing))
      using(FileStream file=new FileStream(leaf,FileAccess.Read)) {
        consume(file,Information(file.SafeFileHandle,false));
      }
    }
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
