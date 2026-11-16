//! Thin Node-API entry point: all logic lives in the `rlint` dylib so that
//! native rule libraries link against one shared copy of it and of tsrs.

use std::ffi::c_void;

#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_register_module_v1(
    env: *mut c_void,
    exports: *mut c_void,
) -> *mut c_void {
    unsafe { rlint::in_process::rlint_napi_register_module_v1(env, exports) }
}
