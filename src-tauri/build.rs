fn main() {
    let build = std::env::var("KDOCK_BUILD_ID")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            std::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()
                .filter(|out| out.status.success())
                .and_then(|out| String::from_utf8(out.stdout).ok())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "dev".into());
    println!("cargo:rustc-env=KDOCK_BUILD_ID={build}");
    println!("cargo:rerun-if-env-changed=KDOCK_BUILD_ID");
    tauri_build::build()
}

