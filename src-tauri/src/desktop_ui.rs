//! Windows 本机 UI 自动化：给 Agent 一个比“现场写 PowerShell 脚本”
//! 更稳定的结构化入口。
//!
//! 识别顺序刻意分层：
//! 1. UI Automation 控件树：窗口、按钮、输入框、菜单项的 Name /
//!    AutomationId / ClassName / 边界矩形；
//! 2. 确定性 Win32 菜单命令：MFC 自绘控件常常不暴露 UIA，但菜单命令 ID 稳定；
//! 3. 截图 + OCR / 视觉模型只作最后兜底。
//!
//! 这些工具只负责自动化，不绕过 KDock 的权限闸门。`desktop_action` 会改变
//! 其他软件的状态，必须经过危险工具审批。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const WINDOWS_PS: &str = r#"
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$all = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Children,
  [System.Windows.Automation.Condition]::TrueCondition
)
$rows = New-Object System.Collections.ArrayList
foreach ($el in $all) {
  try {
    $c = $el.Current
    if ($c.ControlType -ne [System.Windows.Automation.ControlType]::Window) { continue }
    if ($c.IsOffscreen) { continue }
    $r = $c.BoundingRectangle
    $p = Get-Process -Id $c.ProcessId -ErrorAction SilentlyContinue
    [void]$rows.Add([pscustomobject]@{
      hwnd = $c.NativeWindowHandle
      title = $c.Name
      class = $c.ClassName
      pid = $c.ProcessId
      process = if ($p) { $p.ProcessName } else { '' }
      x = [int]$r.X
      y = [int]$r.Y
      width = [int]$r.Width
      height = [int]$r.Height
    })
  } catch {}
}
[pscustomobject]@{ ok = $true; windows = @($rows) } | ConvertTo-Json -Depth 5 -Compress
"#;

const TREE_PS: &str = r#"
param(
  [long]$Hwnd = 0,
  [string]$Title = '',
  [int]$Depth = 6,
  [int]$MaxNodes = 250,
  [switch]$InteractiveOnly
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$windows = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Children,
  [System.Windows.Automation.Condition]::TrueCondition
)
$window = $null
foreach ($w in $windows) {
  try {
    $c = $w.Current
    if ($c.ControlType -ne [System.Windows.Automation.ControlType]::Window) { continue }
    if ($Hwnd -ne 0 -and $c.NativeWindowHandle -eq $Hwnd) { $window = $w; break }
    if ($Hwnd -eq 0 -and $Title -and $c.Name -like "*$Title*") { $window = $w; break }
    if ($Hwnd -eq 0 -and -not $Title -and -not $c.IsOffscreen) { $window = $w; break }
  } catch {}
}
if (-not $window) { throw "没有找到目标窗口（hwnd=$Hwnd title=$Title）" }

$script:nodes = New-Object System.Collections.ArrayList
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$interactive = @(
  [System.Windows.Automation.ControlType]::Button,
  [System.Windows.Automation.ControlType]::Edit,
  [System.Windows.Automation.ControlType]::ComboBox,
  [System.Windows.Automation.ControlType]::CheckBox,
  [System.Windows.Automation.ControlType]::RadioButton,
  [System.Windows.Automation.ControlType]::MenuItem,
  [System.Windows.Automation.ControlType]::TabItem,
  [System.Windows.Automation.ControlType]::ListItem,
  [System.Windows.Automation.ControlType]::Hyperlink,
  [System.Windows.Automation.ControlType]::Slider,
  [System.Windows.Automation.ControlType]::Spinner
)
function Walk($el, $level) {
  if ($script:nodes.Count -ge $MaxNodes) { return }
  try {
    $c = $el.Current
    $show = (-not $InteractiveOnly) -or ($interactive -contains $c.ControlType)
    if ($show -and -not $c.IsOffscreen) {
      $r = $c.BoundingRectangle
      $patterns = @()
      try {
        $patterns = @($el.GetSupportedPatterns() | ForEach-Object {
          $_.ProgrammaticName.Replace('PatternIdentifiers.Pattern','')
        })
      } catch {}
      [void]$script:nodes.Add([pscustomobject]@{
        level = $level
        type = $c.ControlType.ProgrammaticName.Replace('ControlType.','')
        name = $c.Name
        automationId = $c.AutomationId
        class = $c.ClassName
        enabled = $c.IsEnabled
        offscreen = $c.IsOffscreen
        x = [int]$r.X
        y = [int]$r.Y
        width = [int]$r.Width
        height = [int]$r.Height
        patterns = $patterns
      })
    }
  } catch {}
  if ($level -ge $Depth -or $script:nodes.Count -ge $MaxNodes) { return }
  try {
    $child = $walker.GetFirstChild($el)
    while ($child -and $script:nodes.Count -lt $MaxNodes) {
      Walk $child ($level + 1)
      $child = $walker.GetNextSibling($child)
    }
  } catch {}
}
$wc = $window.Current
Walk $window 0
$r = $wc.BoundingRectangle
[pscustomobject]@{
  ok = $true
  window = [pscustomobject]@{
    hwnd = $wc.NativeWindowHandle
    title = $wc.Name
    class = $wc.ClassName
    pid = $wc.ProcessId
    x = [int]$r.X
    y = [int]$r.Y
    width = [int]$r.Width
    height = [int]$r.Height
  }
  nodes = @($script:nodes)
  truncated = ($script:nodes.Count -ge $MaxNodes)
} | ConvertTo-Json -Depth 7 -Compress
"#;

