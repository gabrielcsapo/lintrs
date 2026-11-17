use super::*;
use tsrs_core::collections::OrderedMap;
use tsrs_core::json::Value as Json;

unsafe extern "C" {
    fn napi_typeof(env: Env, value: Value, result: *mut i32) -> i32;
    fn napi_get_value_double(env: Env, value: Value, result: *mut f64) -> i32;
    fn napi_get_value_bool(env: Env, value: Value, result: *mut bool) -> i32;
    fn napi_get_value_string_utf16(
        env: Env,
        value: Value,
        data: *mut u16,
        size: usize,
        result: *mut usize,
    ) -> i32;
    fn napi_is_array(env: Env, value: Value, result: *mut bool) -> i32;
    fn napi_get_array_length(env: Env, value: Value, result: *mut u32) -> i32;
    fn napi_get_element(env: Env, value: Value, index: u32, result: *mut Value) -> i32;
    fn napi_get_property(env: Env, value: Value, key: Value, result: *mut Value) -> i32;
    fn napi_get_all_property_names(
        env: Env,
        value: Value,
        mode: i32,
        filter: i32,
        conversion: i32,
        result: *mut Value,
    ) -> i32;
    fn napi_get_prototype(env: Env, value: Value, result: *mut Value) -> i32;
    fn napi_get_global(env: Env, result: *mut Value) -> i32;
    fn napi_strict_equals(env: Env, left: Value, right: Value, result: *mut bool) -> i32;
    fn napi_get_null(env: Env, result: *mut Value) -> i32;
    fn napi_get_boolean(env: Env, value: bool, result: *mut Value) -> i32;
    fn napi_create_double(env: Env, value: f64, result: *mut Value) -> i32;
    fn napi_create_array_with_length(env: Env, size: usize, result: *mut Value) -> i32;
    fn napi_set_element(env: Env, value: Value, index: u32, element: Value) -> i32;
    fn napi_set_property(env: Env, value: Value, key: Value, element: Value) -> i32;
    fn napi_is_typedarray(env: Env, value: Value, result: *mut bool) -> i32;
    fn napi_is_arraybuffer(env: Env, value: Value, result: *mut bool) -> i32;
    fn napi_is_detached_arraybuffer(env: Env, value: Value, result: *mut bool) -> i32;
    fn napi_get_typedarray_info(
        env: Env,
        value: Value,
        kind: *mut i32,
        length: *mut usize,
        data: *mut *mut c_void,
        buffer: *mut Value,
        offset: *mut usize,
    ) -> i32;
    // Node-API 10 (Node >= 22.9; lintrs requires Node 24): creates the
    // internalized string V8 uses for property names, so setting a property
    // with it skips V8's per-assignment string-table lookup.
    fn node_api_create_property_key_utf8(
        env: Env,
        data: *const c_char,
        length: usize,
        result: *mut Value,
    ) -> i32;
}

// All Node calls below run on the owning environment's thread. Inputs are converted before acquiring
// a checker, and outputs are converted after the lease is released, so getters cannot reenter it.
fn kind(env: Env, value: Value) -> Result<i32, String> {
    let mut result = 0;
    checked(unsafe { napi_typeof(env, value, &mut result) })?;
    Ok(result)
}

fn same(env: Env, left: Value, right: Value) -> Result<bool, String> {
    let mut result = false;
    checked(unsafe { napi_strict_equals(env, left, right, &mut result) })?;
    Ok(result)
}

fn number(env: Env, value: Value) -> Result<f64, String> {
    let mut result = 0.0;
    checked(unsafe { napi_get_value_double(env, value, &mut result) })?;
    if !result.is_finite() {
        return Err("Typed queries reject non-finite numbers".to_owned());
    }
    Ok(result)
}

fn unsigned(env: Env, value: Value, max: f64) -> Result<u64, String> {
    let result = number(env, value)?;
    if result < 0.0 || result > max || result.fract() != 0.0 {
        return Err("Expected an unsigned integer in range".to_owned());
    }
    Ok(result as u64)
}

fn strict_string(env: Env, value: Value) -> Result<String, String> {
    let mut short = [0u16; 256];
    let mut length = 0;
    checked(unsafe {
        napi_get_value_string_utf16(env, value, short.as_mut_ptr(), short.len(), &mut length)
    })?;
    if length < short.len() - 1 {
        return String::from_utf16(&short[..length])
            .map_err(|_| "Typed queries reject unpaired UTF-16 surrogates".to_owned());
    }
    checked(unsafe { napi_get_value_string_utf16(env, value, ptr::null_mut(), 0, &mut length) })?;
    let mut units = vec![0u16; length + 1];
    checked(unsafe {
        napi_get_value_string_utf16(env, value, units.as_mut_ptr(), units.len(), &mut length)
    })?;
    units.truncate(length);
    String::from_utf16(&units)
        .map_err(|_| "Typed queries reject unpaired UTF-16 surrogates".to_owned())
}

