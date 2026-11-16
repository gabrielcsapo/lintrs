//! Experimental Node-API sessions with optional direct checker access.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::{CString, c_char, c_void};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;

use tsrs_api::{Session, SessionOptions};

#[cfg(feature = "typed-native")]
mod typed;

type Env = *mut c_void;
type Value = *mut c_void;
type CallbackInfo = *mut c_void;
type Callback = unsafe extern "C" fn(Env, CallbackInfo) -> Value;
type Finalizer = unsafe extern "C" fn(Env, *mut c_void, *mut c_void);

#[repr(C)]
struct TypeTag {
    lower: u64,
    upper: u64,
}

const SESSION_TAG: TypeTag = TypeTag {
    lower: 0x726c696e742d7473,
    upper: 0x72732d736573736e,
};

// These declarations use the stable Node-API v8 C ABI; no generated headers or npm package is needed.
unsafe extern "C" {
    fn napi_get_cb_info(
        env: Env,
        info: CallbackInfo,
        argc: *mut usize,
        argv: *mut Value,
        this: *mut Value,
        data: *mut *mut c_void,
    ) -> i32;
    fn napi_get_value_string_utf8(
        env: Env,
        value: Value,
        data: *mut c_char,
        size: usize,
        result: *mut usize,
    ) -> i32;
    fn napi_create_string_utf8(
        env: Env,
        data: *const c_char,
        size: usize,
        result: *mut Value,
    ) -> i32;
    fn napi_create_buffer_copy(
        env: Env,
        size: usize,
        data: *const c_void,
        copied: *mut *mut c_void,
        result: *mut Value,
    ) -> i32;
    fn napi_create_object(env: Env, result: *mut Value) -> i32;
    fn napi_create_function(
        env: Env,
        name: *const c_char,
        length: usize,
        callback: Option<Callback>,
        data: *mut c_void,
        result: *mut Value,
    ) -> i32;
    fn napi_set_named_property(env: Env, object: Value, name: *const c_char, value: Value) -> i32;
    fn napi_wrap(
        env: Env,
        object: Value,
        data: *mut c_void,
        finalize: Option<Finalizer>,
        hint: *mut c_void,
        reference: *mut *mut c_void,
    ) -> i32;
    fn napi_unwrap(env: Env, object: Value, data: *mut *mut c_void) -> i32;
    fn napi_type_tag_object(env: Env, object: Value, tag: *const TypeTag) -> i32;
    fn napi_check_object_type_tag(
        env: Env,
        object: Value,
        tag: *const TypeTag,
        result: *mut bool,
    ) -> i32;
    fn napi_get_undefined(env: Env, result: *mut Value) -> i32;
    fn napi_throw_error(env: Env, code: *const c_char, message: *const c_char) -> i32;
}

static SHARED_SESSIONS: Mutex<Option<HashMap<String, Weak<SharedSession>>>> = Mutex::new(None);
static NEXT_SHARED_SESSION: AtomicU64 = AtomicU64::new(1);

struct SharedSession {
    session: Arc<Session>,
    open: AtomicBool,
    snapshots: Mutex<HashMap<String, String>>,
}

struct NativeSession {
    shared: Arc<SharedSession>,
    attached: bool,
    session: RefCell<Option<Arc<Session>>>,
    requests: Cell<u64>,
    processing_ms: Cell<f64>,
}

impl NativeSession {
    fn close(&self) {
        if let Some(session) = self.session.borrow_mut().take()
            && !self.attached
        {
            self.shared.open.store(false, Ordering::Release);
            session.close();
        }
    }
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        self.close();
    }
}

fn checked(status: i32) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!("Node-API operation failed with status {status}"))
    }
}

fn boundary(env: Env, action: impl FnOnce() -> Result<Value, String>) -> Value {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(action));
    let message = match result {
        Ok(Ok(value)) => return value,
        Ok(Err(message)) => message,
        Err(_) => "Rust panicked in the in-process type bridge".to_owned(),
    };
    let message = CString::new(message.replace('\0', "\\0")).unwrap_or_default();
    // SAFETY: Node supplied this environment, and CString remains live through the call.
    unsafe { napi_throw_error(env, ptr::null(), message.as_ptr()) };
    ptr::null_mut()
}