const ACTION_PS: &str = r#"
param(
  [long]$Hwnd = 0,
  [string]$Title = '',
  [string]$AutomationId = '',
  [string]$Name = '',
  [ValidateSet('invoke','click','set_value','focus','menu')]
  [string]$Action = 'invoke',
  [string]$Value = '',
  [int]$CommandId = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KDockDesktopNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@

$root = [System.Windows.Automation.AutomationElement]::RootElement
$windows = $root.FindAll(
  [System.Windows.Automation.TreeScope]::Children,
  [System.Windows.Automation.Condition]::TrueCondition
)
$window = $null
foreach ($w in $windows) {
  try {
    $c = $w.Current
    if ($c.ControlType -ne [System.Windows.Automation.ControlType]::Window) { continue }
    if ($Hwnd -ne 0 -and $c.NativeWindowHandle -eq $Hwnd) { $window = $w; break }
    if ($Hwnd -eq 0 -and $Title -and $c.Name -like "*$Title*") { $window = $w; break }
  } catch {}
}
if (-not $window) { throw "没有找到目标窗口（hwnd=$Hwnd title=$Title）" }
$wc = $window.Current
$hwndValue = if ($wc.NativeWindowHandle -ne 0) { [IntPtr]$wc.NativeWindowHandle } else { [IntPtr]$Hwnd }
[void][KDockDesktopNative]::SetForegroundWindow($hwndValue)

if ($Action -eq 'menu') {
  if ($CommandId -le 0) { throw 'menu 动作必须给 command_id' }
  [void][KDockDesktopNative]::PostMessage($hwndValue, 0x0111, [IntPtr]$CommandId, [IntPtr]::Zero)
  [pscustomobject]@{ ok = $true; action = 'menu'; commandId = $CommandId } |
    ConvertTo-Json -Compress
  exit 0
}

$all = $window.FindAll(
  [System.Windows.Automation.TreeScope]::Descendants,
  [System.Windows.Automation.Condition]::TrueCondition
)
$target = $null
foreach ($el in $all) {
  try {
    $c = $el.Current
    if ($AutomationId -and $c.AutomationId -eq $AutomationId) { $target = $el; break }
    if (-not $AutomationId -and $Name -and $c.Name -like "*$Name*") { $target = $el; break }
  } catch {}
}
if (-not $target) { throw "没有找到控件（automation_id=$AutomationId name=$Name）" }
$tc = $target.Current
$result = [ordered]@{ ok = $true; action = $Action; type = $tc.ControlType.ProgrammaticName; name = $tc.Name; automationId = $tc.AutomationId }

switch ($Action) {
  'invoke' {
    $p = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $p.Invoke()
  }
  'click' {
    $done = $false
    try {
      $p = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
      $p.Invoke()
      $done = $true
    } catch {}
    if (-not $done) {
      $r = $tc.BoundingRectangle
      if ($r.Width -le 0 -or $r.Height -le 0) { throw '控件没有可点击区域' }
      $x = [int]($r.X + $r.Width / 2)
      $y = [int]($r.Y + $r.Height / 2)
      [void][KDockDesktopNative]::SetCursorPos($x, $y)
      Start-Sleep -Milliseconds 80
      [KDockDesktopNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      [KDockDesktopNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
      $result.x = $x
      $result.y = $y
    }
  }
  'set_value' {
    $p = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $p.SetValue($Value)
  }
  'focus' {
    $target.SetFocus()
  }
}
[pscustomobject]$result | ConvertTo-Json -Compress
"#;

fn script_path(name: &str, body: &'static str) -> Result<&'static Path, String> {
    static WINDOWS: OnceLock<PathBuf> = OnceLock::new();
    static TREE: OnceLock<PathBuf> = OnceLock::new();
    static ACTION: OnceLock<PathBuf> = OnceLock::new();
    let slot = match name {
        "windows" => &WINDOWS,
        "tree" => &TREE,
        "action" => &ACTION,
        _ => return Err("未知桌面脚本".into()),
    };
    if let Some(p) = slot.get() {
        return Ok(p);
    }
    let p = std::env::temp_dir().join(format!("kdock-desktop-{name}.ps1"));
    let mut bytes = vec![0xEFu8, 0xBB, 0xBF];
    bytes.extend_from_slice(body.as_bytes());
    std::fs::write(&p, bytes).map_err(|e| format!("写桌面脚本失败：{e}"))?;
    let _ = slot.set(p);
    slot.get()
        .map(|p| p.as_path())
        .ok_or_else(|| "桌面脚本初始化失败".into())
}

#[cfg(windows)]
fn run_ps(name: &str, body: &'static str, args: &[String]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let path = script_path(name, body)?;
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(path)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .creation_flags(0x0800_0000);
    let mut child = crate::process_guard::spawn(&mut cmd)
        .map_err(|e| format!("启动 Windows UI 自动化失败：{e}"))?;
    let mut stdout = child.stdout.take().ok_or("没有 stdout")?;
    let mut stderr = child.stderr.take().ok_or("没有 stderr")?;
    let out_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stdout, &mut buf);
        buf
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = std::io::Read::read_to_end(&mut stderr, &mut buf);
        buf
    });
    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if started.elapsed() > std::time::Duration::from_secs(20) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Windows UI 自动化超过 20 秒未返回".into());
            }
            None => std::thread::sleep(std::time::Duration::from_millis(40)),
        }
    };
    let out = out_thread.join().unwrap_or_default();
    let err = err_thread.join().unwrap_or_default();
    let text = crate::shell::decode(&out).trim().to_string();
    if status.success() {
        Ok(text)
    } else {
        let err = crate::shell::decode(&err).trim().to_string();
        Err(if err.is_empty() { text } else { err })
    }
}