fn get(env: Env, value: Value, key: &str) -> Result<Value, String> {
    let mut result = ptr::null_mut();
    checked(unsafe { napi_get_property(env, value, js_string(env, key)?, &mut result) })?;
    Ok(result)
}

fn element(env: Env, value: Value, index: u32) -> Result<Value, String> {
    let mut result = ptr::null_mut();
    checked(unsafe { napi_get_element(env, value, index, &mut result) })?;
    Ok(result)
}

fn length(env: Env, value: Value) -> Result<u32, String> {
    let mut result = 0;
    checked(unsafe { napi_get_array_length(env, value, &mut result) })?;
    Ok(result)
}

struct Decoder {
    ancestors: Vec<Value>,
    remaining: usize,
    /// `Object.prototype`, looked up on the first non-array object of a call
    /// rather than once per object (each lookup reads the global and creates
    /// two key strings).
    plain: Option<Value>,
}

impl Decoder {
    fn decode(&mut self, env: Env, value: Value) -> Result<Json, String> {
        self.decode_kind(env, value, kind(env, value)?)
    }

    fn decode_kind(&mut self, env: Env, value: Value, kind: i32) -> Result<Json, String> {
        if self.remaining == 0 || self.ancestors.len() > 64 {
            return Err("Typed query input exceeds its size or depth limit".to_owned());
        }
        self.remaining -= 1;
        match kind {
            0 | 1 => Ok(Json::Null),
            2 => {
                let mut result = false;
                checked(unsafe { napi_get_value_bool(env, value, &mut result) })?;
                Ok(Json::Bool(result))
            }
            3 => Ok(Json::Number(number(env, value)?)),
            4 => Ok(Json::String(strict_string(env, value)?)),
            6 => {
                for ancestor in &self.ancestors {
                    if same(env, *ancestor, value)? {
                        return Err("Typed queries reject cyclic objects".to_owned());
                    }
                }
                self.ancestors.push(value);
                let result = self.object(env, value);
                self.ancestors.pop();
                result
            }
            _ => Err("Typed queries accept JSON-compatible plain values only".to_owned()),
        }
    }

    fn object(&mut self, env: Env, value: Value) -> Result<Json, String> {
        let mut array = false;
        checked(unsafe { napi_is_array(env, value, &mut array) })?;
        if array {
            let count = length(env, value)?;
            if count as usize > self.remaining {
                return Err("Typed query array exceeds its size limit".to_owned());
            }
            return (0..count)
                .map(|index| self.decode(env, element(env, value, index)?))
                .collect::<Result<Vec<_>, _>>()
                .map(Json::Array);
        }
        let mut prototype = ptr::null_mut();
        checked(unsafe { napi_get_prototype(env, value, &mut prototype) })?;
        if kind(env, prototype)? != 1 {
            let plain = match self.plain {
                Some(plain) => plain,
                None => {
                    let mut global = ptr::null_mut();
                    checked(unsafe { napi_get_global(env, &mut global) })?;
                    let plain = get(env, get(env, global, "Object")?, "prototype")?;
                    self.plain = Some(plain);
                    plain
                }
            };
            if !same(env, prototype, plain)? {
                return Err("Typed queries require plain objects".to_owned());
            }
        }
        let mut names = ptr::null_mut();
        // Own enumerable string keys, including numeric keys converted to strings. Symbol keys are
        // omitted like JSON.stringify; symbol values still fail conversion.
        checked(unsafe { napi_get_all_property_names(env, value, 1, 18, 1, &mut names) })?;
        let count = length(env, names)?;
        if count as usize > self.remaining {
            return Err("Typed query object exceeds its size limit".to_owned());
        }
        let mut fields = OrderedMap::default();
        for index in 0..count {
            let key_value = element(env, names, index)?;
            let key = strict_string(env, key_value)?;
            let mut field = ptr::null_mut();
            checked(unsafe { napi_get_property(env, value, key_value, &mut field) })?;
            let field_kind = kind(env, field)?;
            if field_kind != 0 {
                fields.insert(key, self.decode_kind(env, field, field_kind)?);
            }
        }
        Ok(Json::Object(fields))
    }
}

fn decode(env: Env, value: Value) -> Result<Json, String> {
    Decoder {
        ancestors: Vec::new(),
        remaining: 100_000,
        plain: None,
    }
    .decode(env, value)
}

