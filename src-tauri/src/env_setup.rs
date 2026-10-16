// ── 环境配置：驱动 / 工具链 的检测与一键安装 ────────────────────────────────
// 设计要点：
//   · 清单是**一个 Rust 常量**（id / 名称 / 类别 / 检测规则 / 安装方式），改一行就能加一个组件；
//   · 检测规则分几类：exe（PATH 或指定目录找可执行文件）、glob（按通配路径扫）、
//     inf（pnputil 里有没有这个驱动）、reg（注册表值，用来读 SEGGER 这种"版本在注册表"的）、
//     ver（跑 --version 拿版本号从输出里抠）；
//   · 安装方式：download（下载到"下载"目录再跑安装器 / MSI）、zip（下载解包到指定目录）、
//     git（git clone，RT-Thread Env 就是这种）、manual（只有官网/下载页，我们不给裸链接）；
//   · 需要提权的（USB 驱动）走 PowerShell 的 -Verb RunAs，会弹 UAC —— 绝不静默装东西；
//   · 扫描是纯本地只读；**下载和安装只在你点了按钮 / agent 走了审批之后才发生**。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Exe,      // 在 PATH 或指定根目录里找可执行文件
    Glob,     // 用通配串扫盘（如 F:\ENV\OpenOCD-*\bin\openocd.exe）
    Inf,      // pnputil /enum-drivers 里有没有这个 .inf
    Reg,      // 注册表值（路径, 值名）
    Manual,   // 只能人工确认（例如某个需要登录/授权下载的工具）
}

#[derive(Clone, Copy)]
#[allow(dead_code)]
pub struct Rule {
    pub kind: Kind,
    /// exe: 文件名；glob: 通配串；inf: inf 文件名；reg: 键路径
    pub a: &'static str,
    /// exe: 额外搜索根（留空=只用 PATH）；reg: 值名
    pub b: &'static str,
    /// 跑它取版本用的参数（如 "--version"）；空 = 不取
    pub ver_args: &'static str,
    /// 从版本输出里抠版本号的正则（简单子串优先，空 = 用整行）
    pub ver_match: &'static str,
}

const fn exe(a: &'static str, b: &'static str, ver_args: &'static str, ver_match: &'static str) -> Rule {
    Rule { kind: Kind::Exe, a, b, ver_args, ver_match }
}
const fn glob(a: &'static str, ver_args: &'static str, ver_match: &'static str) -> Rule {
    Rule { kind: Kind::Glob, a, b: "", ver_args, ver_match }
}
const fn inf(a: &'static str) -> Rule {
    Rule { kind: Kind::Inf, a, b: "", ver_args: "", ver_match: "" }
}
const fn reg(a: &'static str, b: &'static str) -> Rule {
    Rule { kind: Kind::Reg, a, b, ver_args: "", ver_match: "" }
}