#[cfg(not(windows))]
fn run_ps(_name: &str, _body: &'static str, _args: &[String]) -> Result<String, String> {
    Err("Windows UI 自动化只在 Windows 上可用".into())
}

pub fn windows() -> Result<String, String> {
    run_ps("windows", WINDOWS_PS, &[])
}

pub fn tree(
    hwnd: u64,
    title: &str,
    depth: u8,
    max_nodes: usize,
    interactive_only: bool,
) -> Result<String, String> {
    let mut args = vec![
        "-Hwnd".into(),
        hwnd.to_string(),
        "-Title".into(),
        title.into(),
        "-Depth".into(),
        depth.clamp(1, 10).to_string(),
        "-MaxNodes".into(),
        max_nodes.clamp(20, 500).to_string(),
    ];
    if interactive_only {
        args.push("-InteractiveOnly".into());
    }
    run_ps("tree", TREE_PS, &args)
}

pub fn action(
    hwnd: u64,
    title: &str,
    automation_id: &str,
    name: &str,
    action: &str,
    value: &str,
    command_id: u32,
) -> Result<String, String> {
    if action == "menu" && command_id == 0 {
        return Err("menu 动作必须给 command_id".into());
    }
    if action != "menu" && automation_id.trim().is_empty() && name.trim().is_empty() {
        return Err("非 menu 动作必须给 automation_id 或 name".into());
    }
    let args = vec![
        "-Hwnd".into(),
        hwnd.to_string(),
        "-Title".into(),
        title.into(),
        "-AutomationId".into(),
        automation_id.into(),
        "-Name".into(),
        name.into(),
        "-Action".into(),
        action.into(),
        "-Value".into(),
        value.into(),
        "-CommandId".into(),
        command_id.to_string(),
    ];
    run_ps("action", ACTION_PS, &args)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    #[ignore = "requires an interactive Windows desktop"]
    fn desktop_windows_returns_parseable_json() {
        let raw = windows().expect("enumerate windows");
        let value: serde_json::Value = serde_json::from_str(&raw).expect("JSON output");
        assert_eq!(value["ok"], true);
        assert!(value["windows"].is_array());
        if let Some(hwnd) = value["windows"]
            .as_array()
            .and_then(|w| w.first())
            .and_then(|w| w["hwnd"].as_u64())
            .filter(|h| *h != 0)
        {
            let raw = tree(hwnd, "", 3, 80, true).expect("read UI tree");
            let tree: serde_json::Value = serde_json::from_str(&raw).expect("tree JSON output");
            assert_eq!(tree["ok"], true);
            assert!(tree["nodes"].is_array());
        }
    }
}