fn arguments<const N: usize>(env: Env, info: CallbackInfo) -> Result<([Value; N], Value), String> {
    let mut values = [ptr::null_mut(); N];
    let mut count = N;
    let mut this = ptr::null_mut();
    // SAFETY: All outputs point at live stack allocations sized for the supplied count.
    checked(unsafe {
        napi_get_cb_info(
            env,
            info,
            &mut count,
            values.as_mut_ptr(),
            &mut this,
            ptr::null_mut(),
        )
    })?;
    if count != N {
        return Err(format!("Expected {N} arguments, received {count}"));
    }
    Ok((values, this))
}

fn string(env: Env, value: Value) -> Result<String, String> {
    let mut length = 0;
    // SAFETY: The first call only measures a Node string; non-string values return an error.
    checked(unsafe { napi_get_value_string_utf8(env, value, ptr::null_mut(), 0, &mut length) })?;
    let mut bytes = vec![0u8; length + 1];
    // SAFETY: The buffer has room for the measured UTF-8 bytes and terminating null.
    checked(unsafe {
        napi_get_value_string_utf8(
            env,
            value,
            bytes.as_mut_ptr().cast(),
            bytes.len(),
            &mut length,
        )
    })?;
    bytes.truncate(length);
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

fn js_string(env: Env, value: &str) -> Result<Value, String> {
    let mut result = ptr::null_mut();
    // SAFETY: Node copies exactly value.len() bytes before returning.
    checked(unsafe {
        napi_create_string_utf8(env, value.as_ptr().cast(), value.len(), &mut result)
    })?;
    Ok(result)
}

fn undefined(env: Env) -> Result<Value, String> {
    let mut result = ptr::null_mut();
    // SAFETY: Node writes a value into a live output slot.
    checked(unsafe { napi_get_undefined(env, &mut result) })?;
    Ok(result)
}

fn session_pointer(env: Env, value: Value) -> Result<*const NativeSession, String> {
    let mut matches = false;
    // SAFETY: The tag is a static ABI-compatible 128-bit value.
    checked(unsafe { napi_check_object_type_tag(env, value, &SESSION_TAG, &mut matches) })?;
    if !matches {
        return Err("Invalid in-process session receiver".to_owned());
    }
    let mut data = ptr::null_mut();
    // SAFETY: The verified tag is only assigned to objects wrapped with NativeSession below.
    checked(unsafe { napi_unwrap(env, value, &mut data) })?;
    if data.is_null() {
        return Err("The in-process session has been finalized".to_owned());
    }
    Ok(data.cast())
}

fn method(
    env: Env,
    object: Value,
    name: &std::ffi::CStr,
    callback: Callback,
) -> Result<(), String> {
    let mut function = ptr::null_mut();
    // SAFETY: Name is null-terminated, and the function pointer has the Node-API callback ABI.
    checked(unsafe {
        napi_create_function(
            env,
            name.as_ptr(),
            name.to_bytes().len(),
            Some(callback),
            ptr::null_mut(),
            &mut function,
        )
    })?;
    // SAFETY: Both object and function belong to this environment.
    checked(unsafe { napi_set_named_property(env, object, name.as_ptr(), function) })
}

unsafe extern "C" fn finalize(_env: Env, data: *mut c_void, _hint: *mut c_void) {
    let _ = std::panic::catch_unwind(|| {
        if !data.is_null() {
            // SAFETY: napi_wrap transfers this unique Box to the finalizer exactly once.
            drop(unsafe { Box::from_raw(data.cast::<NativeSession>()) });
        }
    });
}

unsafe extern "C" fn create_session(env: Env, info: CallbackInfo) -> Value {
    boundary(env, || {
        let ([cwd], _) = arguments(env, info)?;
        let cwd = string(env, cwd)?;
        if !std::path::Path::new(&cwd).is_absolute() {
            return Err("The in-process session directory must be absolute".to_owned());
        }
        let library_path = crate::type_api::library_path(std::path::Path::new(&cwd));
        let fs = crate::type_api::library_fs(&library_path);
        let session = Session::new(SessionOptions::new(cwd, library_path, fs, true));
        let shared = Arc::new(SharedSession {
            session: Arc::clone(&session),
            open: AtomicBool::new(true),
            snapshots: Mutex::new(HashMap::new()),
        });
        wrap_session(env, shared, false)
    })
}

fn wrap_session(env: Env, shared: Arc<SharedSession>, attached: bool) -> Result<Value, String> {
    let state = Box::new(NativeSession {
        session: RefCell::new(Some(Arc::clone(&shared.session))),
        shared,
        attached,
        requests: Cell::new(0),
        processing_ms: Cell::new(0.0),
    });
    let mut object = ptr::null_mut();
    // SAFETY: Node writes the new object handle to a live output slot.
    checked(unsafe { napi_create_object(env, &mut object) })?;
    method(env, object, c"request", request)?;
    method(env, object, c"close", close)?;
    method(env, object, c"timing", timing)?;
    method(env, object, c"resetTiming", reset_timing)?;
    method(env, object, c"share", share)?;
    #[cfg(feature = "typed-native")]
    typed::install(env, object)?;
    // SAFETY: Tagging precedes wrapping, and this object has not escaped to JavaScript.
    checked(unsafe { napi_type_tag_object(env, object, &SESSION_TAG) })?;
    let data = Box::into_raw(state);
    // SAFETY: On success ownership transfers to finalize; on failure we reconstruct the Box.
    let status = unsafe {
        napi_wrap(
            env,
            object,
            data.cast(),
            Some(finalize),
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if status != 0 {
        // SAFETY: A failed napi_wrap did not take ownership.
        drop(unsafe { Box::from_raw(data) });
        checked(status)?;
    }
    Ok(object)
}

unsafe extern "C" fn share(env: Env, info: CallbackInfo) -> Value {
    boundary(env, || {
        let (_, this) = arguments::<0>(env, info)?;
        let pointer = session_pointer(env, this)?;
        // SAFETY: Node roots the validated receiver throughout this callback.
        let state = unsafe { &*pointer };
        if state.attached || state.session.borrow().is_none() {
            return Err("Only an open owning session can share its project".to_owned());
        }
        let token = NEXT_SHARED_SESSION
            .fetch_add(1, Ordering::Relaxed)
            .to_string();
        let mut registry = SHARED_SESSIONS
            .lock()
            .map_err(|_| "Shared session registry poisoned")?;
        let sessions = registry.get_or_insert_with(HashMap::new);
        sessions.retain(|_, session| session.strong_count() > 0);
        sessions.insert(token.clone(), Arc::downgrade(&state.shared));
        js_string(env, &token)
    })
}

unsafe extern "C" fn attach_session(env: Env, info: CallbackInfo) -> Value {
    boundary(env, || {
        let ([token], _) = arguments(env, info)?;
        let token = string(env, token)?;
        let shared = SHARED_SESSIONS
            .lock()
            .map_err(|_| "Shared session registry poisoned")?
            .as_ref()
            .and_then(|sessions| sessions.get(&token))
            .and_then(Weak::upgrade)
            .ok_or("Unknown or expired shared session")?;
        if !shared.open.load(Ordering::Acquire) {
            return Err("Shared session owner is closed".to_owned());
        }
        wrap_session(env, shared, true)
    })
}

fn shared_request(
    state: &NativeSession,
    session: &Arc<Session>,
    method: &str,
    params: &str,
) -> Result<tsrs_api::Response, String> {
    if !state.shared.open.load(Ordering::Acquire) {
        return Err("Shared session owner is closed".to_owned());
    }
    if state.attached && method == "createSnapshot" {
        let mut snapshots = state
            .shared
            .snapshots
            .lock()
            .map_err(|_| "Shared snapshot registry poisoned")?;
        if let Some(response) = snapshots.get(params) {
            return Ok(tsrs_api::Response::Json(response.clone()));
        }
        let response = crate::type_api::dispatch_in_process(session, method, params.as_bytes())
            .map_err(|error| error.to_string())?;
        if let tsrs_api::Response::Json(value) = &response {
            snapshots.insert(params.to_owned(), value.clone());
        }
        return Ok(response);
    }
    if state.attached && method == "release" {
        let released: serde_json::Value =
            serde_json::from_str(params).map_err(|error| error.to_string())?;
        let snapshots = state
            .shared
            .snapshots
            .lock()
            .map_err(|_| "Shared snapshot registry poisoned")?;
        let known = snapshots.values().any(|response| {
            serde_json::from_str::<serde_json::Value>(response).is_ok_and(|value| {
                value["snapshot"] == released["snapshot"] && !released["snapshot"].is_null()
            })
        });
        if !known {
            return Err("Unknown shared snapshot release".to_owned());
        }
        // Attached SDK views release their JS objects; the owner retains the Rust snapshot until join.
        return Ok(tsrs_api::Response::Json(String::new()));
    }
    crate::type_api::dispatch_in_process(session, method, params.as_bytes())
        .map_err(|error| error.to_string())
}

unsafe extern "C" fn request(env: Env, info: CallbackInfo) -> Value {
    boundary(env, || {
        let ([method, params], this) = arguments(env, info)?;
        let method = string(env, method)?;
        let params = string(env, params)?;
        let pointer = session_pointer(env, this)?;
        // SAFETY: Node roots the receiver for the entire callback and no JS callbacks run below.
        let state = unsafe { &*pointer };
        let session = state
            .session
            .borrow()
            .clone()
            .ok_or("The in-process session is closed")?;
        let start = Instant::now();
        let response = shared_request(state, &session, &method, &params);
        state.requests.set(state.requests.get() + 1);
        state
            .processing_ms
            .set(state.processing_ms.get() + start.elapsed().as_secs_f64() * 1000.0);
        match response.map_err(|error| error.to_string())? {
            tsrs_api::Response::Json(value) => js_string(env, &value),
            tsrs_api::Response::Binary(value) => {
                let mut result = ptr::null_mut();
                // SAFETY: Node copies the live Rust byte vector into a managed Buffer.
                checked(unsafe {
                    napi_create_buffer_copy(
                        env,
                        value.len(),
                        value.as_ptr().cast(),
                        ptr::null_mut(),
                        &mut result,
                    )
                })?;
                Ok(result)
            }
        }
    })
}

unsafe extern "C" fn close(env: Env, info: CallbackInfo) -> Value {
    boundary(env, || {
        let (_, this) = arguments::<0>(env, info)?;
        let pointer = session_pointer(env, this)?;
        // SAFETY: Node roots the receiver for the entire callback.
        unsafe { &*pointer }.close();
        undefined(env)
    })
}

unsafe extern "C" fn timing(env: Env, info: CallbackInfo) -> Value {
    boundary(env, || {
        let (_, this) = arguments::<0>(env, info)?;
        let pointer = session_pointer(env, this)?;
        // SAFETY: Node roots the receiver for the entire callback.
        let state = unsafe { &*pointer };
        let value = serde_json::json!({
            "shared": {
                "snapshotCount": state.shared.snapshots.lock().map_err(|_| "Shared snapshot registry poisoned")?.len(),
                "ownerOpen": state.shared.open.load(Ordering::Acquire),
            },
            "enabled": true,
            "totals": { "requestCount": state.requests.get(), "totalProcessingTimeMs": state.processing_ms.get() },
            "recentRequests": [],
        });
        js_string(env, &value.to_string())
    })
}

unsafe extern "C" fn native_abi(env: Env, info: CallbackInfo) -> Value {
    boundary(env, || {
        let (_, _this) = arguments::<0>(env, info)?;
        js_string(env, crate::native::ABI_FINGERPRINT)
    })
}

unsafe extern "C" fn reset_timing(env: Env, info: CallbackInfo) -> Value {
    boundary(env, || {
        let (_, this) = arguments::<0>(env, info)?;
        let pointer = session_pointer(env, this)?;
        // SAFETY: Node roots the receiver for the entire callback.
        let state = unsafe { &*pointer };
        state.requests.set(0);
        state.processing_ms.set(0.0);
        undefined(env)
    })
}

/// napi module entry point exported by the `.node` wrapper crate; `env` and
/// `exports` are the raw napi handles Node passes at registration time.
/// # Safety
/// Called only by Node's module loader with valid napi handles.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rlint_napi_register_module_v1(env: Env, exports: Value) -> Value {
    #[cfg(feature = "typed-native")]
    crate::native::install_runner();
    boundary(env, || {
        method(env, exports, c"createSession", create_session)?;
        method(env, exports, c"attachSession", attach_session)?;
        method(env, exports, c"nativeAbi", native_abi)?;
        Ok(exports)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn node_api_module_get_api_version_v1() -> i32 {
    8
}
