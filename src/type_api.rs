use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use clap::Parser;
use serde::{Deserialize, Serialize};
use tsrs_api::{ClientConn, Handler as _, Session, SessionOptions};
use tsrs_api_transport as transport;
use tsrs_api_transport::{CallbackConfig, CallbackFs};
use tsrs_vfs::{FS, bundled, osvfs, wrapvfs};

#[derive(Parser)]
struct ApiOptions {
    #[arg(long)]
    api: bool,
    #[arg(long)]
    cwd: PathBuf,
    #[arg(long = "useCaseSensitiveFileNames", action = clap::ArgAction::Set)]
    case_sensitive: bool,
    #[arg(long)]
    timing: bool,
}

pub(crate) fn library_path(cwd: &Path) -> String {
    for directory in cwd.ancestors() {
        let library = directory.join("node_modules/typescript/lib");
        if library.join("lib.d.ts").is_file() && library.join("lib.es5.d.ts").is_file() {
            return library.to_string_lossy().into_owned();
        }
    }
    bundled::lib_path()
}

fn installed_library_names(library_path: &str) -> BTreeMap<String, String> {
    let read = || -> Option<BTreeMap<String, String>> {
        let source = std::fs::read_to_string(Path::new(library_path).join("typescript.js")).ok()?;
        let (_, entries) = source.split_once("var libEntries = ")?;
        let end = entries.find("\n];")? + 2;
        let names: Vec<[String; 2]> =
            serde_json::from_str(&crate::jsonc::strip(&entries[..end])).ok()?;
        Some(
            names
                .into_iter()
                .map(|[alias, file]| (alias, file))
                .collect(),
        )
    };
    read().unwrap_or_default()
}

pub(crate) fn library_fs(library_path: &str) -> Arc<dyn FS> {
    // tsrs and installed TypeScript can assign different filenames to the same ESNext alias.
    let installed_names = installed_library_names(library_path);
    let mut aliases = BTreeMap::new();
    for (alias, value) in tsrs_tsoptions::LIB_MAP.iter() {
        let Some(name) = value.as_str() else { continue };
        let path = Path::new(library_path).join(name);
        if path.is_file() {
            continue;
        }
        let installed = Path::new(library_path).join(
            installed_names
                .get(*alias)
                .cloned()
                .unwrap_or_else(|| format!("lib.{alias}.d.ts")),
        );
        if installed.is_file() {
            aliases
                .entry(path.to_string_lossy().into_owned())
                .or_insert_with(|| installed.to_string_lossy().into_owned());
        }
    }
    let aliases = Arc::new(aliases);
    let existing = Arc::clone(&aliases);
    let contents = Arc::clone(&aliases);
    let metadata = Arc::clone(&aliases);
    let canonical = Arc::clone(&aliases);
    let entries = Arc::clone(&aliases);
    let fs = wrapvfs::wrap(
        osvfs::fs(),
        wrapvfs::Replacements {
            file_exists: Some(Box::new(move |path| {
                osvfs::fs().file_exists(existing.get(path).map_or(path, String::as_str))
            })),
            read_file: Some(Box::new(move |path| {
                osvfs::fs().read_file(contents.get(path).map_or(path, String::as_str))
            })),
            stat: Some(Box::new(move |path| {
                let mut info = osvfs::fs().stat(metadata.get(path).map_or(path, String::as_str))?;
                if metadata.contains_key(path) {
                    info.name = Path::new(path).file_name()?.to_string_lossy().into_owned();
                }
                Some(info)
            })),
            realpath: Some(Box::new(move |path| {
                osvfs::fs().realpath(canonical.get(path).map_or(path, String::as_str))
            })),
            get_accessible_entries: Some(Box::new(move |path| {
                let mut found = osvfs::fs().get_accessible_entries(path);
                for alias in entries.keys() {
                    let alias = Path::new(alias);
                    if alias.parent() == Some(Path::new(path))
                        && let Some(name) = alias.file_name()
                    {
                        found.files.push(name.to_string_lossy().into_owned());
                    }
                }
                found.files.sort();
                found.files.dedup();
                found
            })),
            ..wrapvfs::Replacements::default()
        },
    );
    Arc::new(bundled::wrap_fs(fs))
}

