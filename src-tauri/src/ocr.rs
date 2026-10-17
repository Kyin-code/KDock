//! Windows 自带 OCR（Windows.Media.Ocr）的薄封装。
//!
//! 不引入 Tesseract/本地模型：Win10/11 已经带 OCR 引擎和语言包，缺语言包时返回
//! 一句能看懂的错。只做“把 PNG 里的文字读出来”，图片理解仍交给视觉模型。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

const SCRIPT: &str = r#"
param([Parameter(Mandatory=$true)][string]$Path)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, [Type]$type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait()
  $task.Result
}
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime] | Out-Null
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) { throw "No Windows OCR language pack is available" }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$result.Text
"#;

fn script_path() -> Result<&'static PathBuf, String> {
    static PATH: OnceLock<PathBuf> = OnceLock::new();
    if let Some(p) = PATH.get() {
        return Ok(p);
    }
    let p = std::env::temp_dir().join("kdock_ocr.ps1");
    std::fs::write(&p, SCRIPT).map_err(|e| format!("写 OCR 脚本失败: {e}"))?;
    let _ = PATH.set(p);
    PATH.get().ok_or_else(|| "OCR 脚本初始化失败".to_string())
}

/// 对一张本地图片跑 Windows OCR
pub fn ocr_image(path: &Path) -> Result<String, String> {
    #[cfg(not(windows))]
    {
        let _ = path;
        return Err("OCR 目前只在 Windows 上可用".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let script = script_path()?;
        let mut cmd = Command::new("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script.to_string_lossy(),
            "-Path",
            &path.to_string_lossy(),
        ]);
        cmd.creation_flags(0x0800_0000);
        let out = cmd
            .output()
            .map_err(|e| format!("启动 Windows OCR 失败: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(format!(
                "Windows OCR 失败（退出码 {:?}）：{}",
                out.status.code(),
                if err.is_empty() { &text } else { &err }
            ));
        }
        if text.is_empty() {
            Ok("（OCR 没有识别出文字）".into())
        } else {
            Ok(text)
        }
    }
}
