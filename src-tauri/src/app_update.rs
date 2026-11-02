use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

const UPDATE_MANIFEST_URL: &str =
    "https://github.com/Kyin-code/KDock/releases/download/test-latest/kdock-update.json";
const DOWNLOAD_PREFIX: &str = "https://github.com/Kyin-code/KDock/releases/download/";
const RELEASE_PREFIX: &str = "https://github.com/Kyin-code/KDock/releases/";

#[derive(Debug, Deserialize)]
struct Manifest {
    schema: u32,
    version: String,
    build: String,
    #[serde(default)]
    published_at: String,
    #[serde(default)]
    notes: String,
    installer_url: String,
    #[serde(default)]
    sha256: String,
    release_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    current_version: String,
    current_build: String,
    latest_version: String,
    latest_build: String,
    available: bool,
    installer_url: String,
    sha256: String,
    release_url: String,
    published_at: String,
    notes: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedUpdate {
    path: String,
    sha256: String,
    bytes: u64,
    verified: bool,
}

fn valid_release_url(url: &str, download: bool) -> bool {
    let prefix = if download { DOWNLOAD_PREFIX } else { RELEASE_PREFIX };
    url.starts_with(prefix) && !url.contains('\0')
}

fn update_available(
    current_version: &Version,
    current_build: &str,
    latest_version: &Version,
    latest_build: &str,
) -> bool {
    if latest_version > current_version {
        return true;
    }
    latest_version == current_version
        && !current_build.is_empty()
        && current_build != "dev"
        && !latest_build.is_empty()
        && !current_build.eq_ignore_ascii_case(latest_build)
}

fn parse_manifest(raw: &str) -> Result<Manifest, String> {
    let manifest: Manifest =
        serde_json::from_str(raw).map_err(|e| format!("更新清单格式错误：{e}"))?;
    if manifest.schema != 1 {
        return Err(format!("不支持的更新清单版本：{}", manifest.schema));
    }
    Version::parse(&manifest.version).map_err(|e| format!("更新清单版本号无效：{e}"))?;
    if !valid_release_url(&manifest.installer_url, true) {
        return Err("更新清单的安装包地址不属于 KDock Release".into());
    }
    if !manifest.sha256.is_empty() && !valid_sha256(&manifest.sha256) {
        return Err("更新清单的安装包 SHA-256 格式无效".into());
    }
    if !valid_release_url(&manifest.release_url, false) {
        return Err("更新清单的 Release 地址无效".into());
    }
    Ok(manifest)
}

fn check_manifest(
    current_version: &str,
    current_build: &str,
    raw: &str,
) -> Result<UpdateCheck, String> {
    let manifest = parse_manifest(raw)?;
    let current =
        Version::parse(current_version).map_err(|e| format!("当前应用版本号无效：{e}"))?;
    let latest =
        Version::parse(&manifest.version).map_err(|e| format!("更新清单版本号无效：{e}"))?;
    Ok(UpdateCheck {
        current_version: current.to_string(),
        current_build: current_build.to_string(),
        latest_version: latest.to_string(),
        latest_build: manifest.build.clone(),
        available: update_available(&current, current_build, &latest, &manifest.build),
        installer_url: manifest.installer_url,
        sha256: manifest.sha256,
        release_url: manifest.release_url,
        published_at: manifest.published_at,
        notes: manifest.notes,
    })
}

fn fetch_manifest() -> Result<String, String> {
    let response = ureq::get(UPDATE_MANIFEST_URL)
        .set("Accept", "application/json")
        .set("User-Agent", concat!("KDock/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(8))
        .call()
        .map_err(|e| format!("检查更新失败：{e}"))?;
    response
        .into_string()
        .map_err(|e| format!("读取更新清单失败：{e}"))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn sha256_hex(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn installer_file_name(url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("安装包地址无效：{e}"))?;
    let name = parsed
        .path_segments()
        .and_then(|mut parts| parts.next_back())
        .unwrap_or("")
        .trim();
    let lower = name.to_ascii_lowercase();
    if !lower.starts_with("kdock_")
        || !lower.ends_with("_x64-setup.exe")
        || name.len() > 160
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err("更新清单里的安装包文件名无效".into());
    }
    Ok(name.to_string())
}

fn update_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("拿不到应用本地数据目录：{e}"))?
        .join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建更新目录失败：{e}"))?;
    Ok(dir)
}

fn estimate_percent(received: u64, total: u64) -> i64 {
    if total == 0 {
        -1
    } else {
        ((received.saturating_mul(100)) / total).min(100) as i64
    }
}

fn download_to_path<F>(
    url: &str,
    dst: &Path,
    expected_sha256: &str,
    mut progress: F,
) -> Result<(u64, String), String>
where
    F: FnMut(&str, i64, u64, u64),
{
    let expected = expected_sha256.trim().to_ascii_lowercase();
    if !expected.is_empty() && !valid_sha256(&expected) {
        return Err("安装包 SHA-256 格式无效".into());
    }
    if dst.is_file() && !expected.is_empty() {
        let mut file =
            std::fs::File::open(dst).map_err(|e| format!("读取已下载安装包失败：{e}"))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = file
                .read(&mut buf)
                .map_err(|e| format!("读取已下载安装包失败：{e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        let actual = sha256_hex(hasher);
        if actual == expected {
            let bytes = dst.metadata().map(|m| m.len()).unwrap_or(0);
            progress("verify", 100, bytes, bytes);
            return Ok((bytes, actual));
        }
    }

    let name = dst
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "KDock-update.exe".into());
    let part = dst.with_file_name(format!("{name}.part"));
    std::fs::remove_file(&part).ok();
    progress("download", 0, 0, 0);

    let response = ureq::get(url)
        .set("Accept", "application/octet-stream")
        .set("User-Agent", concat!("KDock/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(900))
        .call()
        .map_err(|e| format!("下载更新失败：{e}"))?;
    let total: u64 = response
        .header("Content-Length")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut reader = response.into_reader();
    let mut out = std::fs::File::create(&part)
        .map_err(|e| format!("创建临时安装包失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut last_pct = -2i64;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(n) => n,
            Err(e) => {
                drop(out);
                std::fs::remove_file(&part).ok();
                return Err(format!(
                    "下载中断（已接收 {} MB）：{e}",
                    received / 1_048_576
                ));
            }
        };
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])
            .map_err(|e| format!("写入临时安装包失败：{e}"))?;
        hasher.update(&buf[..n]);
        received += n as u64;
        let pct = estimate_percent(received, total);
        if pct != last_pct {
            last_pct = pct;
            progress("download", pct, received, total);
        }
    }
    out.flush()
        .map_err(|e| format!("刷新临时安装包失败：{e}"))?;
    drop(out);
    if total > 0 && received != total {
        std::fs::remove_file(&part).ok();
        return Err(format!(
            "下载不完整：收到 {received} 字节，应为 {total} 字节"
        ));
    }

    progress("verify", 100, received, total);
    let actual = sha256_hex(hasher);
    if !expected.is_empty() && actual != expected {
        std::fs::remove_file(&part).ok();
        return Err(format!(
            "安装包 SHA-256 校验失败：期望 {expected}，实际 {actual}"
        ));
    }
    if dst.exists() {
        std::fs::remove_file(dst).map_err(|e| format!("替换旧安装包失败：{e}"))?;
    }
    std::fs::rename(&part, dst).map_err(|e| format!("保存安装包失败：{e}"))?;
    Ok((received, actual))
}

#[tauri::command]
pub async fn app_update_download(
    app: AppHandle,
    url: String,
    sha256: String,
) -> Result<DownloadedUpdate, String> {
    if !valid_release_url(&url, true) {
        return Err("更新地址不属于 KDock Release".into());
    }
    let expected = sha256.trim().to_ascii_lowercase();
    if !expected.is_empty() && !valid_sha256(&expected) {
        return Err("安装包 SHA-256 格式无效".into());
    }
    let name = installer_file_name(&url)?;
    let dir = update_dir(&app)?;
    let dst = dir.join(name);
    let task_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (bytes, actual) = download_to_path(&url, &dst, &expected, |phase, pct, got, total| {
            let _ = task_app.emit(
                "app-update://progress",
                serde_json::json!({
                    "phase": phase,
                    "pct": pct,
                    "received": got,
                    "total": total,
                }),
            );
        })?;
        let _ = app.emit(
            "app-update://progress",
            serde_json::json!({
                "phase": "done",
                "pct": 100,
                "received": bytes,
                "total": bytes,
            }),
        );
        Ok(DownloadedUpdate {
            path: dst.to_string_lossy().to_string(),
            sha256: actual,
            bytes,
            verified: !expected.is_empty(),
        })
    })
    .await
    .map_err(|e| format!("更新下载任务失败：{e}"))?
}

