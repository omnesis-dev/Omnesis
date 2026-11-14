// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Unsafe idle files are replaced privately without mutating any outside alias. */
export const WINDOWS_FILE_REPAIR_NATIVE_SOURCE = String.raw`
public static partial class OmnesisPrivateFile {
  static uint RepairAttributes(Info source) {
    if((source.attributes&0x4000U)!=0) throw new NotSupportedException("Encrypted files require encryption-preserving repair");
    // Other storage semantics (compression, sparse/cloud/integrity state) need
    // dedicated APIs. Never silently drop them while repairing access controls.
    if((source.attributes&~0x21A7U)!=0) throw new NotSupportedException("File attributes require preserving repair");
    uint attributes=source.attributes&~0x80U;
    return attributes==0?0x80U:attributes;
  }
  static void PreserveMetadata(SafeFileHandle file,Info source) {
    uint attributes=RepairAttributes(source);
    IntPtr basic=Marshal.AllocHGlobal(40);
    try {
      for(int i=0;i<40;i++) Marshal.WriteByte(basic,i,0);
      Marshal.WriteInt64(basic,0,source.creation);
      Marshal.WriteInt64(basic,8,source.access);
      Marshal.WriteInt64(basic,16,source.write);
      Marshal.WriteInt32(basic,32,(int)attributes);
      Check(SetFileInformationByHandle(file,0,basic,40));
      Info actual=Information(file,false);
      if(RepairAttributes(actual)!=attributes || actual.creation!=source.creation || actual.access!=source.access || actual.write!=source.write)
        throw new IOException("Private repair metadata could not be preserved");
    } finally { Marshal.FreeHGlobal(basic); }
  }
  static void RepairFile(string path,SafeFileHandle source,Info before) {
    RepairAttributes(before);
    if(before.sizeHigh>Int32.MaxValue) throw new InvalidDataException();
    long size=((long)before.sizeHigh<<32)|before.sizeLow;
    using(FileStream input=new FileStream(source,FileAccess.Read,65536,false)) {
      WriteInput(path,size,true,false,"",false,true,input,false,delegate() {
        Info after=Information(input.SafeFileHandle,false);
        RawSecurityDescriptor security=Security(input.SafeFileHandle);
        if(security.Owner==null || !Trusted(security.Owner.Value)) throw new UnauthorizedAccessException();
        // A new hardlink may appear after the initial check. The replacement
        // never modifies this shared source object, so those aliases stay safe.
        if(Identity(before)!=Identity(after) || before.write!=after.write || before.sizeHigh!=after.sizeHigh || before.sizeLow!=after.sizeLow || before.attributes!=after.attributes)
          throw new IOException("File changed during private repair");
      },delegate(SafeFileHandle created) {PreserveMetadata(created,before);},true);
    }
  }
}`;