#[derive(Clone, Copy)]
#[allow(dead_code)]   // Download/Zip 先留着：把安装包丢进 drivers\<id>\ 走的是内置那条路，这两个以后接直链用
pub enum Plan {
    /// 下载 → 跑安装器（silent = 传静默参数；elevated = 走 UAC）
    Download { url: &'static str, file: &'static str, args: &'static str, elevated: bool },
    /// 下载 zip → 解压到安装目录
    Zip { url: &'static str, strip: u32 },
    /// git clone 到安装目录（RT-Thread Env）
    Git { repo: &'static str },
    /// 走 winget（微软包管理器）：有官方包的直接一键，不用我们猜直链
    Winget { id: &'static str },
    /// 没有可靠的自动下载地址：只给官网，让用户自己装（不猜 URL）
    Manual,
}

pub struct Item {
    pub id: &'static str,
    pub name: &'static str,
    pub kind_cn: &'static str,
    pub desc: &'static str,
    pub url: &'static str,
    /// 首次运行检查里算"必需"的
    pub required: bool,
    /// 有版本概念的才比版本（驱动大多不比）
    pub min_version: Option<&'static str>,
    pub size_mb: f32,
    pub rules: &'static [Rule],
    pub plan: Plan,
}

/// 清单。顺序就是界面上的顺序。
pub static ITEMS: &[Item] = &[
    Item {
        id: "ch34x",
        name: "CH34x / CH340 串口驱动",
        kind_cn: "USB 驱动",
        desc: "WCH 的 USB 转串口（CH340/CH341/CH343/CH9102）。插上板子认不出 COM 口、或者出现带感叹号的未知设备，就是它没装。",
        url: "https://www.wch.cn/downloads/CH341SER_EXE.html",
        required: true,
        min_version: None,
        size_mb: 0.4,
        rules: &[inf("ch341ser.inf"), inf("ch341wdm.inf"), inf("ch343ser.inf"), inf("ch343wdm.inf"), inf("ch9102ser.inf")],
        // WCH 官网的下载要点确认才能拿到直链，我们不去猜：给官网入口 + 支持把驱动提前丢进
        // <exe 同目录>driversch34x 里当"内置驱动"一键装（见 env_install 的第一步）。
        plan: Plan::Manual,
    },
    Item {
        id: "ft2232",
        name: "FTDI FT2232 / D2XX 驱动",
        kind_cn: "USB 驱动",
        desc: "FTDI 的 FT2232H/FT232H 双通道芯片（CMSIS-DAP 调试器、FT2232 逻辑分析仪都用它）。装了才有 COM 口和 D2XX 通道。",
        url: "https://ftdichip.com/drivers/vcp-drivers/",
        required: false,
        min_version: None,
        size_mb: 2.0,
        rules: &[inf("ftdibus.inf"), inf("ftdiport.inf")],
        plan: Plan::Manual,   // FTDI 直链带防盗链（403），给官网入口
    },
    Item {
        id: "jlink",
        name: "SEGGER J-Link（含 JFlash / GDB Server / RTT）",
        kind_cn: "调试器",
        desc: "J-Link 的软件包与 USB 驱动：JLink.exe / JFlash.exe / JLinkGDBServerCL.exe / JLinkRTTViewer.exe 都在里面，烧录页与调试页都用它。",
        url: "https://www.segger.com/downloads/jlink/",
        required: false,
        min_version: Some("7.80"),
        size_mb: 120.0,
        rules: &[reg("HKLM\\SOFTWARE\\SEGGER\\J-Link", "Version"), exe("JLink.exe", "C:\\Program Files\\SEGGER;C:\\Program Files (x86)\\SEGGER", "", "")],
        plan: Plan::Manual,   // SEGGER 下载页要点同意条款，直链拿不到；官网进去选 "J-Link Software and Documentation Pack"
    },
    Item {
        id: "armgcc",
        name: "GNU Arm Embedded Toolchain（arm-none-eabi-gcc）",
        kind_cn: "工具链",
        desc: "编译 ARM 工程的 gcc/g++/gdb/newlib。装完把 bin 目录加到用户 PATH，命令行和本软件的调试页就能直接用。",
        url: "https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads",
        required: false,
        min_version: Some("10.3"),
        size_mb: 130.0,
        rules: &[exe("arm-none-eabi-gcc.exe", "F:\\ENV;I:\\arm_gnc_toolchain;D:\\ENV;C:\\ENV", "--version", "")],
        plan: Plan::Winget { id: "Arm.GnuArmEmbeddedToolchain" },
    },
    Item {
        id: "openocd",
        name: "OpenOCD",
        kind_cn: "调试器",
        desc: "开源调试/烧录器（0.12 起自带 CMSIS-DAP、ST-Link、J-Link 驱动）。烧录页选 OpenOCD 时用的就是它。",
        url: "https://openocd.org/",
        required: false,
        min_version: Some("0.11"),
        size_mb: 45.0,
        rules: &[
            exe("openocd.exe", "F:\\ENV;D:\\ENV;C:\\ENV;I:\\ENV", "--version", ""),
            glob("F:\\ENV\\OpenOCD-*\\bin\\openocd.exe", "--version", ""),
        ],
        plan: Plan::Winget { id: "xpack-dev-tools.openocd-xpack" },
    },
    Item {
        id: "pulseview",
        name: "逻辑分析仪：PulseView / sigrok",
        kind_cn: "逻辑分析仪",
        desc: "就是你那台开源逻辑分析仪用的软件（FX2 芯片 + fx2lafw 固件，sigrok 出的 PulseView）。装完插上设备就能抓波形。",
        url: "https://sigrok.org/wiki/Downloads",
        required: false,
        min_version: None,
        size_mb: 30.0,
        rules: &[glob("*:\\PulseView\\pulseview.exe", "", ""), glob("*:\\Program Files\\PulseView\\pulseview.exe", "", "")],
        plan: Plan::Winget { id: "Sigrok.PulseView" },
    },
    Item {
        id: "rtthread_env",
        name: "RT-Thread Env 工具",
        kind_cn: "运行时",
        desc: "RT-Thread 的命令行环境（env.exe / env.bat，来自 RT-ThreadStudio 或官方 env 仓库）：scons、menuconfig、pkgs 都靠它。",
        url: "https://github.com/RT-Thread/env",
        required: false,
        min_version: None,
        size_mb: 20.0,
        rules: &[
            glob("*:\\RT-ThreadStudio\\platform\\env_released\\*\\env.exe", "", ""),
            glob("*:\\RT-ThreadStudio\\platform\\env_released\\env\\env.bat", "", ""),
            exe("env.exe", "C:\\RT-ThreadEnv;D:\\ENV;F:\\ENV;I:\\RT-ThreadStudio\\platform\\env_released\\env", "", ""),
        ],
        plan: Plan::Git { repo: "https://github.com/RT-Thread/env.git" },
    },
    Item {
        id: "stlink",
        name: "ST-Link USB 驱动",
        kind_cn: "USB 驱动",
        desc: "ST-Link / ST-Link V2-1 调试器的 WinUSB 驱动（OpenOCD 走它）。用 ST 官方 CUBE 或驱动包安装。",
        url: "https://www.st.com/en/development-tools/stsw-link009.html",
        required: false,
        min_version: None,
        size_mb: 1.0,
        rules: &[inf("stlink_dbg_winusb.inf"), inf("stlink_bridge_winusb.inf")],
        plan: Plan::Manual,
    },
    Item {
        id: "zadig",
        name: "Zadig（给逻辑分析仪装 WinUSB）",
        kind_cn: "USB 驱动",
        desc: "开源逻辑分析仪（FX2 / fx2lafw）在 Windows 上要用 WinUSB 驱动，Zadig 就是干这个的：跑一次、选设备、装 WinUSB。",
        url: "https://zadig.akeo.ie/",
        required: false,
        min_version: None,
        size_mb: 6.0,
        rules: &[glob("*:\\Downloads\\zadig*.exe", "", ""), glob("*:\\zadig*\\zadig*.exe", "", "")],
        plan: Plan::Winget { id: "akeo.ie.Zadig" },
    },
];

/* ───────────────────────── 检测 ───────────────────────── */

fn run_out(prog: &str, args: &[&str]) -> Option<String> {
    let mut c = Command::new(prog);
    c.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：别闪黑框
    }
    let out = c.output().ok()?;
    let mut s = String::from_utf8_lossy(&out.stdout).to_string();
    s.push_str(&String::from_utf8_lossy(&out.stderr));
    if s.trim().is_empty() { None } else { Some(s) }
}

/// 从安装路径里抠版本（JLink_V952 变成 9.52、gcc-arm-none-eabi-10.3-2021.10 变成 10.3）
pub fn version_from_path(p: &str) -> Option<String> {
    let up = p.to_uppercase();
    if let Some(i) = up.find("JLINK_V") {
        let d: String = up[i + 7..].chars().take_while(|c| c.is_ascii_digit()).collect();
        if d.len() >= 3 {
            let (a, b) = d.split_at(d.len() - 2);
            return Some(format!("{}.{}", a, b));
        }
    }
    let bytes = p.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let mut j = i;
            let mut dots = 0;
            while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b'.') {
                if bytes[j] == b'.' { dots += 1; }
                j += 1;
            }
            let trimmed = p[i..j].trim_end_matches('.');
            let before_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
            let after_ok = j >= bytes.len() || !bytes[j].is_ascii_alphanumeric();
            if dots >= 1 && before_ok && after_ok && trimmed.len() <= 12 && trimmed.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                return Some(trimmed.to_string());
            }
            i = j;
        } else { i += 1; }
    }
    None
}