struct SessionHandler(Arc<Session>);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AssignabilityBatch {
    snapshot: u64,
    project: String,
    source: u32,
    targets: Vec<u32>,
}

#[derive(Serialize)]
struct AssignabilityQuery<'a> {
    snapshot: u64,
    project: &'a str,
    source: u32,
    target: u32,
}

fn assignability_batch(
    session: &Arc<Session>,
    params: &[u8],
    depth: u32,
) -> tsrs_api::ApiResult<tsrs_api::Response> {
    let batch: AssignabilityBatch = serde_json::from_slice(params)
        .map_err(|error| tsrs_api::ApiError::internal(error.to_string()))?;
    if batch.targets.len() > 64 {
        return Err(tsrs_api::ApiError::internal(
            "Assignability batches allow at most 64 targets",
        ));
    }
    if std::env::var_os("LINTRS_TRUE_BULK").is_some_and(|value| value == "1") {
        return session.handle_nested_request("lintrsIsTypeAssignableToManyNative", params, depth);
    }
    let mut answers = Vec::with_capacity(batch.targets.len());
    for target in batch.targets {
        let query = AssignabilityQuery {
            snapshot: batch.snapshot,
            project: &batch.project,
            source: batch.source,
            target,
        };
        let params = serde_json::to_vec(&query)
            .map_err(|error| tsrs_api::ApiError::internal(error.to_string()))?;
        let response = session.handle_nested_request("isTypeAssignableTo", &params, depth)?;
        match response {
            tsrs_api::Response::Json(value) if value == "true" => answers.push(true),
            tsrs_api::Response::Json(value) if value == "false" => answers.push(false),
            _ => {
                return Err(tsrs_api::ApiError::internal(
                    "Unexpected assignability response",
                ));
            }
        }
    }
    serde_json::to_string(&answers)
        .map(tsrs_api::Response::Json)
        .map_err(|error| tsrs_api::ApiError::internal(error.to_string()))
}

fn dispatch(
    session: &Arc<Session>,
    method: &str,
    params: &[u8],
    depth: u32,
) -> tsrs_api::ApiResult<tsrs_api::Response> {
    if method == "lintrsIsTypeAssignableToMany" {
        assignability_batch(session, params, depth)
    } else {
        session.handle_nested_request(method, params, depth)
    }
}

#[cfg(feature = "in-process-node")]
pub(crate) fn dispatch_in_process(
    session: &Arc<Session>,
    method: &str,
    params: &[u8],
) -> tsrs_api::ApiResult<tsrs_api::Response> {
    if method == "lintrsNativeProbe" {
        #[derive(Deserialize)]
        struct Probe {
            #[serde(default)]
            libraries: Vec<String>,
        }
        #[derive(Serialize)]
        struct ProbeOut {
            host: usize,
            plugins: std::collections::BTreeMap<String, Option<usize>>,
        }
        let probe: Probe = serde_json::from_slice(params)
            .map_err(|error| tsrs_api::ApiError::invalid_request(error.to_string()))?;
        let out = ProbeOut {
            host: crate::native::probe_address(),
            plugins: probe
                .libraries
                .iter()
                .map(|library| (library.clone(), crate::native::plugin_probe(library)))
                .collect(),
        };
        return serde_json::to_string(&out)
            .map(tsrs_api::Response::Json)
            .map_err(|error| tsrs_api::ApiError::internal(error.to_string()));
    }
    dispatch(session, method, params, 0)
}

impl transport::Handler for SessionHandler {
    fn handle_request(
        &self,
        context: &transport::RequestContext,
        method: &str,
        params: &[u8],
    ) -> Result<transport::Response, transport::ApiError> {
        match dispatch(&self.0, method, params, context.depth) {
            Ok(tsrs_api::Response::Json(value)) => {
                Ok(transport::Response::Json(value.into_bytes()))
            }
            Ok(tsrs_api::Response::Binary(value)) => Ok(transport::Response::Binary(value)),
            Err(error) => Err(transport::ApiError::internal(error.to_string())),
        }
    }

    fn handle_notification(
        &self,
        _context: &transport::RequestContext,
        method: &str,
        params: &[u8],
    ) {
        let _ = self.0.handle_notification(method, params);
    }
}

