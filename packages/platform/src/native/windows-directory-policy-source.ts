// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Shared ancestor policy for the standalone bootstrap and private SQLite storage. */
export const WINDOWS_DIRECTORY_POLICY_NATIVE_SOURCE = String.raw`
public static partial class OmnesisPrivateFile {
  const string Installer="S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
  static bool SystemAncestor(string path) {
    string system=Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.Windows)).TrimEnd(Path.DirectorySeparatorChar);
    string full=path.TrimEnd(Path.DirectorySeparatorChar);
    return String.Equals(full,Path.GetPathRoot(path).TrimEnd(Path.DirectorySeparatorChar),StringComparison.OrdinalIgnoreCase) ||
      String.Equals(full,system,StringComparison.OrdinalIgnoreCase) || full.StartsWith(system+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase);
  }
  static void RequireSafeAncestor(SafeFileHandle handle,string path) {
    RawSecurityDescriptor descriptor=Security(handle);
    bool installer=SystemAncestor(path);
    if(descriptor.Owner==null || (!Trusted(descriptor.Owner.Value) && !(installer && descriptor.Owner.Value==Installer)) || descriptor.DiscretionaryAcl==null) throw new UnauthorizedAccessException();
    foreach(GenericAce ace in descriptor.DiscretionaryAcl) {
      QualifiedAce rule=ace as QualifiedAce;
      if(rule==null || (rule.AceQualifier!=AceQualifier.AccessAllowed && rule.AceQualifier!=AceQualifier.AccessDenied)) throw new UnauthorizedAccessException();
      if(rule.AceQualifier!=AceQualifier.AccessAllowed || (rule.AceFlags&AceFlags.InheritOnly)!=0) continue;
      string sid=rule.SecurityIdentifier.Value;
      // Create-file/subdirectory alone cannot substitute an existing pinned
      // child. Delete/rename, ACL/owner control and mutable metadata can.
      if(!Trusted(sid) && !(installer && sid==Installer) && ((uint)rule.AccessMask&0x500D0150U)!=0) throw new UnauthorizedAccessException();
    }
  }

  static void RequirePrivateInheritance(SafeFileHandle directory) {
    RawSecurityDescriptor descriptor=Security(directory);
    if(!Private(descriptor,false)) throw new UnauthorizedAccessException();
    bool inheritedGrant=false;
    foreach(GenericAce ace in descriptor.DiscretionaryAcl) {
      QualifiedAce rule=ace as QualifiedAce;
      if(rule!=null && rule.AceQualifier==AceQualifier.AccessAllowed && (rule.AceFlags&AceFlags.ObjectInherit)!=0) inheritedGrant=true;
    }
    if(!inheritedGrant) throw new UnauthorizedAccessException();
    // Match SQLite's ordinary file creation: no explicit security descriptor.
    // No secret bytes enter this probe; DELETE_ON_CLOSE also handles host death.
    using(SafeFileHandle probe=RelativeOpen(directory,".omnesis-inheritance-"+Guid.NewGuid().ToString("N")+".tmp",false,0xC0130000U,0U,2U,null,0x1000U)) {
      RequirePrivate(probe);
    }
  }
  public static void PrepareStorageDirectory(string path) {
    Stage="storage-resolve";path=FullPath(path);
    if(path.Length>32767) throw new InvalidDataException();
    string root=Path.GetPathRoot(path),current=root;
    string[] components=path.Substring(root.Length).Split(new char[]{'\\','/'},StringSplitOptions.RemoveEmptyEntries);
    List<SafeFileHandle> handles=new List<SafeFileHandle>();
    try {
      Stage="storage-root";
      SafeFileHandle volume=CreateFile(root,0x1200A0U,3U,IntPtr.Zero,3U,0x2200000U,IntPtr.Zero);
      if(volume.IsInvalid) {int error=Marshal.GetLastWin32Error();volume.Dispose();throw new Win32Exception(error);}
      handles.Add(volume);Information(volume,true);RequireSafeAncestor(volume,current);
      foreach(string component in components) {
        Stage="storage-open";SafeFileHandle child;
        try {child=RelativeOpen(handles[handles.Count-1],component,true,0x1200A0U,3U);}
        catch(Win32Exception missing) {
          if(missing.NativeErrorCode!=2 && missing.NativeErrorCode!=3) throw;
          Stage="storage-create";
          try {child=RelativeOpen(handles[handles.Count-1],component,true,0x1200A0U,3U,2U,DirectoryAcl().GetSecurityDescriptorBinaryForm());}
          catch(Win32Exception collision) {
            if(collision.NativeErrorCode!=80 && collision.NativeErrorCode!=183) throw;
            child=RelativeOpen(handles[handles.Count-1],component,true,0x1200A0U,3U);
          }
        }
        handles.Add(child);current=Path.Combine(current,component);
        Stage="storage-ancestor";RequireSafeAncestor(child,current);
      }
      Stage="storage-inheritance";RequirePrivateInheritance(handles[handles.Count-1]);
    } finally {
      for(int index=handles.Count-1;index>=0;index--) handles[index].Dispose();
    }
  }
}`;
