//! Thin Node-API entry point: all logic lives in the `lintrs` dylib so that
//! native rule libraries link against one shared copy of it and of tsrs.

use std::ffi::c_void;

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_register_module_v1(
    env: *mut c_void,
    exports: *mut c_void,
) -> *mut c_void {
    unsafe { lintrs::in_process::lintrs_napi_register_module_v1(env, exports) }
}
