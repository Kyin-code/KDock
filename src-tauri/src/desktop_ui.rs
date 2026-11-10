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
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class KDockDesktopTreeNative {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public sealed class Node {
    public long hwnd;
    public int id;
    public string text = "";
    public string cls = "";
    public bool visible;
    public int x, y, width, height;
  }
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  public static Node[] Children(IntPtr root, int max) {
    var list = new List<Node>();
    EnumChildWindows(root, (h, p) => {
      if (list.Count >= max) return false;
      var t = new StringBuilder(2048);
      var c = new StringBuilder(256);
      GetWindowText(h, t, t.Capacity);
      GetClassName(h, c, c.Capacity);
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      var n = new Node {
        hwnd = h.ToInt64(), id = GetDlgCtrlID(h), text = t.ToString(),
        cls = c.ToString(), visible = IsWindowVisible(h),
        x = r.Left, y = r.Top, width = r.Right - r.Left, height = r.Bottom - r.Top
      };
      list.Add(n);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
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
if ($script:nodes.Count -eq 0 -and $wc.NativeWindowHandle -ne 0) {
  $native = [KDockDesktopTreeNative]::Children([IntPtr]$wc.NativeWindowHandle, $MaxNodes)
  foreach ($n in $native) {
    if (-not $n.visible) { continue }
    $type = switch -Regex ($n.cls) {
      '^Button$' { 'Button'; break }
      '^Edit$' { 'Edit'; break }
      '^ComboBox' { 'ComboBox'; break }
      '^Static$' { 'Text'; break }
      '^SysListView32$' { 'List'; break }
      '^Toolbar' { 'ToolBar'; break }
      default { $n.cls }
    }
    if (-not $n.text -and $type -notin @('Button','Edit','ComboBox','List','ToolBar')) { continue }
    [void]$script:nodes.Add([pscustomobject]@{
      level = 1
      type = $type
      name = $n.text
      automationId = "id:$($n.id)"
      class = $n.cls
      enabled = $true
      offscreen = $false
      x = $n.x
      y = $n.y
      width = $n.width
      height = $n.height
      patterns = @('Win32')
    })
  }
}
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
  [ValidateSet('invoke','click','set_value','focus','menu','keys')]
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
  [StructLayout(LayoutKind.Sequential)] public struct INPUT {
    public uint type;
    public KEYBDINPUT ki;
    public long padding;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageText(IntPtr hWnd, uint msg, IntPtr wParam, string text);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr parent, int id);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  public static void Activate(IntPtr hWnd) {
    uint pid;
    uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    uint mine = GetCurrentThreadId();
    bool attached = AttachThreadInput(mine, foreground, true);
    ShowWindow(hWnd, 9);
    BringWindowToTop(hWnd);
    SetForegroundWindow(hWnd);
    if (attached) AttachThreadInput(mine, foreground, false);
    System.Threading.Thread.Sleep(250);
  }
  public static uint SendChord(IntPtr hWnd, int[] keys) {
    Activate(hWnd);
    var inputs = new INPUT[keys.Length * 2];
    for (int i = 0; i < keys.Length; i++) {
      inputs[i].type = 1;
      inputs[i].ki.wVk = (ushort)keys[i];
    }
    for (int i = 0; i < keys.Length; i++) {
      int at = keys.Length + i;
      inputs[at].type = 1;
      inputs[at].ki.wVk = (ushort)keys[keys.Length - 1 - i];
      inputs[at].ki.dwFlags = 2;
    }
    return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
  }
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
[void][KDockDesktopNative]::Activate($hwndValue)

if ($Action -eq 'keys') {
  $keys = @($Value.Split(',') | Where-Object { $_.Trim() } | ForEach-Object { [int]$_.Trim() })
  if ($keys.Count -lt 1) { throw 'keys 动作没给按键' }
  $sent = [KDockDesktopNative]::SendChord($hwndValue, $keys)
  [pscustomobject]@{ ok = ($sent -eq $keys.Count * 2); action = 'keys'; events = $sent } |
    ConvertTo-Json -Compress
  exit 0
}

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
if (-not $target -and $AutomationId -match '^id:(\d+)$') {
  $nativeHwnd = [KDockDesktopNative]::GetDlgItem($hwndValue, [int]$Matches[1])
  if ($nativeHwnd -eq [IntPtr]::Zero) {
    throw "没有找到 Win32 控件（$AutomationId）"
  }
  switch ($Action) {
    'invoke' { [void][KDockDesktopNative]::SendMessage($nativeHwnd, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) }
    'click' { [void][KDockDesktopNative]::SendMessage($nativeHwnd, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) }
    'focus' { [void][KDockDesktopNative]::SetFocus($nativeHwnd) }
    'set_value' {
      [void][KDockDesktopNative]::SendMessageText($nativeHwnd, 0x000C, [IntPtr]::Zero, $Value)
    }
    default { throw "Win32 控件不支持动作 $Action" }
  }
  [pscustomobject]@{
    ok = $true
    action = $Action
    type = 'Win32Control'
    name = ''
    automationId = $AutomationId
  } | ConvertTo-Json -Compress
  exit 0
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
                crate::process_guard::terminate_tree(&mut child);
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
    let value = if action == "keys" {
        hotkey_codes(value)?
    } else {
        value.to_string()
    };
    if action == "menu" && command_id == 0 {
        return Err("menu 动作必须给 command_id".into());
    }
    if action != "menu"
        && action != "keys"
        && automation_id.trim().is_empty()
        && name.trim().is_empty()
    {
        return Err("这个动作必须给 automation_id 或 name".into());
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
        value,
        "-CommandId".into(),
        command_id.to_string(),
    ];
    run_ps("action", ACTION_PS, &args)
}

fn hotkey_codes(spec: &str) -> Result<String, String> {
    let parts: Vec<String> = spec
        .trim()
        .to_ascii_lowercase()
        .split('+')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    if parts.is_empty() {
        return Err("keys 动作必须给快捷键，例如 alt+f3".into());
    }
    let mut codes = Vec::new();
    let mut key = None;
    for part in parts {
        let code = match part.as_str() {
            "alt" => 0x12,
            "ctrl" | "control" => 0x11,
            "shift" => 0x10,
            "enter" | "return" => 0x0D,
            "tab" => 0x09,
            "esc" | "escape" => 0x1B,
            "space" => 0x20,
            "backspace" => 0x08,
            "delete" | "del" => 0x2E,
            "up" => 0x26,
            "down" => 0x28,
            "left" => 0x25,
            "right" => 0x27,
            "home" => 0x24,
            "end" => 0x23,
            "pgup" | "pageup" => 0x21,
            "pgdn" | "pagedown" => 0x22,
            _ if part.len() >= 2
                && part.starts_with('f')
                && part[1..].parse::<u8>().ok().is_some_and(|n| (1..=24).contains(&n)) =>
            {
                0x6F + part[1..].parse::<u8>().unwrap()
            }
            _ if part.len() == 1 && part.as_bytes()[0].is_ascii_alphanumeric() => {
                part.as_bytes()[0].to_ascii_uppercase()
            }
            _ => return Err(format!("不认识的按键：{part}")),
        };
        match part.as_str() {
            "alt" | "ctrl" | "control" | "shift" => codes.push(code),
            _ => {
                if key.replace(code).is_some() {
                    return Err("一个 keys 动作只能有一个非修饰键".into());
                }
            }
        }
    }
    let key = key.ok_or("keys 动作至少要有一个非修饰键，例如 alt+f3")?;
    codes.push(key);
    Ok(codes
        .into_iter()
        .map(|code| code.to_string())
        .collect::<Vec<_>>()
        .join(","))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn hotkey_chords_are_translated_to_virtual_keys() {
        assert_eq!(hotkey_codes("alt+f3").unwrap(), "18,114");
        assert_eq!(hotkey_codes("Ctrl+Shift+s").unwrap(), "17,16,83");
        assert_eq!(hotkey_codes("f12").unwrap(), "123");
        assert!(hotkey_codes("alt+").is_err());
        assert!(hotkey_codes("alt+f3+x").is_err());
        assert!(hotkey_codes("hyper+f3").is_err());
    }

    #[test]
    fn desktop_action_script_compiles_before_window_lookup() {
        let err = action(
            0,
            "__kdock_window_that_does_not_exist__",
            "",
            "",
            "keys",
            "f24",
            0,
        )
        .unwrap_err();
        assert!(
            err.contains("__kdock_window_that_does_not_exist__"),
            "action script did not reach window lookup: {err}"
        );
    }

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