/// 从 --version 输出里抠一个像版本号的东西
pub fn pick_version(text: &str) -> Option<String> {
    for tok in text.split(|c: char| c.is_whitespace() || c == ',' || c == '(' || c == ')') {
        let t = tok.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-' && c != '_');
        let core = t.trim_start_matches('v');
        let mut digits = 0;
        let mut dots = 0;
        let mut ok = !core.is_empty();
        for ch in core.chars() {
            if ch.is_ascii_digit() { digits += 1; }
            else if ch == '.' { dots += 1; }
            else if ch == '-' || ch == '_' { break; }
            else { ok = false; break; }
        }
        if ok && digits >= 1 && dots >= 1 { return Some(t.to_string()); }
    }
    None
}

/// 简单的版本比较：按 . 切开比数字，够用（不做语义化的 pre-release 那套）
pub fn ver_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let pa: Vec<u32> = a.split('.').map(|x| x.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0)).collect();
    let pb: Vec<u32> = b.split('.').map(|x| x.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0)).collect();
    for i in 0..pa.len().max(pb.len()) {
        let x = *pa.get(i).unwrap_or(&0);
        let y = *pb.get(i).unwrap_or(&0);
        if x != y { return x.cmp(&y); }
    }
    std::cmp::Ordering::Equal
}