#[tauri::command]
pub fn app_update_launch(app: AppHandle, path: String) -> Result<(), String> {
    let base = update_dir(&app)?
        .canonicalize()
        .map_err(|e| format!("解析更新目录失败：{e}"))?;
    let file = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("安装包不存在或无法访问：{e}"))?;
    if !file.starts_with(&base) || !file.is_file() {
        return Err("拒绝启动更新目录之外的文件".into());
    }
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !name.starts_with("kdock_") || !name.ends_with("_x64-setup.exe") {
        return Err("拒绝启动不是 KDock 安装包的文件".into());
    }
    let mut command = std::process::Command::new(&file);
    if let Some(parent) = file.parent() {
        command.current_dir(parent);
    }
    command
        .spawn()
        .map_err(|e| format!("启动安装程序失败：{e}"))?;
    Ok(())
}

/// Startup-only check. The frontend calls this once, outside the UI-ready path.
#[tauri::command]
pub fn app_update_check(app: AppHandle) -> Result<UpdateCheck, String> {
    let current_version = app.package_info().version.to_string();
    let current_build = env!("KDOCK_BUILD_ID");
    check_manifest(&current_version, current_build, &fetch_manifest()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn manifest(version: &str, build: &str) -> String {
        serde_json::json!({
            "schema": 1,
            "version": version,
            "build": build,
            "published_at": "2026-11-02T00:00:00Z",
            "notes": "test",
            "installer_url": "https://github.com/Kyin-code/KDock/releases/download/test-latest/KDock_0.3.1_x64-setup.exe",
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "release_url": "https://github.com/Kyin-code/KDock/releases/tag/test-latest"
        })
        .to_string()
    }

    #[test]
    fn version_and_build_comparison_handles_rolling_test_builds() {
        let newer = check_manifest("0.3.0", "aaaa", &manifest("0.3.1", "bbbb")).unwrap();
        assert!(newer.available);

        let same = check_manifest("0.3.1", "bbbb", &manifest("0.3.1", "bbbb")).unwrap();
        assert!(!same.available);

        let rebuild = check_manifest("0.3.1", "aaaa", &manifest("0.3.1", "bbbb")).unwrap();
        assert!(rebuild.available);

        let local_dev =
            check_manifest("0.3.1", "dev", &manifest("0.3.1", "bbbb")).unwrap();
        assert!(!local_dev.available);

        let older = check_manifest("0.3.2", "cccc", &manifest("0.3.1", "bbbb")).unwrap();
        assert!(!older.available);
    }

    #[test]
    fn update_manifest_rejects_external_download_urls() {
        let mut value: serde_json::Value =
            serde_json::from_str(&manifest("0.3.1", "bbbb")).unwrap();
        value["installer_url"] = serde_json::json!("https://example.com/setup.exe");
        let err = parse_manifest(&value.to_string()).unwrap_err();
        assert!(err.contains("不属于 KDock Release"));
    }

    #[test]
    fn update_manifest_validates_optional_sha256() {
        let mut value: serde_json::Value =
            serde_json::from_str(&manifest("0.3.1", "bbbb")).unwrap();
        value["sha256"] = serde_json::json!("not-a-hash");
        let err = parse_manifest(&value.to_string()).unwrap_err();
        assert!(err.contains("SHA-256"));

        value.as_object_mut().unwrap().remove("sha256");
        assert!(parse_manifest(&value.to_string()).is_ok());
    }

    #[test]
    fn update_installer_name_is_strict() {
        assert_eq!(
            installer_file_name(
                "https://github.com/Kyin-code/KDock/releases/download/test-latest/KDock_0.3.5_x64-setup.exe"
            )
            .unwrap(),
            "KDock_0.3.5_x64-setup.exe"
        );
        assert!(installer_file_name("https://github.com/Kyin-code/KDock/releases/download/test-latest/other.exe").is_err());
        assert!(installer_file_name("https://github.com/Kyin-code/KDock/releases/download/test-latest/../x.exe").is_err());
    }

    fn serve_once(body: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 2048];
            let _ = stream.read(&mut request);
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(response.as_bytes()).unwrap();
            stream.write_all(&body).unwrap();
        });
        format!("http://{addr}/KDock_0.3.5_x64-setup.exe")
    }

    #[test]
    fn update_download_verifies_hash_and_removes_bad_partial_file() {
        let temp = std::env::temp_dir().join(format!(
            "kdock-app-update-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&temp).unwrap();
        let dst = temp.join("KDock_0.3.5_x64-setup.exe");
        let body = b"fake installer payload".to_vec();
        let mut hasher = Sha256::new();
        hasher.update(&body);
        let hash = sha256_hex(hasher);

        let url = serve_once(body.clone());
        let (bytes, actual) =
            download_to_path(&url, &dst, &hash, |_, _, _, _| {}).unwrap();
        assert_eq!(bytes as usize, body.len());
        assert_eq!(actual, hash);
        assert_eq!(std::fs::read(&dst).unwrap(), body);
        #[cfg(windows)]
        assert!(
            std::fs::read(format!("{}:Zone.Identifier", dst.display())).is_err(),
            "程序内下载不应写入 Mark-of-the-Web"
        );

        std::fs::remove_file(&dst).unwrap();
        let url = serve_once(body);
        let bad = "0".repeat(64);
        let err = download_to_path(&url, &dst, &bad, |_, _, _, _| {}).unwrap_err();
        assert!(err.contains("校验失败"));
        assert!(!dst.exists());
        assert!(!dst.with_file_name("KDock_0.3.5_x64-setup.exe.part").exists());
        let _ = std::fs::remove_dir_all(temp);
    }
}
