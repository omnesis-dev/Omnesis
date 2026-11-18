// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Compile against the installed patched header and exercise a sparse mapping
// past 4 GiB without allocating a large graph or filling the disk.
#include <usearch/index.hpp>
#include <winioctl.h>

int wmain(int argc, wchar_t** argv) {
    if (argc != 2 || sizeof(std::size_t) < 8) return 1;
    HANDLE file = CreateFileW(argv[1], GENERIC_READ | GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return 2;
    DWORD returned = 0;
    LARGE_INTEGER last;
    last.QuadPart = (1LL << 32) + 31;
    char marker = 73;
    bool created = DeviceIoControl(file, FSCTL_SET_SPARSE, nullptr, 0, nullptr, 0, &returned, nullptr) &&
                   SetFilePointerEx(file, last, nullptr, FILE_BEGIN) &&
                   WriteFile(file, &marker, 1, &returned, nullptr) && returned == 1;
    CloseHandle(file);
    if (!created) { DeleteFileW(argv[1]); return 3; }

    int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[1], -1, nullptr, 0, nullptr, nullptr);
    std::string path(static_cast<std::size_t>(length), '\0');
    if (!length || !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[1], -1, &path[0], length,
                                      nullptr, nullptr)) {
        DeleteFileW(argv[1]); return 4;
    }
    bool valid = false;
    {
        unum::usearch::memory_mapped_file_t mapped(path.c_str());
        auto result = mapped.open_if_not();
        valid = result && mapped.size() == static_cast<std::size_t>(last.QuadPart + 1) &&
                mapped.data()[static_cast<std::size_t>(last.QuadPart)] == marker;
        // Consume an error before its checked destructor, even on a failed probe.
        if (!result) result.error.release();
    }
    bool removed = DeleteFileW(argv[1]);
    return valid && removed ? 0 : 5;
}