fn path_roots() -> Vec<PathBuf> {
    std::env::var("PATH").unwrap_or_default().split(';').filter(|s| !s.trim().is_empty()).map(PathBuf::from).collect()
}

/// 在 PATH + 额外根目录（含一层通配）里找 exe
fn find_exe(name: &str, extra: &str) -> Option<PathBuf> {
    for d in path_roots() {
        let p = d.join(name);
        if p.is_file() { return Some(p); }
    }
    for root in extra.split(';').filter(|s| !s.trim().is_empty()) {
        let p = Path::new(root).join(name);
        if p.is_file() { return Some(p); }
        // 根目录下再往下找一层（如 F:\ENV\gcc-arm-none-eabi-10.3-2021.10\bin\gcc.exe）
        if let Ok(rd) = std::fs::read_dir(root) {
            for e in rd.flatten() {
                let p2 = e.path().join(name);
                if p2.is_file() { return Some(p2); }
                let p3 = e.path().join("bin").join(name);
                if p3.is_file() { return Some(p3); }
            }
        }
    }
    None
}

/// 段内通配：* 匹配任意字符（"*:" 匹配 "I:"，"zadig*.exe" 匹配 "zadig-2.9.exe"）
fn wild(pat: &str, s: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match (p.first(), t.first()) {
            (None, None) => true,
            (Some('*'), _) => (0..=t.len()).any(|i| go(&p[1..], &t[i..])),
            (Some(x), Some(y)) => x.eq_ignore_ascii_case(y) && go(&p[1..], &t[1..]),
            _ => false,
        }
    }
    let p: Vec<char> = pat.chars().collect();
    let t: Vec<char> = s.chars().collect();
    go(&p, &t)
}

