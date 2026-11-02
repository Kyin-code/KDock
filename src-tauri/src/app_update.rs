use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

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
    release_url: String,
    published_at: String,
    notes: String,
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

    fn manifest(version: &str, build: &str) -> String {
        serde_json::json!({
            "schema": 1,
            "version": version,
            "build": build,
            "published_at": "2026-11-02T00:00:00Z",
            "notes": "test",
            "installer_url": "https://github.com/Kyin-code/KDock/releases/download/test-latest/KDock_0.3.1_x64-setup.exe",
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
}
