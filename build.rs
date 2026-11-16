//! Emits the rustc version and a build identifier so the native-rules ABI
//! fingerprint can pin the exact compiler a rule library must be built with.

use std::process::Command;

fn main() {
    let rustc = Command::new(std::env::var("RUSTC").unwrap_or_else(|_| "rustc".into()))
        .arg("-V")
        .output()
        .expect("rustc -V must run in the rlint build script");
    let version = String::from_utf8(rustc.stdout).expect("rustc -V must print UTF-8");
    let version = version
        .strip_prefix("rustc ")
        .and_then(|rest| rest.split_whitespace().next())
        .expect("rustc -V must print a version");
    println!("cargo:rustc-env=RLINT_RUSTC_VERSION={version}");

    let build_id = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_else(|| "release".to_string());
    println!("cargo:rustc-env=RLINT_BUILD_ID={build_id}");
}