/// 按通配串找文件 —— **跟着模式走**：某层目录名跟模式的对应段对不上就不进去。
/// （早先那版是"每层都递归再看整条路径"，一条 *:\Program Files\x\y.exe 就能把整盘翻一遍。）
fn glob_find(pat: &str, max_hits: usize) -> Vec<PathBuf> {
    let norm = pat.replace('/', "\\");
    let parts: Vec<&str> = norm.split('\\').filter(|x| !x.is_empty()).collect();
    if parts.is_empty() { return Vec::new(); }
    // 第一段一般是盘符（可能是 "C:" 也可能是 "*:"）
    let (drive_pat, rest) = (parts[0], &parts[1..]);
    let mut roots: Vec<PathBuf> = Vec::new();
    if drive_pat.ends_with(':') {
        for d in (b'A'..=b'Z').map(|c| format!("{}:\\", c as char)) {
            let p = PathBuf::from(&d);
            if p.is_dir() && wild(drive_pat, &d[..2]) { roots.push(p); }
        }
    } else {
        roots.push(PathBuf::from(drive_pat));   // 没有盘符就当成目录前缀
    }
    if rest.is_empty() { return Vec::new(); }
    let t0 = std::time::Instant::now();
    let mut hits: Vec<PathBuf> = Vec::new();
    // 目录列举缓存：同一条清单里好几条规则会重复看同一批目录
    let mut cache: std::collections::HashMap<PathBuf, Vec<(String, PathBuf, bool)>> = std::collections::HashMap::new();
    fn walk(dir: &Path, pat: &[&str], hits: &mut Vec<PathBuf>, max: usize, t0: std::time::Instant,
            cache: &mut std::collections::HashMap<PathBuf, Vec<(String, PathBuf, bool)>>) {
        if hits.len() >= max || t0.elapsed().as_millis() > 4000 { return; }
        let kids = match cache.get(dir) {
            Some(v) => v.clone(),
            None => {
                let v: Vec<(String, PathBuf, bool)> = match std::fs::read_dir(dir) {
                    Ok(rd) => rd.flatten().map(|e| {
                        let p = e.path();
                        let is_dir = p.is_dir();
                        (e.file_name().to_string_lossy().to_string(), p, is_dir)
                    }).collect(),
                    Err(_) => Vec::new(),
                };
                cache.insert(dir.to_path_buf(), v.clone());
                v
            }
        };
        let seg = pat[0];
        for (name, path, is_dir) in kids {
            if !wild(seg, &name) { continue; }
            if pat.len() == 1 {
                if !is_dir { hits.push(path); if hits.len() >= max { return; } }
            } else if is_dir {
                walk(&path, &pat[1..], hits, max, t0, cache);
            }
        }
    }
    for root in &roots {
        walk(root, rest, &mut hits, max_hits, t0, &mut cache);
    }
    hits
}

fn pnputil_infs() -> String {
    run_out("pnputil.exe", &["/enum-drivers"]).unwrap_or_default().to_lowercase()
}

fn reg_query(key: &str, value: &str) -> Option<String> {
    let out = run_out("reg.exe", &["query", key, "/v", value])?;
    for line in out.lines() {
        let l = line.trim();
        if l.to_lowercase().starts_with(&value.to_lowercase()) {
            let mut it = l.split_whitespace();
            it.next();
            it.next();
            let v = it.collect::<Vec<_>>().join(" ");
            if !v.trim().is_empty() { return Some(v.trim().to_string()); }
        }
    }
    None
}