/// Builds a result's JS value. Responses are mostly arrays of same-shaped
/// objects (types, symbols, nodes), so each distinct key is created once per
/// result, as an internalized property key, and reused for every object.
/// Handles stay valid for the whole callback: no handle scope closes inside.
struct Encoder<'a> {
    env: Env,
    keys: HashMap<&'a str, Value>,
}

impl<'a> Encoder<'a> {
    fn key(&mut self, key: &'a str) -> Result<Value, String> {
        if let Some(handle) = self.keys.get(key) {
            return Ok(*handle);
        }
        let mut handle = ptr::null_mut();
        // SAFETY: Node copies exactly key.len() bytes before returning.
        checked(unsafe {
            node_api_create_property_key_utf8(self.env, key.as_ptr().cast(), key.len(), &mut handle)
        })?;
        self.keys.insert(key, handle);
        Ok(handle)
    }

    fn value(&mut self, value: &'a Json) -> Result<Value, String> {
        let env = self.env;
        let mut result = ptr::null_mut();
        match value {
            Json::Null => checked(unsafe { napi_get_null(env, &mut result) })?,
            Json::Bool(value) => checked(unsafe { napi_get_boolean(env, *value, &mut result) })?,
            Json::Number(value) => {
                checked(unsafe { napi_create_double(env, *value, &mut result) })?
            }
            Json::Integer(value) => {
                checked(unsafe { napi_create_double(env, *value as f64, &mut result) })?
            }
            Json::String(value) => return js_string(env, value),
            Json::Array(values) => {
                checked(unsafe { napi_create_array_with_length(env, values.len(), &mut result) })?;
                for (index, value) in values.iter().enumerate() {
                    let element = self.value(value)?;
                    checked(unsafe {
                        napi_set_element(
                            env,
                            result,
                            u32::try_from(index).map_err(|_| "Output array too large")?,
                            element,
                        )
                    })?;
                }
            }
            Json::Object(fields) => {
                checked(unsafe { napi_create_object(env, &mut result) })?;
                for (key, value) in fields {
                    let key = self.key(key)?;
                    let value = self.value(value)?;
                    checked(unsafe { napi_set_property(env, result, key, value) })?;
                }
            }
        }
        Ok(result)
    }
}

fn encode(env: Env, value: &Json) -> Result<Value, String> {
    Encoder {
        env,
        keys: HashMap::new(),
    }
    .value(value)
}

fn with_session(
    env: Env,
    this: Value,
    entered: Instant,
    action: impl FnOnce(&Session) -> Result<Json, tsrs_api::ApiError>,
) -> Result<Value, String> {
    let pointer = session_pointer(env, this)?;
    // SAFETY: The receiver is rooted by Node for this callback and has the validated session tag.
    let state = unsafe { &*pointer };
    let session = state
        .session
        .borrow()
        .clone()
        .ok_or("The in-process session is closed")?;
    let start = Instant::now();
    state
        .arguments_ms
        .set(state.arguments_ms.get() + (start - entered).as_secs_f64() * 1000.0);
    let response = action(&session);
    let encoding = Instant::now();
    let elapsed = (encoding - start).as_secs_f64() * 1000.0;
    state.requests.set(state.requests.get() + 1);
    state.processing_ms.set(state.processing_ms.get() + elapsed);
    publish_compute(env, state, elapsed);
    let value = encode(env, &response.map_err(|error| error.to_string())?)?;
    state
        .results_ms
        .set(state.results_ms.get() + encoding.elapsed().as_secs_f64() * 1000.0);
    publish_native(env, state, entered);
    Ok(value)
}

unsafe extern "C" fn typed_methods(env: Env, info: CallbackInfo) -> Value {
    boundary(env, || {
        let (_, this) = arguments::<0>(env, info)?;
        let pointer = session_pointer(env, this)?;
        let state = unsafe { &*pointer };
        let session = state
            .session
            .borrow()
            .clone()
            .ok_or("The in-process session is closed")?;
        encode(
            env,
            &Json::Array(
                session
                    .lintrs_typed_methods()
                    .into_iter()
                    .map(|name| Json::String(name.to_owned()))
                    .collect(),
            ),
        )
    })
}

unsafe extern "C" fn request_value(env: Env, info: CallbackInfo) -> Value {
    boundary(env, || {
        let entered = Instant::now();
        let ([method, params], this) = arguments(env, info)?;
        let method = strict_string(env, method)?;
        if kind(env, params)? != 6 {
            return Err("Typed query params must be a plain object".to_owned());
        }
        let params = decode(env, params)?;
        if !matches!(params, Json::Object(_)) {
            return Err("Typed query params must be a plain object".to_owned());
        }
        with_session(env, this, entered, |session| {
            session.lintrs_typed_query(&method, &params)
        })
    })
}

