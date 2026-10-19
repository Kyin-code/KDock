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
    #[allow(dead_code)]
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
    /// 下载单个可执行文件 → 直接放到 <安装目录>\<id>\ 里（绿色小工具，不用装）
    Fetch { url: &'static str, file: &'static str },
    /// 下载一组固件（原名 → 目标名）到 sigrok-cli 的 share\sigrok-firmware（DSLogic 这类）
    FwSet { base: &'static str, files: &'static [(&'static str, &'static str)] },
    /// 装 Python 包（python -m pip install --user --upgrade）
    Pip { packages: &'static str },
    /// git clone 到安装目录（RT-Thread Env）
    Git { repo: &'static str },
    /// 走 winget（微软包管理器）：有官方包的直接一键，不用我们猜直链
    Winget { id: &'static str },
    /// 走 Windows 可选组件（DISM Add-Capability）：OpenSSH 这类系统自带组件的正道
    /// service 非空 = 装完把服务设成自动并启动；post = 装完要补跑的命令
    Capability { cap: &'static str, service: &'static str, post: &'static [&'static str] },
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

/// 当前选的安装目录（前端 localStorage 里那份每次扫描/安装都传进来）。
/// 检测规则里写 `%ENVDIR%` 就能指到这儿，于是"用一键安装装完的东西下次一定找得到"。
static ENV_DIR: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

pub fn set_env_dir(p: &str) {
    if let Ok(mut g) = ENV_DIR.lock() {
        *g = p.trim().to_string();
    }
}

pub fn env_dir() -> String {
    let cur = ENV_DIR.lock().map(|g| g.clone()).unwrap_or_default();
    if !cur.trim().is_empty() {
        return cur;
    }
    // 还没人告诉过我们装哪儿（刚开机、前端还没扫过）也得有个像样的答案：
    // 否则 %ENVDIR% 会展开成空串，别的模块（找 plink 之类）就会漏看已经装好的东西
    let d = default_env_dir();
    set_env_dir(&d);
    d
}

/// 默认安装目录：优先 F:\ENV（老用户的老习惯），否则 %USERPROFILE%\KDock\env
pub fn default_env_dir() -> String {
    let f = Path::new("F:\\ENV");
    if f.is_dir() {
        return f.to_string_lossy().to_string();
    }
    Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
        .join("KDock\\env")
        .to_string_lossy()
        .to_string()
}

/// 展开 %VAR%（环境变量 + 我们的 %ENVDIR%）。检测规则里到处都是这种占位。
fn expand_vars(s: &str) -> String {
    let envd = env_dir();
    let mut out = String::with_capacity(s.len());
    let bytes: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '%' {
            if let Some(j) = (i + 1..bytes.len()).find(|&k| bytes[k] == '%') {
                let name: String = bytes[i + 1..j].iter().collect();
                let val = if name.eq_ignore_ascii_case("ENVDIR") {
                    Some(envd.clone())
                } else {
                    std::env::var(&name).ok().or_else(|| std::env::var(name.to_uppercase()).ok())
                };
                if let Some(v) = val {
                    out.push_str(&v);
                    i = j + 1;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// 梦源 DSLogic 各型号的固件（下载文件名 → sigrok 期望的文件名）
const DSLOGIC_FW: &[(&str, &str)] = &[
    ("DSLogic50.bin", "dreamsourcelab-dslogic-fpga-5v.fw"),
    ("DSLogic33.bin", "dreamsourcelab-dslogic-fpga-3v3.fw"),
    ("DSLogic.fw", "dreamsourcelab-dslogic-fx2.fw"),
    ("DSLogicPro.bin", "dreamsourcelab-dslogic-pro-fpga.fw"),
    ("DSLogicPro.fw", "dreamsourcelab-dslogic-pro-fx2.fw"),
    ("DSLogicPlus.bin", "dreamsourcelab-dslogic-plus-fpga.fw"),
    ("DSLogicPlus.fw", "dreamsourcelab-dslogic-plus-fx2.fw"),
    ("DSLogicBasic.bin", "dreamsourcelab-dslogic-basic-fpga.fw"),
    ("DSLogicBasic.fw", "dreamsourcelab-dslogic-basic-fx2.fw"),
];

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
        plan: Plan::Winget { id: "NordicSemiconductor.JLink" },   // Nordic 转发的官方 J-Link 安装包，winget 能直装
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
        id: "sigrok_cli",
        name: "sigrok-cli（逻辑分析仪的采集后端）",
        kind_cn: "逻辑分析仪",
        desc: "PulseView 同门的命令行采集工具。KDock 的「逻辑分析仪 → 真机」就是调它：fx2lafw（Saleae Logic / 各种 FX2 板）、saleae-logic16、DSLogic 这些都能用。装完不用配置，回到页面点 ↻ 就能看到设备。",
        url: "https://sigrok.org/wiki/Downloads",
        required: false,
        min_version: Some("0.7"),
        size_mb: 40.0,
        rules: &[exe("sigrok-cli.exe", "C:\\Program Files\\sigrok\\sigrok-cli;C:\\Program Files\\sigrok;D:\\ENV;F:\\ENV;I:\\ENV", "--version", "")],
        plan: Plan::Download {
            url: "https://sigrok.org/download/binary/sigrok-cli/sigrok-cli-0.7.2-x86_64-installer.exe",
            file: "sigrok-cli-0.7.2-x86_64-installer.exe",
            args: "/S",
            elevated: true,
        },
    },
    Item {
        id: "dslogic_fw",
        name: "DSLogic（梦源）固件",
        kind_cn: "逻辑分析仪",
        desc: "梦源 DSLogic 系列（Basic / Plus / Pro / U2 / U3）在 sigrok 里要这两样固件：FX2 固件 + FPGA 位流。没有它们，插上 DSLogic 也扫不到设备（sigrok-cli 会报找不到固件）。装到 sigrok-cli 的 share\\sigrok-firmware 下。",
        url: "https://sigrok.org/wiki/DreamSourceLab_DSLogic",
        required: false,
        min_version: None,
        size_mb: 1.5,
        rules: &[glob("C:\\Program Files\\sigrok\\sigrok-cli\\share\\sigrok-firmware\\dreamsourcelab-dslogic-*.fw", "", "")],
        plan: Plan::FwSet {
            base: "https://github.com/DreamSourceLab/DSView/raw/886b847c21c606df3138ce7ad8f8e8c363ee758b/DSView/res",
            files: DSLOGIC_FW,
        },
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
    // ── 下面这几个是"KDock 自己要调用的外部程序"：装了才能用对应的页面/功能 ──
    Item {
        id: "adb",
        name: "Android Platform Tools（adb）",
        kind_cn: "安卓",
        desc: "Google 官方的 adb（含 fastboot）。「安卓 ADB」页要靠它连手机/平板/开发板：列设备、跑 shell、装卸 APK、推拉文件、抓屏投屏。",
        url: "https://developer.android.com/tools/releases/platform-tools",
        required: false,
        min_version: None,
        size_mb: 6.0,
        rules: &[
            exe("adb.exe", "%ENVDIR%\\adb;%ENVDIR%;%LOCALAPPDATA%\\Android\\Sdk\\platform-tools;%USERPROFILE%\\platform-tools;%USERPROFILE%\\AppData\\Local\\Android\\Sdk\\platform-tools;C:\\platform-tools;D:\\platform-tools;C:\\Android\\platform-tools", "version", ""),
            glob("%ENVDIR%\\adb\\adb.exe", "version", ""),
        ],
        plan: Plan::Zip { url: "https://dl.google.com/android/repository/platform-tools-latest-windows.zip", strip: 1 },
    },
    Item {
        id: "scrcpy",
        name: "scrcpy（安卓投屏 / 反向控制）",
        kind_cn: "安卓",
        desc: "把安卓设备画面投到电脑上、还能用鼠标键盘反向控制（走 adb，不需要装手机端 App）。「安卓 ADB」页的「用 scrcpy 投屏」调的就是它。",
        url: "https://github.com/Genymobile/scrcpy/releases",
        required: false,
        min_version: None,
        size_mb: 60.0,
        rules: &[
            exe("scrcpy.exe", "%ENVDIR%\\scrcpy;%ENVDIR%;%USERPROFILE%\\scrcpy;%LOCALAPPDATA%\\scrcpy;C:\\scrcpy;D:\\scrcpy;E:\\scrcpy", "--version", ""),
            glob("%ENVDIR%\\scrcpy\\scrcpy.exe", "--version", ""),
        ],
        // 官方 win64 包（GitHub Release）。国内网络下 GitHub 资源可能很慢/会断 ——
        // 那就把 zip 丢进 <exe 同目录>\drivers\scrcpy\（内置包那条路）再点一次，一样的。
        plan: Plan::Zip { url: "https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-win64-v5.0.1.zip", strip: 1 },
    },
    Item {
        id: "ffmpeg",
        name: "FFmpeg（H.264 / RTSP / RTMP 解码）",
        kind_cn: "音视频",
        desc: "「屏幕共享」页的 RTSP / RTMP / H.264 流全靠它解码（拉流交给 ffmpeg 子进程，KDock 不链接它的库，规避 GPL/LGPL 传染）。",
        url: "https://www.gyan.dev/ffmpeg/builds/",
        required: false,
        min_version: None,
        size_mb: 95.0,
        rules: &[
            exe("ffmpeg.exe", "%ENVDIR%\\ffmpeg;%ENVDIR%;%USERPROFILE%\\ffmpeg;C:\\ffmpeg;C:\\ffmpeg\\bin;D:\\ffmpeg;D:\\ffmpeg\\bin;E:\\ffmpeg\\bin;%LOCALAPPDATA%\\Microsoft\\WinGet\\Links", "-version", ""),
            glob("%ENVDIR%\\ffmpeg\\bin\\ffmpeg.exe", "-version", ""),
            glob("%ENVDIR%\\ffmpeg*\\bin\\ffmpeg.exe", "-version", ""),
        ],
        // BtbN 的 LGPL 构建（GitHub Release，永远是 latest）：不选 gpl 那个，
        // 免得用户以后想链接这些库时被许可绊住（我们只是当外部程序调用）。
        // 下不动就把 zip 丢进 <exe 同目录>\drivers\ffmpeg\。
        plan: Plan::Zip { url: "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-lgpl.zip", strip: 1 },
    },
    Item {
        id: "tftpd",
        name: "Tftpd64（TFTP 服务端）",
        kind_cn: "网络服务",
        desc: "独立的 TFTP 服务器（Tftpd64，含客户端/服务端/SNTP）。KDock 的「文件管理」页自带 TFTP 客户端与内置服务端，这个装不装都能用；要更全的功能（DHCP、日志、多网卡绑定）就装它。",
        url: "https://pjo2.github.io/tftpd64/",
        required: false,
        min_version: None,
        size_mb: 2.0,
        rules: &[
            exe("tftpd64.exe", "C:\\Program Files\\Tftpd64;C:\\Program Files (x86)\\Tftpd64;C:\\Tftpd64;D:\\Tftpd64;E:\\Tftpd64;%ENVDIR%\\tftpd", "", ""),
            exe("tftpd32.exe", "C:\\Program Files\\Tftpd64;C:\\Program Files (x86)\\Tftpd64;C:\\Tftpd64;D:\\Tftpd64;E:\\Tftpd64;%ENVDIR%\\tftpd", "", ""),
            glob("*:\\Tftpd64\\tftpd64.exe", "", ""),
        ],
        plan: Plan::Download {
            url: "https://github.com/PJO2/tftpd64/releases/download/v4.70/Tftpd64_Installer_v4.70.exe",
            file: "Tftpd64_Installer_v4.70.exe",
            args: "/S",
            elevated: true,
        },
    },
    Item {
        id: "ssh",
        name: "OpenSSH 客户端（ssh / scp / sftp）",
        kind_cn: "网络服务",
        desc: "Windows 自带的 OpenSSH 客户端。「传输」页选 SSH 方式、「中控编排」的 SSH 步骤、命令表里的远程命令都靠它；一条命令就能装（DISM 可选组件，不联网）。",
        url: "https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse",
        required: false,
        min_version: None,
        size_mb: 5.0,
        rules: &[
            exe("ssh.exe", "C:\\Windows\\System32\\OpenSSH;%ProgramFiles%\\OpenSSH;%ENVDIR%\\openssh", "-V", "OpenSSH_for_Windows_"),
            glob("C:\\Windows\\System32\\OpenSSH\\ssh.exe", "", ""),
        ],
        plan: Plan::Capability { cap: "OpenSSH.Client~~~~0.0.1.0", service: "", post: &[] },
    },
    Item {
        id: "plink",
        name: "PuTTY plink（SSH 密码登录用）",
        kind_cn: "网络服务",
        desc: "Windows 自带的 ssh.exe 在「密码」这一步只认控制台、不认管道，所以纯密码登录（大多数开发板/设备）要它 —— KDock 的 SSH 连接在填了密码时会优先用 plink。密钥登录用不着它。",
        url: "https://www.putty.org/",
        required: false,
        min_version: None,
        size_mb: 1.0,
        rules: &[
            exe("plink.exe", "%ENVDIR%\\plink;%ProgramFiles%\\PuTTY;%ProgramFiles(x86)%\\PuTTY;%ENVDIR%\\putty", "-V", "Release"),
            glob("%ENVDIR%\\plink\\plink.exe", "", ""),
        ],
        plan: Plan::Fetch { url: "https://the.earth.li/~sgtatham/putty/latest/w64/plink.exe", file: "plink.exe" },
    },
    Item {
        id: "sshd",
        name: "OpenSSH 服务端（sshd，可选）",
        kind_cn: "网络服务",
        desc: "把本机变成 SSH 服务器（别人/别的设备 scp、ssh 进来取日志、传固件）。装完自动配好密钥、设成开机自启并启动；不想要就在服务里停掉 sshd。",
        url: "https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse",
        required: false,
        min_version: None,
        size_mb: 5.0,
        rules: &[
            glob("C:\\Windows\\System32\\OpenSSH\\sshd.exe", "", ""),
            exe("sshd.exe", "C:\\Windows\\System32\\OpenSSH;%ProgramFiles%\\OpenSSH", "", ""),
        ],
        plan: Plan::Capability {
            cap: "OpenSSH.Server~~~~0.0.1.0",
            service: "sshd",
            post: &["ssh-keygen -A"],
        },
    },
    // ── 2026-10 扩充：USB 转串口 / 桥接芯片（纯驱动；官网入口 + 内置安装包） ──
    Item {
        id: "cp210x",
        name: "Silicon Labs CP210x 串口驱动",
        kind_cn: "USB 驱动",
        desc: "CP2102 / CP2104 / CP2105 / CP2108 —— 开发板最常见的 USB 转串口之一。装完才会出现 COM 口。",
        url: "https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers",
        required: false,
        min_version: None,
        size_mb: 12.0,
        rules: &[inf("silabser.inf")],
        plan: Plan::Manual,
    },
    Item {
        id: "pl2303",
        name: "Prolific PL2303 串口驱动",
        kind_cn: "USB 驱动",
        desc: "老款 USB 转串口，工业设备和老开发板很多。注意新版 Windows 上老芯片会被官方驱动拒认，必要时用内置的旧版安装包。",
        url: "https://www.prolific.com.tw/US/ShowProduct.aspx?p_id=225&pcid=41",
        required: false,
        min_version: None,
        size_mb: 5.0,
        rules: &[inf("ser2pl.inf"), inf("ser2pl64.inf")],
        plan: Plan::Manual,
    },
    Item {
        id: "mcp2200",
        name: "Microchip MCP2200 / MCP2221 驱动",
        kind_cn: "USB 驱动",
        desc: "USB 转串口 + GPIO / I2C 的桥接芯片，Microchip 官方 CDC 驱动。",
        url: "https://www.microchip.com/en-us/product/MCP2200",
        required: false,
        min_version: None,
        size_mb: 5.0,
        rules: &[inf("mchpcdc.inf")],
        plan: Plan::Manual,
    },
    Item {
        id: "cyserial",
        name: "Infineon / Cypress USB-Serial 驱动",
        kind_cn: "USB 驱动",
        desc: "CY7C65211 / CY7C65215 这类 USB-Serial 桥接（也带 GPIO / I2C / SPI）。",
        url: "https://www.infineon.com/cms/en/product/universal-serial-bus/usb-serial-bridge-controller/",
        required: false,
        min_version: None,
        size_mb: 10.0,
        rules: &[inf("cyusbserial.inf")],
        plan: Plan::Manual,
    },
    // ── 调试探针 ──
    Item {
        id: "wchlink",
        name: "WCH-Link / WCH-LinkE 驱动",
        kind_cn: "调试器",
        desc: "沁恒 RISC-V / Cortex-M 调试器（WCH-Link、WCH-LinkE）。用 WCH-LinkUtility 或 MounRiver 时会装。",
        url: "https://www.wch.cn/downloads/WCH-LinkUtility_ZIP.html",
        required: false,
        min_version: None,
        size_mb: 5.0,
        rules: &[inf("wchlink.inf"), inf("wchlinke.inf")],
        plan: Plan::Manual,
    },
    Item {
        id: "xds110",
        name: "TI XDS110 / XDS100 驱动",
        kind_cn: "调试器",
        desc: "TI MSP430 / C2000 / Sitara 的 XDS110、XDS100 调试探针驱动（CCS 里带，也可以单独装）。",
        url: "https://www.ti.com/tool/CCSTUDIO",
        required: false,
        min_version: None,
        size_mb: 20.0,
        rules: &[inf("xds110usb.inf"), inf("xds110port.inf")],
        plan: Plan::Manual,
    },
    // ── 工具链 / 构建 / 脚本 ──
    Item {
        id: "python",
        name: "Python 3",
        kind_cn: "构建",
        desc: "脚本与工具依赖：pyOCD、esptool、pyserial、intelhex 这些都要它。装完记得勾 Add to PATH（winget 默认会加）。",
        url: "https://www.python.org/downloads/windows/",
        required: false,
        min_version: Some("3.8"),
        size_mb: 30.0,
        rules: &[exe("python.exe", "", "--version", "")],
        plan: Plan::Winget { id: "Python.Python.3.12" },
    },
    Item {
        id: "git",
        name: "Git（含 Git LFS 可用）",
        kind_cn: "构建",
        desc: "版本控制；RT-Thread Env 拉包、很多 SDK 的 submodule 都靠它。",
        url: "https://git-scm.com/download/win",
        required: false,
        min_version: Some("2.30"),
        size_mb: 60.0,
        rules: &[exe("git.exe", "", "--version", "")],
        plan: Plan::Winget { id: "Git.Git" },
    },
    Item {
        id: "cmake",
        name: "CMake",
        kind_cn: "构建",
        desc: "跨平台构建系统：STM32Cube / ESP-IDF / Zephyr / 大多数现代嵌入式工程都用它生成 Ninja / Make 工程。",
        url: "https://cmake.org/download/",
        required: false,
        min_version: Some("3.20"),
        size_mb: 60.0,
        rules: &[exe("cmake.exe", "C:\\Program Files\\CMake\\bin;D:\\ENV;F:\\ENV", "--version", "")],
        plan: Plan::Winget { id: "Kitware.CMake" },
    },
    Item {
        id: "ninja",
        name: "Ninja",
        kind_cn: "构建",
        desc: "CMake 最常用的后端：比 Make 快很多，几乎所有嵌入式 IDE 的默认选择。",
        url: "https://ninja-build.org/",
        required: false,
        min_version: Some("1.10"),
        size_mb: 5.0,
        rules: &[exe("ninja.exe", "C:\\Program Files\\Ninja;D:\\ENV;F:\\ENV", "--version", "")],
        plan: Plan::Winget { id: "Ninja-build.Ninja" },
    },
    Item {
        id: "meson",
        name: "Meson",
        kind_cn: "构建",
        desc: "另一套现代构建系统（Zephyr / 部分开源 BSP 在用），配合 Ninja。",
        url: "https://mesonbuild.com/",
        required: false,
        min_version: Some("0.60"),
        size_mb: 10.0,
        rules: &[exe("meson.exe", "", "--version", "")],
        plan: Plan::Winget { id: "mesonbuild.meson" },
    },
    Item {
        id: "llvm",
        name: "LLVM / Clang + lld",
        kind_cn: "工具链",
        desc: "替代 GCC 的编译器，部分工程（RISC-V / 嵌入式 Rust / 某些 SDK）需要；也自带 lld 链接器。",
        url: "https://llvm.org/",
        required: false,
        min_version: Some("15"),
        size_mb: 900.0,
        rules: &[exe("clang.exe", "C:\\Program Files\\LLVM\\bin;D:\\ENV;F:\\ENV", "--version", "")],
        plan: Plan::Winget { id: "LLVM.LLVM" },
    },
    Item {
        id: "openssl",
        name: "OpenSSL",
        kind_cn: "构建",
        desc: "生成密钥 / 证书 / 摘要，固件签名和 TLS 调试都会用到。",
        url: "https://slproweb.com/products/Win32OpenSSL.html",
        required: false,
        min_version: Some("1.1"),
        size_mb: 30.0,
        rules: &[exe("openssl.exe", "C:\\Program Files\\OpenSSL-Win64\\bin;D:\\ENV;F:\\ENV", "version", "")],
        plan: Plan::Winget { id: "ShiningLight.OpenSSL.Light" },
    },
    Item {
        id: "qemu",
        name: "QEMU",
        kind_cn: "运行时",
        desc: "仿真运行：没有板子时跑 ARM / RISC-V Linux、跑 U-Boot 验证镜像。",
        url: "https://www.qemu.org/download/#windows",
        required: false,
        min_version: Some("6.0"),
        size_mb: 200.0,
        rules: &[exe("qemu-system-x86_64.exe", "C:\\Program Files\\qemu", "--version", "")],
        plan: Plan::Winget { id: "SoftwareFreedomConservancy.QEMU" },
    },
    Item {
        id: "renode",
        name: "Renode",
        kind_cn: "运行时",
        desc: "无板仿真：整块板子（CPU + 外设 + 网络）都能模拟，适合 CI 里跑固件。",
        url: "https://renode.io/",
        required: false,
        min_version: None,
        size_mb: 120.0,
        rules: &[exe("Renode.exe", "C:\\Program Files\\Renode", "", "")],
        plan: Plan::Winget { id: "Renode.Renode" },
    },
    Item {
        id: "dtc",
        name: "Device Tree Compiler（dtc）",
        kind_cn: "构建",
        desc: "编译 / 反编译设备树（.dts ↔ .dtb），Linux BSP 和 U-Boot 常用。",
        url: "https://git.kernel.org/pub/scm/utils/dtc/dtc.git",
        required: false,
        min_version: None,
        size_mb: 2.0,
        rules: &[exe("dtc.exe", "", "--version", "")],
        plan: Plan::Winget { id: "oss-winget.dtc" },
    },
    Item {
        id: "usbdk",
        name: "UsbDk Runtime",
        kind_cn: "USB 驱动",
        desc: "USB 设备重定向 / 抓包用的通用运行时（Wireshark 的 USBPcap、部分虚拟化工具依赖）。",
        url: "https://github.com/daynix/UsbDk",
        required: false,
        min_version: None,
        size_mb: 5.0,
        rules: &[inf("usbdk.inf")],
        plan: Plan::Winget { id: "daynix.UsbDk" },
    },
    // ── 网络 / 协议 ──
    Item {
        id: "wireshark",
        name: "Wireshark",
        kind_cn: "网络",
        desc: "网络 / USB / BLE / CAN 抓包分析。配合 USBPcap、nRF Sniffer 用。",
        url: "https://www.wireshark.org/download.html",
        required: false,
        min_version: None,
        size_mb: 90.0,
        rules: &[exe("Wireshark.exe", "C:\\Program Files\\Wireshark", "", "")],
        plan: Plan::Winget { id: "WiresharkFoundation.Wireshark" },
    },
    Item {
        id: "mobaxterm",
        name: "MobaXterm",
        kind_cn: "网络",
        desc: "终端 + 串口 + X11 + SFTP 的多合一工具（A 核 / Linux 板子常用）。",
        url: "https://mobaxterm.mobatek.net/download.html",
        required: false,
        min_version: None,
        size_mb: 30.0,
        rules: &[glob("*:\\Program Files\\Mobatek\\MobaXterm\\MobaXterm.exe", "", "")],
        plan: Plan::Winget { id: "Mobatek.MobaXterm" },
    },
    // ── 烧录 / 调试 CLI ──
    Item {
        id: "pyocd",
        name: "pyOCD",
        kind_cn: "烧录",
        desc: "Python 版 CMSIS-DAP / J-Link 调试与烧录 CLI（DAPLink、ST-Link、J-Link 都能用）。需要先装 Python。",
        url: "https://pyocd.io/",
        required: false,
        min_version: None,
        size_mb: 15.0,
        rules: &[
            exe("pyocd.exe", "", "--version", ""),
            glob("*:\\Users\\*\\AppData\\Roaming\\Python\\Python3*\\Scripts\\pyocd.exe", "", ""),
        ],
        plan: Plan::Pip { packages: "pyocd" },
    },
    Item {
        id: "esptool",
        name: "esptool（ESP32 烧录）",
        kind_cn: "烧录",
        desc: "ESP32 / ESP8266 的烧录、读 MAC、擦除、读 Flash。需要先装 Python。",
        url: "https://docs.espressif.com/projects/esptool/",
        required: false,
        min_version: None,
        size_mb: 10.0,
        rules: &[
            exe("esptool.exe", "", "version", ""),
            glob("*:\\Users\\*\\AppData\\Roaming\\Python\\Python3*\\Scripts\\esptool.exe", "", ""),
        ],
        plan: Plan::Pip { packages: "esptool" },
    },
    Item {
        id: "esp_idf",
        name: "ESP-IDF（安装管理器）",
        kind_cn: "工具链",
        desc: "乐鑫官方 ESP-IDF 安装管理器 CLI：装工具链、拉 SDK、切版本都在它里面。",
        url: "https://docs.espressif.com/projects/esp-idf/",
        required: false,
        min_version: None,
        size_mb: 40.0,
        rules: &[exe("eim.exe", "", "--version", "")],
        plan: Plan::Winget { id: "Espressif.EIM-CLI" },
    },
    // ── 蓝牙 / BLE ──
    Item {
        id: "nrfutil",
        name: "nRF Util（Nordic CLI）",
        kind_cn: "蓝牙",
        desc: "Nordic 的通用 CLI：nRF52 系列 DFU 打包 / 烧录、BLE 调试辅助（nrfutil device / dfu）。",
        url: "https://www.nordicsemi.com/Products/Development-tools/nRF-Util",
        required: false,
        min_version: None,
        size_mb: 30.0,
        rules: &[exe("nrfutil.exe", "", "--version", "")],
        plan: Plan::Winget { id: "NordicSemiconductor.nrfutil" },
    },
    Item {
        id: "nrf_connect",
        name: "nRF Connect for Desktop（BLE 调试）",
        kind_cn: "蓝牙",
        desc: "Nordic 的 BLE 桌面工具：扫广播、连 GATT、读写特征值、看 RSSI，配 nRF Sniffer 还能抓 BLE 包。Windows 自带蓝牙协议栈，不用另装驱动。",
        url: "https://www.nordicsemi.com/Products/Development-tools/nRF-Connect-for-Desktop",
        required: false,
        min_version: None,
        size_mb: 250.0,
        rules: &[
            glob("*:\\Program Files\\Nordic Semiconductor\\nRF Connect for Desktop\\*\\nRF Connect for Desktop.exe", "", ""),
            glob("*:\\Users\\*\\AppData\\Local\\Programs\\nrfconnect\\*\\nRF Connect for Desktop.exe", "", ""),
        ],
        plan: Plan::Manual,
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

/// 带"定位标记"的版本提取：先在输出里找 marker（如 "OpenSSH_for_Windows_"），
/// 再取它后面那串数字/点。用来避开"输出里先出现别的版本号"的坑
/// （`ssh -V` 会打印 "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2"，朴素扫法会抓到 3.8.2）。
pub fn pick_version_marked(text: &str, marker: &str) -> Option<String> {
    let idx = text.find(marker)?;
    let rest = &text[idx + marker.len()..];
    let v: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let v = v.trim_end_matches('.').to_string();
    if v.chars().any(|c| c == '.') && v.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
        Some(v)
    } else {
        None
    }
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
    let extra = expand_vars(extra);
    for root in extra.split(';').filter(|s| !s.trim().is_empty()) {
        let p = Path::new(root).join(name);
        if p.is_file() { return Some(p); }
        // 根目录下就一层 bin（ffmpeg 解包后就是 <root>\bin\ffmpeg.exe）
        let pb = Path::new(root).join("bin").join(name);
        if pb.is_file() { return Some(pb); }
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

/// 给别的模块用：按同样的规则找一个外部程序（%ENVDIR% 也会展开）
pub fn find_tool(name: &str, extra: &str) -> Option<PathBuf> {
    find_exe(name, extra)
}

/// 给别的模块用：跑个程序抓输出（CREATE_NO_WINDOW，不闪黑框）
pub fn run_text(prog: &str, args: &[&str]) -> Option<String> {
    run_out(prog, args)
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
    let norm = expand_vars(pat).replace('/', "\\");
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
                            version = if r.ver_match.is_empty() {
                                pick_version(&t)
                            } else {
                                pick_version_marked(&t, r.ver_match).or_else(|| pick_version(&t))
                            };
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
                            version = if r.ver_match.is_empty() {
                                pick_version(&t)
                            } else {
                                pick_version_marked(&t, r.ver_match).or_else(|| pick_version(&t))
                            };
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
pub async fn env_scan(force: Option<bool>, dir: Option<String>) -> Result<Value, String> {
    // 前端把"安装目录"传进来：清单里那些 %ENVDIR% 规则要用它去找
    if let Some(d) = dir.filter(|d| !d.trim().is_empty()) {
        set_env_dir(&d);
    }
    // 清单长到 40+ 项后一次扫描要 1 秒出头 —— 丢到阻塞线程池，别卡 UI（首次运行检查也走它）
    tauri::async_runtime::spawn_blocking(move || {
        if !force.unwrap_or(false) {
            if let Ok(g) = SCAN_CACHE.lock() {
                if let Some((t, v)) = g.as_ref() {
                    if t.elapsed().as_secs() < 900 {
                        return Ok(v.clone());
                    }
                }
            }
        }
        let v = env_scan_now()?;
        if let Ok(mut g) = SCAN_CACHE.lock() {
            *g = Some((std::time::Instant::now(), v.clone()));
        }
        Ok(v)
    })
    .await
    .map_err(|e| format!("后台扫描失败：{e}"))?
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
        "envDir": if env_dir().is_empty() { default_env_dir() } else { env_dir() },
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
    // 下到 .part 再改名：中途断了/卡住了不会留下一个"看着完整、其实是半截"的文件
    // （之前就吃过这个亏：断了之后下次直接复用了半截包，解压出一堆怪东西）
    let part = dir.join(format!("{file}.part"));
    std::fs::remove_file(&part).ok();
    emit(app, id, "download", 5, &format!("开始下载 {}", file));
    let resp = ureq::get(url).timeout(std::time::Duration::from_secs(900)).call().map_err(|e| format!("下载失败: {e}（网络不通/太慢？也可以把包手动丢进 {}）", download_dir()))?;
    let total: u64 = resp.header("Content-Length").and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 64 * 1024];
    let mut got: u64 = 0;
    let mut last = 0i32;
    loop {
        let n = match std::io::Read::read(&mut reader, &mut buf) {
            Ok(n) => n,
            Err(e) => {
                drop(out);
                std::fs::remove_file(&part).ok();
                return Err(format!("下载中断（已下 {} MB）: {e}", got / 1048576));
            }
        };
        if n == 0 { break; }
        std::io::Write::write_all(&mut out, &buf[..n]).map_err(|e| e.to_string())?;
        got += n as u64;
        let pct = if total > 0 { (got * 100 / total) as i32 } else { 50 };
        if pct >= last + 5 { last = pct; emit(app, id, "download", pct, &format!("下载中 {}%", pct)); }
    }
    drop(out);
    if total > 0 && got < total {
        std::fs::remove_file(&part).ok();
        return Err(format!("下载不完整（{}/{} MB），已丢弃重来", got / 1048576, total / 1048576));
    }
    std::fs::rename(&part, &dst).map_err(|e| format!("改名到 {} 失败: {e}", dst.display()))?;
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

/// 解开一个 zip 到 dst。strip=1 时，如果包里只有一层顶层目录（platform-tools / scrcpy-win64-vX
/// / ffmpeg-x-essentials_build 都是这样），就把那层"扒掉"，把内容直接落到 dst 下 ——
/// 这样检测规则能写成固定的 <ENVDIR>\<id>\xxx.exe，不用猜版本号目录名。
fn unzip_into(app: &tauri::AppHandle, id: &str, zip: &Path, dst: &Path, strip: u32) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    emit(app, id, "install", 70, &format!("解压到 {}", dst.display()));
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         $z='{zip}'; $dst='{dst}'; $strip={strip}; \
         $t=Join-Path $env:TEMP ('kdock_zip_' + [guid]::NewGuid().ToString('N')); \
         Expand-Archive -LiteralPath $z -DestinationPath $t -Force; \
         $src=$t; \
         if ($strip -ge 1) {{ \
           $kids=@(Get-ChildItem -LiteralPath $t); \
           while ($kids.Count -eq 1 -and $kids[0].PSIsContainer) {{ \
             $src=$kids[0].FullName; $kids=@(Get-ChildItem -LiteralPath $src) }} \
         }} \
         New-Item -ItemType Directory -Force -Path $dst | Out-Null; \
         Get-ChildItem -LiteralPath $src -Force | Move-Item -Destination $dst -Force; \
         Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction SilentlyContinue; \
         'unzip-ok'",
        zip = zip.display(),
        dst = dst.display(),
        strip = strip
    );
    let out = run_powershell(app, id, &script, false)?;
    if out.contains("unzip-ok") {
        Ok(())
    } else {
        Err(format!("解压失败：{}", out.chars().rev().take(600).collect::<String>().chars().rev().collect::<String>()))
    }
}

/// 安装 / 更新。dry = 只打印将要做什么（下载照做，但不执行安装器）——测试用
#[tauri::command]
pub async fn env_install(app: tauri::AppHandle, id: String, dir: Option<String>, dry: Option<bool>) -> Result<String, String> {
    let dry = dry.unwrap_or(false);
    let it = ITEMS.iter().find(|x| x.id == id).ok_or_else(|| format!("不认识的组件：{id}"))?;
    let target = dir.unwrap_or_else(|| {
        let d = env_dir();
        if d.trim().is_empty() { default_env_dir() } else { d }
    });
    set_env_dir(&target);          // 后面的检测规则（%ENVDIR%）按这个目录找
    emit(&app, it.id, "start", 0, &format!("准备安装 {}", it.name));

    // ① 先看有没有"内置"的安装包：<exe 同目录>drivers<id> 下放 .exe/.msi/.inf/.zip 就直接用
    //    （CH340/FTDI 这种官网要登录的、或者公司网不好下 GitHub 的，把安装包提前丢进去就能一键装）
    let mut bundled: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            if let Ok(rd) = std::fs::read_dir(d.join("drivers").join(it.id)) {
                for e in rd.flatten() {
                    let p = e.path();
                    let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
                    if ["exe", "msi", "inf", "zip"].contains(&ext.as_str()) { bundled.push(p); }
                }
            }
        }
    }
    if !bundled.is_empty() {
        let mut outs = Vec::new();
        for p in &bundled {
            let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            if ext == "zip" {
                // 内置压缩包：走和"一键下载装完"完全一样的那条解包路
                let dst = Path::new(&target).join(it.id);
                emit(&app, it.id, "install", 40, &format!("内置压缩包：{}", p.file_name().unwrap_or_default().to_string_lossy()));
                if dry { outs.push(format!("（模拟）会解压 {} → {}", p.display(), dst.display())); }
                else { unzip_into(&app, it.id, p, &dst, 1)?; outs.push(format!("已解压到 {}", dst.display())); }
                continue;
            }
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
        return Ok(format!("用了内置安装包：\n{}", outs.join("\n")));
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
            if dry {
                format!("（模拟）会解压 {} → {}（strip {} 层）", zip.display(), dst.display(), strip)
            } else {
                unzip_into(&app, it.id, &zip, &dst, strip)?;
                format!("已解压到 {}（strip {} 层）", dst.display(), strip)
            }
        }
        Plan::Fetch { url, file } => {
            let dst_dir = Path::new(&target).join(it.id);
            std::fs::create_dir_all(&dst_dir).map_err(|e| e.to_string())?;
            let f = download(&app, it.id, url, file)?;
            let dst = dst_dir.join(file);
            if dry {
                format!("（模拟）下载 {} → {}", f.display(), dst.display())
            } else {
                std::fs::copy(&f, &dst).map_err(|e| format!("复制到 {} 失败: {e}", dst.display()))?;
                format!("已放到 {}", dst.display())
            }
        }
        Plan::Capability { cap, service, post } => {
            // Windows 可选组件（OpenSSH 这种）：DISM 加组件，不需要联网
            let mut ps = format!(
                "$ErrorActionPreference='Continue'; \
                 $c=(Get-WindowsCapability -Online -Name '{cap}'); \
                 if ($c.State -eq 'Installed') {{ 'already-installed' }} else {{ \
                   Add-WindowsCapability -Online -Name '{cap}' | Out-Null; 'installed' }}"
            );
            for p in post {
                ps.push_str(&format!("; {p}"));
            }
            if !service.is_empty() {
                ps.push_str(&format!(
                    "; Set-Service -Name {service} -StartupType Automatic -ErrorAction SilentlyContinue; \
                     Start-Service -Name {service} -ErrorAction SilentlyContinue; \
                     (Get-Service -Name {service}).Status"
                ));
            }
            if dry { format!("（模拟）会跑 DISM 可选组件 {cap}（服务 {service}）") }
            else { run_powershell(&app, it.id, &ps, true)? }
        }
        Plan::Winget { id: wid } => {
            if run_out("winget.exe", &["--version"]).is_none() {
                return Ok(format!(
                    "这台机器上没有 winget（应用安装程序），装不了「{}」。请到官网下载安装：{}",
                    it.name, it.url
                ));
            }
            if dry { format!("（模拟）会跑 winget install --id {} --silent", wid) }
            else {
                run_powershell(&app, it.id, &format!(
                    "winget install --id {wid} --accept-package-agreements --accept-source-agreements --disable-interactivity; exit $LASTEXITCODE"
                ), false)?
            }
        }
        Plan::Pip { packages } => {
            if dry {
                format!("（模拟）会跑 python -m pip install --user --upgrade {packages}")
            } else {
                run_powershell(&app, it.id, &format!(
                    "python -m pip install --user --upgrade {packages}; exit $LASTEXITCODE"
                ), false)?
            }
        }
        Plan::FwSet { base, files } => {
            let cli = find_exe("sigrok-cli.exe", "C:\\Program Files\\sigrok\\sigrok-cli;C:\\Program Files\\sigrok;D:\\ENV;F:\\ENV;I:\\ENV")
                .ok_or_else(|| "先装 sigrok-cli（清单里上一项），再回来装这个固件".to_string())?;
            let fwdir = cli
                .parent()
                .map(|p| p.join("share").join("sigrok-firmware"))
                .ok_or_else(|| "找不到 sigrok-cli 的安装目录".to_string())?;
            let mut got: Vec<std::path::PathBuf> = Vec::new();
            for (src, dst) in files {
                let url = format!("{base}/{src}");
                got.push(download(&app, it.id, &url, dst)?);
            }
            let list = got.iter().map(|p| format!("'{}'", p.display())).collect::<Vec<_>>().join(",");
            let script = format!(
                "New-Item -ItemType Directory -Force -Path '{}' | Out-Null;                  Copy-Item -LiteralPath @({list}) -Destination '{}' -Force;                  (Get-ChildItem '{}' -Filter 'dreamsourcelab-*').Count",
                fwdir.display(),
                fwdir.display(),
                fwdir.display()
            );
            if dry {
                format!("（模拟）会下载 {} 个固件并复制到 {}（需要 UAC）", files.len(), fwdir.display())
            } else {
                run_powershell(&app, it.id, &script, true)?
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