pub fn scan_one(it: &Item, infs: &str) -> Value {
    let mut path: Option<PathBuf> = None;
    let mut version: Option<String> = None;
    let mut detail = String::new();
    let mut installed = false;
    for r in it.rules {
        match r.kind {
            Kind::Inf => {
                if infs.contains(&r.a.to_lowercase()) { installed = true; detail = format!("已注册驱动 {}", r.a); break; }
            }
            Kind::Reg => {
                if let Some(v) = reg_query(r.a, r.b) {
                    installed = true;
                    version = pick_version(&v).or(Some(v));
                    detail = format!("注册表 {}", r.a);
                    break;
                }
            }
            Kind::Exe => {
                if let Some(p) = find_exe(r.a, r.b) {
                    installed = true;
                    path = Some(p.clone());
                    detail = p.to_string_lossy().to_string();
                    if !r.ver_args.is_empty() {
                        if let Some(t) = run_out(p.to_string_lossy().as_ref(), &r.ver_args.split(' ').collect::<Vec<_>>()) {
                            version = pick_version(&t);
                        }
                    }
                    if version.is_none() { version = version_from_path(&p.to_string_lossy()); }
                    break;
                }
            }
            Kind::Glob => {
                let hits = glob_find(r.a, 4);
                if let Some(p) = hits.first() {
                    installed = true;
                    path = Some(p.clone());
                    detail = p.to_string_lossy().to_string();
                    if !r.ver_args.is_empty() {
                        if let Some(t) = run_out(p.to_string_lossy().as_ref(), &r.ver_args.split(' ').collect::<Vec<_>>()) {
                            version = pick_version(&t);
                        }
                    }
                    if version.is_none() { version = version_from_path(&p.to_string_lossy()); }
                    break;
                }
            }
            Kind::Manual => {}
        }
    }
    let outdated = match (it.min_version, version.as_ref()) {
        (Some(min), Some(v)) => ver_cmp(v, min) == std::cmp::Ordering::Less,
        _ => false,
    };
    json!({
        "id": it.id,
        "name": it.name,
        "kind": it.kind_cn,
        "desc": it.desc,
        "url": it.url,
        "required": it.required,
        "minVersion": it.min_version,
        "sizeMb": it.size_mb,
        "installed": installed,
        "version": version,
        "outdated": outdated,
        "path": path.map(|p| p.to_string_lossy().to_string()),
        "detail": detail,
        "autoInstall": !matches!(it.plan, Plan::Manual),
    })
}

/// 扫描结果缓存（15 分钟）：装完 / 点"重新扫描"会清掉
static SCAN_CACHE: std::sync::Mutex<Option<(std::time::Instant, Value)>> = std::sync::Mutex::new(None);

#[tauri::command]
pub fn env_scan(force: Option<bool>) -> Result<Value, String> {
    if !force.unwrap_or(false) {
        if let Ok(g) = SCAN_CACHE.lock() {
            if let Some((t, v)) = g.as_ref() {
                if t.elapsed().as_secs() < 900 { return Ok(v.clone()); }
            }
        }
    }
    let v = env_scan_now()?;
    if let Ok(mut g) = SCAN_CACHE.lock() { *g = Some((std::time::Instant::now(), v.clone())); }
    Ok(v)
}

fn env_scan_now() -> Result<Value, String> {
    let infs = pnputil_infs();
    let list: Vec<Value> = ITEMS.iter().map(|it| scan_one(it, &infs)).collect();
    let missing: Vec<&str> = list.iter().filter(|x| x["required"] == json!(true) && x["installed"] == json!(false)).filter_map(|x| x["id"].as_str()).collect();
    let outdated: Vec<&str> = list.iter().filter(|x| x["outdated"] == json!(true)).filter_map(|x| x["id"].as_str()).collect();
    Ok(json!({
        "items": list,
        "missingRequired": missing,
        "outdated": outdated,
        "downloadDir": download_dir(),
    }))
}

/* ───────────────────────── 安装 ───────────────────────── */

fn download_dir() -> String {
    let up = std::env::var("USERPROFILE").unwrap_or_default();
    let d = Path::new(&up).join("Downloads");
    if d.is_dir() { d.to_string_lossy().to_string() } else { std::env::temp_dir().to_string_lossy().to_string() }
}

fn emit(app: &tauri::AppHandle, id: &str, phase: &str, pct: i32, text: &str) {
    use tauri::Emitter;
    let _ = app.emit("env://progress", json!({ "id": id, "phase": phase, "pct": pct, "text": text }));
}