fn indices(env: Env, value: Value) -> Result<Vec<u32>, String> {
    let mut typed = false;
    checked(unsafe { napi_is_typedarray(env, value, &mut typed) })?;
    if !typed {
        return Err("nodeFacts indices must be a Uint32Array".to_owned());
    }
    let mut kind = 0;
    let mut count = 0;
    let mut data = ptr::null_mut();
    let mut buffer = ptr::null_mut();
    let mut offset = 0;
    checked(unsafe {
        napi_get_typedarray_info(
            env,
            value,
            &mut kind,
            &mut count,
            &mut data,
            &mut buffer,
            &mut offset,
        )
    })?;
    if kind != 6 || count > 256 {
        return Err("nodeFacts requires a Uint32Array of at most 256 indices".to_owned());
    }
    let mut ordinary = false;
    checked(unsafe { napi_is_arraybuffer(env, buffer, &mut ordinary) })?;
    if !ordinary {
        return Err("Shared indices are unsupported".to_owned());
    }
    let mut detached = false;
    checked(unsafe { napi_is_detached_arraybuffer(env, buffer, &mut detached) })?;
    if detached {
        return Err("nodeFacts indices are detached".to_owned());
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    if data.is_null() {
        return Err("nodeFacts indices are detached".to_owned());
    }
    // SAFETY: NAPI guarantees this ordinary, non-shared Uint32Array's length and alignment. No JS
    // callback runs while copying, so its backing buffer cannot change or detach during this read.
    Ok(unsafe { std::slice::from_raw_parts(data.cast::<u32>(), count) }.to_vec())
}

unsafe extern "C" fn node_facts(env: Env, info: CallbackInfo) -> Value {
    boundary(env, || {
        let entered = Instant::now();
        let ([snapshot, project, file, nodes, mask], this) = arguments(env, info)?;
        let snapshot = unsigned(env, snapshot, 9_007_199_254_740_991.0)?;
        let project = strict_string(env, project)?;
        let file = strict_string(env, file)?;
        let nodes = indices(env, nodes)?;
        let mask = u32::try_from(unsigned(env, mask, f64::from(u32::MAX))?)
            .map_err(|error| error.to_string())?;
        with_session(env, this, entered, |session| {
            session.lintrs_node_facts(snapshot, &project, &file, &nodes, mask)
        })
    })
}

unsafe extern "C" fn object_property(env: Env, info: CallbackInfo) -> Value {
    boundary(env, || {
        let entered = Instant::now();
        let ([snapshot, project, kind, handle, property], this) = arguments(env, info)?;
        let snapshot = unsigned(env, snapshot, 9_007_199_254_740_991.0)?;
        let project = strict_string(env, project)?;
        let kind = strict_string(env, kind)?;
        let handle = decode(env, handle)?;
        let property = strict_string(env, property)?;
        let mut missing = false;
        let result = with_session(env, this, entered, |session| {
            session
                .lintrs_object_property(snapshot, &project, &kind, &handle, &property)
                .map(|value| {
                    missing = value.is_none();
                    value.unwrap_or(Json::Null)
                })
        })?;
        if missing { undefined(env) } else { Ok(result) }
    })
}

unsafe extern "C" fn node_facts_planned(env: Env, info: CallbackInfo) -> Value {
    boundary(env, || {
        let entered = Instant::now();
        let ([snapshot, project, file, nodes, mask, fields], this) = arguments(env, info)?;
        let snapshot = unsigned(env, snapshot, 9_007_199_254_740_991.0)?;
        let project = strict_string(env, project)?;
        let file = strict_string(env, file)?;
        let nodes = indices(env, nodes)?;
        let mask = u32::try_from(unsigned(env, mask, f64::from(u32::MAX))?)
            .map_err(|error| error.to_string())?;
        let Json::Array(fields) = decode(env, fields)? else {
            return Err("nodeFactsPlanned symbol fields must be a string array".to_owned());
        };
        let fields = fields
            .into_iter()
            .map(|field| match field {
                Json::String(field) => Ok(field),
                _ => Err("nodeFactsPlanned symbol fields must be strings".to_owned()),
            })
            .collect::<Result<Vec<_>, _>>()?;
        with_session(env, this, entered, |session| {
            session.lintrs_node_facts_planned(snapshot, &project, &file, &nodes, mask, &fields)
        })
    })
}

pub(super) fn install(env: Env, object: Value) -> Result<(), String> {
    method(env, object, c"typedMethods", typed_methods)?;
    method(env, object, c"requestValue", request_value)?;
    method(env, object, c"nodeFacts", node_facts)?;
    method(env, object, c"nodeFactsPlanned", node_facts_planned)?;
    method(env, object, c"objectProperty", object_property)
}
