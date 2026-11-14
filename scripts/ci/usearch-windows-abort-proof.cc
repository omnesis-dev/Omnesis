// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Test-only addon built in the CI preparation's owned scratch directory.
// Preserve the host Node process's default CRT behavior and handlers.
#include <node_api.h>
#include <cstdio>
#include <cstdlib>
#include <exception>

static bool Entered(napi_env env, char const* mode) {
    if (std::printf("OMNESIS_NATIVE_ABORT_PROOF:%s:entered\n", mode) < 0 || std::fflush(stdout) != 0) {
        napi_throw_error(env, nullptr, "Native abort proof marker unavailable");
        return false;
    }
    return true;
}

static napi_value Abort(napi_env env, napi_callback_info) {
    if (!Entered(env, "abort")) return nullptr;
    std::abort();
}

static napi_value Terminate(napi_env env, napi_callback_info) {
    if (!Entered(env, "terminate")) return nullptr;
    std::terminate();
}

static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor properties[] = {
        {"abort", nullptr, Abort, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"terminate", nullptr, Terminate, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    if (napi_define_properties(env, exports, 2, properties) != napi_ok) return nullptr;
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