fn download(app: &tauri::AppHandle, id: &str, url: &str, file: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(download_dir());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dst = dir.join(file);
    if dst.is_file() && dst.metadata().map(|m| m.len()).unwrap_or(0) > 1024 {
        emit(app, id, "download", 100, &format!("已存在，直接用：{}", dst.display()));
        return Ok(dst);
    }
    emit(app, id, "download", 5, &format!("开始下载 {}", file));
    let resp = ureq::get(url).timeout(std::time::Duration::from_secs(1800)).call().map_err(|e| format!("下载失败: {e}"))?;
    let total: u64 = resp.header("Content-Length").and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut out = std::fs::File::create(&dst).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 64 * 1024];
    let mut got: u64 = 0;
    let mut last = 0i32;
    loop {
        let n = std::io::Read::read(&mut reader, &mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        std::io::Write::write_all(&mut out, &buf[..n]).map_err(|e| e.to_string())?;
        got += n as u64;
        let pct = if total > 0 { (got * 100 / total) as i32 } else { 50 };
        if pct >= last + 5 { last = pct; emit(app, id, "download", pct, &format!("下载中 {}%", pct)); }
    }
    emit(app, id, "download", 100, &format!("下载完成：{} MB", got / 1048576));
    Ok(dst)
}

fn run_powershell(app: &tauri::AppHandle, id: &str, script: &str, elevated: bool) -> Result<String, String> {
    let mut ps = format!("$ProgressPreference='SilentlyContinue'; {script}");
    if elevated {
        // 需要 UAC：这台机器上驱动类安装必须提权，弹一次授权框
        ps = format!("Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-Command',\"{}\"", ps.replace('"', "\\\""));
    }
    emit(app, id, "install", 60, if elevated { "等待 UAC 授权 / 安装中…" } else { "安装中…" });
    let out = run_out("powershell.exe", &["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &ps]);
    match out {
        Some(t) => {
            emit(app, id, "install", 100, "安装命令已执行");
            Ok(t.chars().rev().take(4000).collect::<String>().chars().rev().collect())
        }
        None => Err("PowerShell 没返回输出（可能被 UAC 拒绝）".into()),
    }
}

/// 安装 / 更新。dry = 只打印将要做什么（下载照做，但不执行安装器）——测试用
#[tauri::command]
pub async fn env_install(app: tauri::AppHandle, id: String, dir: Option<String>, dry: Option<bool>) -> Result<String, String> {
    let dry = dry.unwrap_or(false);
    let it = ITEMS.iter().find(|x| x.id == id).ok_or_else(|| format!("不认识的组件：{id}"))?;
    let target = dir.unwrap_or_else(|| {
        let f = Path::new("F:\\ENV");
        if f.is_dir() { f.to_string_lossy().to_string() } else { Path::new(&std::env::var("USERPROFILE").unwrap_or_default()).join("KDock\\env").to_string_lossy().to_string() }
    });
    emit(&app, it.id, "start", 0, &format!("准备安装 {}", it.name));

    // ① 先看有没有"内置"的小驱动：<exe 同目录>drivers<id> 下放 .exe/.msi/.inf 就直接用
    //    （CH340/FTDI 这种官网要登录的，把安装包提前丢进去就能一键装）
    let mut bundled: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            if let Ok(rd) = std::fs::read_dir(d.join("drivers").join(it.id)) {
                for e in rd.flatten() {
                    let p = e.path();
                    let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
                    if ["exe", "msi", "inf"].contains(&ext.as_str()) { bundled.push(p); }
                }
            }
        }
    }
    if !bundled.is_empty() {
        let mut outs = Vec::new();
        for p in &bundled {
            let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            let script = if ext == "inf" {
                format!("pnputil /add-driver '{}' /install", p.display())
            } else if ext == "msi" {
                format!("Start-Process msiexec.exe -ArgumentList '/i','\"{}\"','/qn' -Wait", p.display())
            } else {
                format!("Start-Process -FilePath '{}' -ArgumentList '/S' -Wait", p.display())
            };
            emit(&app, it.id, "install", 40, &format!("内置驱动：{}", p.file_name().unwrap_or_default().to_string_lossy()));
            if dry { outs.push(format!("（模拟）会执行 {}", script)); }
            else { let _ = run_powershell(&app, it.id, &script, true); outs.push(format!("已执行：{}", script)); }
        }
        emit(&app, it.id, "done", 100, "完成");
        return Ok(format!("用了内置驱动：\n{}", outs.join("\n")));
    }

    let log = match it.plan {
        Plan::Manual => {
            return Ok(format!("「{}」没有直接的自动下载地址（要登录/授权），请到官网下载安装：{}", it.name, it.url));
        }
        Plan::Git { repo } => {
            let dst = Path::new(&target).join(it.id);
            if dst.join(".git").is_dir() {
                emit(&app, it.id, "install", 70, "已有仓库，执行 git pull");
                if dry { format!("（模拟）会在 {} 里跑 git pull", dst.display()) }
                else { run_out("git.exe", &["-C", &dst.to_string_lossy(), "pull", "--ff-only"]).unwrap_or_default() }
            } else {
                std::fs::create_dir_all(Path::new(&target)).map_err(|e| e.to_string())?;
                if dry { format!("（模拟）会 git clone {} {}", repo, dst.display()) }
                else {
                    run_out("git.exe", &["clone", "--depth", "1", repo, &dst.to_string_lossy()])
                        .ok_or_else(|| "git clone 失败（PATH 里有 git 吗？）".to_string())?
                }
            }
        }
        Plan::Zip { url, strip } => {
            let zip = download(&app, it.id, url, &format!("{}.zip", it.id))?;
            let dst = Path::new(&target).join(it.id);
            std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
            if dry {
                format!("（模拟）会解压 {} → {}（strip {} 层）", zip.display(), dst.display(), strip)
            } else {
                run_powershell(&app, it.id, &format!(
                    "$tmp='{}'; Expand-Archive -LiteralPath '{}' -DestinationPath \"$tmp\" -Force; \
                     $inner=Get-ChildItem -LiteralPath \"$tmp\" | Select-Object -First 1; \
                     if ($inner -and $inner.PSIsContainer) {{ Move-Item -LiteralPath $inner.FullName -Destination '{}' -Force }} else {{ Get-ChildItem -LiteralPath \"$tmp\" | Move-Item -Destination '{}' -Force }}",
                    dst.display(), zip.display(), dst.display(), dst.display()
                ), false)?
            }
        }
        Plan::Winget { id: wid } => {
            if dry { format!("（模拟）会跑 winget install --id {} --silent", wid) }
            else {
                run_powershell(&app, it.id, &format!(
                    "winget install --id {wid} --accept-package-agreements --accept-source-agreements --disable-interactivity; exit $LASTEXITCODE"
                ), false)?
            }
        }
        Plan::Download { url, file, args, elevated } => {
            let f = download(&app, it.id, url, file)?;
            let cmd = if f.extension().map(|e| e.eq_ignore_ascii_case("msi")).unwrap_or(false) {
                format!("Start-Process msiexec.exe -ArgumentList '/i','\"{}\"','{}' -Wait", f.display(), args)
            } else {
                format!("Start-Process -FilePath '{}' -ArgumentList '{}' -Wait", f.display(), args)
            };
            if dry { format!("（模拟）下载到 {}，会执行：{}", f.display(), cmd) }
            else { run_powershell(&app, it.id, &cmd, elevated)? }
        }
    };
    if let Ok(mut g) = SCAN_CACHE.lock() { *g = None; }   // 装完让下次扫描重新跑
    emit(&app, it.id, "done", 100, "完成");
    Ok(log)
}