impl Drop for SessionHandler {
    fn drop(&mut self) {
        self.0.close();
    }
}

struct ClientConnection(Arc<dyn transport::Caller>);

impl ClientConn for ClientConnection {
    fn call(&self, method: &str, params: &str) -> tsrs_api::ApiResult<String> {
        let response = self
            .0
            .call(method, Some(params.as_bytes()))
            .map_err(|error| tsrs_api::ApiError::internal(error.to_string()))?;
        String::from_utf8(response).map_err(|error| tsrs_api::ApiError::internal(error.to_string()))
    }
}

pub fn run() -> anyhow::Result<()> {
    let flags = ApiOptions::parse();
    let library_path = library_path(&flags.cwd);
    let base = library_fs(&library_path);
    let callback_fs = Arc::new(CallbackFs::new(
        base,
        &CallbackConfig::default(),
        Some(flags.case_sensitive),
    ));
    let fs: Arc<dyn FS> = callback_fs.clone();
    let session = Session::new(SessionOptions::new(
        flags.cwd.to_string_lossy().into_owned(),
        library_path,
        fs,
        true,
    ));
    let mut options = transport::ServeOptions::new(false);
    options.collect_timing = flags.timing;
    transport::serve(None, options, |caller| {
        callback_fs.set_connection(caller.clone());
        session.set_connection(Arc::new(ClientConnection(caller)));
        Arc::new(SessionHandler(session))
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{library_fs, library_path};
    use std::fs;
    use tsrs_vfs::bundled;

    #[test]
    fn libraries_follow_the_nearest_typescript_installation() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("packages/workspace");
        fs::create_dir_all(&workspace).unwrap();
        assert_eq!(library_path(&workspace), bundled::lib_path());
        for base in [root.path(), workspace.as_path()] {
            let library = base.join("node_modules/typescript/lib");
            fs::create_dir_all(&library).unwrap();
            fs::write(library.join("lib.d.ts"), "").unwrap();
            fs::write(library.join("lib.es5.d.ts"), "").unwrap();
            assert_eq!(library_path(&workspace), library.to_string_lossy());
        }
    }
    #[test]
    fn missing_library_names_read_installed_aliases_and_keep_existing_files() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("typescript.js"), "var libEntries = [\n  // installed aliases\n  [\"esnext.collection\", \"lib.esnext.collection.d.ts\"],\n  [\"esnext.iterator\", \"lib.es2025.iterator.d.ts\"],\n];\n").unwrap();
        let installed = root.path().join("lib.esnext.collection.d.ts");
        fs::write(&installed, "installed collections").unwrap();
        let name = tsrs_tsoptions::get_lib_file_name("esnext.collection").unwrap();
        let canonical = root.path().join(name);
        let filesystem = library_fs(root.path().to_str().unwrap());
        let path = canonical.to_str().unwrap();
        assert!(filesystem.file_exists(path));
        assert_eq!(
            filesystem.read_file(path).as_deref(),
            Some("installed collections")
        );
        assert_eq!(
            filesystem.realpath(path),
            installed.canonicalize().unwrap().to_string_lossy()
        );
        assert_eq!(
            filesystem.stat(path).unwrap().name,
            canonical.file_name().unwrap().to_string_lossy()
        );
        assert!(
            filesystem
                .get_accessible_entries(root.path().to_str().unwrap())
                .files
                .contains(
                    &canonical
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned()
                )
        );
        let iterator = root.path().join("lib.es2025.iterator.d.ts");
        fs::write(&iterator, "installed iterator").unwrap();
        let iterator_name = tsrs_tsoptions::get_lib_file_name("esnext.iterator").unwrap();
        let filesystem = library_fs(root.path().to_str().unwrap());
        assert_eq!(
            filesystem
                .read_file(root.path().join(iterator_name).to_str().unwrap())
                .as_deref(),
            Some("installed iterator")
        );
        fs::write(&canonical, "existing canonical file").unwrap();
        let filesystem = library_fs(root.path().to_str().unwrap());
        assert_eq!(
            filesystem.read_file(path).as_deref(),
            Some("existing canonical file")
        );
        assert!(!filesystem.file_exists(root.path().join("missing.d.ts").to_str().unwrap()));
    }
}
