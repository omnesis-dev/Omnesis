// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export {
  copyWindowsPrivateFile,
  copyWindowsPrivateFileSync,
  readWindowsPrivateFile,
  readWindowsPrivateFileSync,
  readWindowsPrivateFileContents,
  readWindowsPrivateFileContentsSync,
  readWindowsRegularFilePrefix,
  deleteWindowsPrivateFileExact,
  deleteWindowsPrivateFileExactSync,
  createWindowsPrivateFile,
  createWindowsPrivateFileSync,
  writeWindowsPrivateFileAtomic,
  writeWindowsPrivateFileAtomicSync,
  inspectWindowsPrivatePaths,
  inspectWindowsPrivatePathSync,
  prepareWindowsPrivateStorageDirectorySync,
  secureWindowsPrivatePathSync,
  writeWindowsPrivateFileAtomicStream,
} from "@omnesis/platform/windows-private-file";
export type {
  WindowsPrivateExactNames,
  WindowsPrivatePath,
  WindowsPrivatePathStatus,
} from "@omnesis/platform/windows-private-file";
