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
    Device,   // 当前已正常枚举的 USB/PnP 设备（按 Instance ID 或友好名匹配）
    PyOcd,    // 通过 pyOCD 枚举探针（跨厂商、跨 VID/PID）
    Pip,      // `python -m pip show <包名>` 能不能查到（纯库类组件没有自己的 exe）
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
const fn device(a: &'static str) -> Rule {
    Rule { kind: Kind::Device, a, b: "", ver_args: "", ver_match: "" }
}
const fn pyocd_probe() -> Rule {
    Rule { kind: Kind::PyOcd, a: "", b: "", ver_args: "", ver_match: "" }
}
/// pip 包检测：a = 包名（用 `python -m pip show` 查）
const fn pip(a: &'static str) -> Rule {
    Rule { kind: Kind::Pip, a, b: "", ver_args: "", ver_match: "" }
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
    /// cargo install --locked（Rust 写的命令行工具：probe-rs 这类），需要先装 Rust
    Cargo { package: &'static str },
    /// git clone 到安装目录（RT-Thread Env）
    Git { repo: &'static str },
    /// git clone 并递归拉 submodule（LVGL 的 Windows 模拟器工程就是这么组织的：
    /// lvgl / freetype 都在 .gitmodules 里，只 clone 主仓库会得到一个空壳工程）
    GitSub { repo: &'static str },
    /// 走 winget（微软包管理器）：有官方包的直接一键，不用我们猜直链
    Winget { id: &'static str },
    /// 走 winget，但安装器的参数要自己给（`--override`）。
    /// 典型是 VS Build Tools：必须显式指定 C++ 工作负载，否则装完没有 cl.exe / link.exe。
    WingetOverride { id: &'static str, extra: &'static str },
    /// 走 Windows 可选组件（DISM Add-Capability）：OpenSSH 这类系统自带组件的正道
    /// service 非空 = 装完把服务设成自动并启动；post = 装完要补跑的命令
    Capability { cap: &'static str, service: &'static str, post: &'static [&'static str] },
    /// 把调试器接口绑定到 Windows 自带的 WinUSB 驱动：
    /// 生成 INF + 自签名目录 → pnputil 安装。厂商安装包要登录/直链被墙时的通用做法，
    /// 也是 OpenOCD / pyOCD / probe-rs 在 Windows 上认探针所需要的。
    WinUsb { hwids: &'static [&'static str], label: &'static str },
    /// DSView 解码引擎：夜间版 sigrok-cli + DSView 自带的 Python 解码器
    /// （只改注册元数据和 matched 适配，解码状态机原样保留）。
    DsView,
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
        id: "jlink_probe",
        name: "SEGGER J-Link / J-Link OB 探针",
        kind_cn: "调试器",
        desc: "当前接入的 J-Link / J-Link OB 调试探针（USB VID 1366）。J-Link OB 常见于开发板板载调试器，可能同时提供 JLink CDC UART 串口。",
        url: "https://www.segger.com/products/debug-probes/j-link/",
        required: false,
        min_version: None,
        size_mb: 0.0,
        rules: &[device("J-Link driver"), device("JLink CDC")],
        plan: Plan::Manual,
    },
    Item {
        id: "cmsis_dap_probe",
        name: "CMSIS-DAP / DAPLink 调试探针",
        kind_cn: "调试器",
        desc: "通过 pyOCD 动态枚举任意厂商的 CMSIS-DAP / DAPLink 探针；型号、唯一 ID 和可选 CDC 串口都从实际设备读取，不绑定 VID/PID。",
        url: "https://pyocd.io/",
        required: false,
        min_version: None,
        size_mb: 0.0,
        rules: &[pyocd_probe(), device("CMSIS-DAP"), device("DAPLink")],
        plan: Plan::Manual,
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
        id: "dslogic_driver",
        name: "DSLogic 逻辑分析仪驱动",
        kind_cn: "USB 驱动",
        desc: "梦源 DSLogic 系列（VID 2A0E）的 WinUSB 绑定，sigrok / KDock 采集走它。插着分析仪时一键安装，会弹一次 UAC。",
        url: "https://sigrok.org/wiki/DreamSourceLab_DSLogic",
        required: false,
        min_version: None,
        size_mb: 0.1,
        rules: &[
            inf("kdock_dslogic.inf"),
            device("DSLogic"),
            device("VID_2A0E&PID_0020"),
        ],
        plan: Plan::WinUsb {
            label: "DreamSourceLab DSLogic",
            hwids: &[
                "USB\\VID_2A0E&PID_0020",
                "USB\\VID_2A0E&PID_0001",
                "USB\\VID_2A0E&PID_0003",
                "USB\\VID_2A0E&PID_0021",
                "USB\\VID_2A0E&PID_0029",
                "USB\\VID_2A0E&PID_002A",
            ],
        },
    },
    Item {
        id: "dsview_engine",
        name: "DSView 解码引擎",
        kind_cn: "逻辑分析仪",
        desc: "夜间版 sigrok-cli + DSView 自带解码器。只在 DSLogic 设备上使用，24M 那台继续走原来的 sigrok 路径。",
        url: "https://github.com/DreamSourceLab/DSView",
        required: false,
        min_version: None,
        size_mb: 40.0,
        rules: &[exe("sigrok-cli.exe", "%ENVDIR%\\dsview\\sigrok", "--version", "")],
        plan: Plan::DsView,
    },
    Item {
        id: "usbpcap",
        name: "USBPcap（USB 抓包驱动 + 命令行）",
        kind_cn: "USB 驱动",
        desc: "开源的 USB 抓包过滤驱动：被动抓取所有设备的控制/批量/中断传输，不干扰原有逻辑。驱动 GPLv2、命令行工具 BSD-2-Clause；KDock 只调用你安装的组件，不打包、不链接它的代码。装完需要重启一次。",
        url: "https://github.com/desowin/usbpcap",
        required: false,
        min_version: Some("1.5"),
        size_mb: 1.0,
        rules: &[
            exe("USBPcapCMD.exe", "C:\\Program Files\\USBPcap;C:\\Program Files (x86)\\USBPcap", "", ""),
            // 安装器写入的卸载项。它用于命令行路径被改掉或文件暂时缺失时仍能正确
            // 认出“USBPcap 已经安装过”，避免再次运行安装器卡在 already-installed。
            reg("HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\USBPcap", "DisplayVersion"),
        ],
        plan: Plan::Download {
            url: "https://github.com/desowin/usbpcap/releases/download/1.5.4.0/USBPcapSetup-1.5.4.0.exe",
            file: "USBPcapSetup-1.5.4.0.exe",
            args: "/S",
            elevated: true,
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
        desc: "ST-Link / V2-1 / V3 调试器的 WinUSB 驱动，OpenOCD、pyOCD、probe-rs 都靠它认探针。一键安装会弹一次 UAC。",
        url: "https://www.st.com/en/development-tools/stsw-link009.html",
        required: false,
        min_version: None,
        size_mb: 1.0,
        rules: &[
            inf("stlink_dbg_winusb.inf"),
            inf("stlink_bridge_winusb.inf"),
            device("STM32 STLink"),
            device("ST-Link"),
            device("VID_0483&PID_3748"),
        ],
        plan: Plan::WinUsb {
            label: "ST-Link Debug",
            hwids: &[
                "USB\\VID_0483&PID_3748",
                "USB\\VID_0483&PID_3744",
                "USB\\VID_0483&PID_374B&MI_00",
                "USB\\VID_0483&PID_374E&MI_00",
                "USB\\VID_0483&PID_374F&MI_00",
                "USB\\VID_0483&PID_3752&MI_00",
                "USB\\VID_0483&PID_3753&MI_00",
                "USB\\VID_0483&PID_3754&MI_00",
                "USB\\VID_0483&PID_3757&MI_00",
            ],
        },
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
    Item {
        id: "infineon_das",
        name: "Infineon TriBoard / DAS JDS",
        kind_cn: "调试器",
        desc: "AURIX TC3xx TriBoard 的板载 DAS JDS 调试口与串口。识别到后会同时出现 Infineon DAS JDS Debug 和 Infineon DAS JDS COM。",
        url: "https://www.infineon.com/design-resources/platforms/aurix-software-tools/aurix-tools/tas",
        required: false,
        min_version: None,
        size_mb: 40.0,
        rules: &[device("Infineon DAS JDS")],
        plan: Plan::Manual,
    },
    // ── 调试探针 ──
    Item {
        id: "wchlink",
        name: "WCH-Link / WCH-LinkE 驱动",
        kind_cn: "调试器",
        desc: "沁恒 WCH-Link / WCH-LinkE 的 CMSIS-DAP 调试接口。只绑定 MI_00，串口（MI_01）保持系统自带驱动可用。",
        url: "https://www.wch.cn/downloads/WCH-LinkUtility_ZIP.html",
        required: false,
        min_version: None,
        size_mb: 5.0,
        rules: &[
            inf("wchlink.inf"),
            inf("wchlinke.inf"),
            device("WCH CMSIS-DAP"),
        ],
        plan: Plan::WinUsb {
            label: "WCH CMSIS-DAP",
            hwids: &[
                "USB\\VID_1A86&PID_8012&MI_00",
                "USB\\VID_1A86&PID_8010&MI_00",
            ],
        },
    },
    Item {
        id: "wlink",
        name: "wlink（WCH-Link 命令行烧录）",
        kind_cn: "调试器",
        desc: "沁恒 CH32V / CH57x / CH58x / CH59x 的命令行烧录器，支持 hex / elf / bin，比厂商 GUI 更适合自动化和批量烧录。",
        url: "https://github.com/ch32-rs/wlink/releases",
        required: false,
        min_version: None,
        size_mb: 1.0,
        rules: &[
            exe("wlink.exe", "%ENVDIR%\\wlink;%ENVDIR%;C:\\wlink;D:\\wlink", "--version", ""),
            glob("%ENVDIR%\\wlink\\wlink.exe", "--version", ""),
        ],
        plan: Plan::Zip {
            url: "https://github.com/ch32-rs/wlink/releases/download/v0.1.2/wlink-v0.1.2-win-x64.zip",
            strip: 1,
        },
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
        rules: &[exe("Wireshark.exe", "C:\\Program Files\\Wireshark;C:\\Program Files (x86)\\Wireshark;F:\\wireshark;D:\\wireshark;E:\\wireshark", "", "")],
        plan: Plan::Winget { id: "WiresharkFoundation.Wireshark" },
    },
    Item {
        id: "tshark",
        name: "tshark（Wireshark 命令行 + Npcap）",
        kind_cn: "网络",
        desc: "Wireshark 自带的命令行抓包工具，KDock 的「监听 → 网络」用它。安装包同时带 Npcap（WinPcap 兼容驱动）。GPLv2；KDock 只调用，不打包、不链接。",
        url: "https://www.wireshark.org/download.html",
        required: false,
        min_version: Some("4.0"),
        size_mb: 90.0,
        rules: &[exe("tshark.exe", "C:\\Program Files\\Wireshark;C:\\Program Files (x86)\\Wireshark;F:\\wireshark;D:\\wireshark;E:\\wireshark", "-v", "")],
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
        name: "DAPLink / CMSIS-DAP（pyOCD）",
        kind_cn: "烧录",
        desc: "DAPLink、CMSIS-DAP、ST-Link、J-Link 的调试与烧录 CLI。装好后可运行 pyocd list 检查烧录器；DAPLink 设备通常还需要在 Windows 上正确绑定 HID/WinUSB 驱动。",
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
    // ── Rust 工具链（嵌入式 Rust：probe-rs / embassy / RTIC 都要它）──
    Item {
        id: "rustup",
        name: "Rust 工具链（rustup + cargo）",
        kind_cn: "工具链",
        desc: "Rust 编译器与包管理器。装嵌入式 Rust 时用它加目标架构（rustup target add thumbv7em-none-eabihf）。默认用 MSVC 链接器，所以 MSVC 生成工具也要装。",
        url: "https://rustup.rs/",
        required: false,
        min_version: None,
        size_mb: 500.0,
        rules: &[
            exe("cargo.exe", "", "--version", ""),
            glob("%USERPROFILE%\\.cargo\\bin\\cargo.exe", "--version", ""),
        ],
        plan: Plan::Winget { id: "Rustlang.Rustup" },
    },
    Item {
        id: "msvc_buildtools",
        name: "MSVC 生成工具（Visual Studio Build Tools 2022）",
        kind_cn: "工具链",
        desc: "微软的 C/C++ 编译器与链接器（cl.exe / link.exe）。Rust 的 MSVC 目标、部分 SDK 和 CMake 工程都要它；只装 Build Tools，不装整个 VS IDE。",
        url: "https://visualstudio.microsoft.com/downloads/",
        required: false,
        min_version: None,
        size_mb: 2500.0,
        rules: &[
            glob("*:\\Program Files*\\Microsoft Visual Studio\\2022\\*\\VC\\Tools\\MSVC\\*\\bin\\Hostx64\\x64\\cl.exe", "", ""),
            glob("*:\\Program Files*\\Microsoft Visual Studio\\2022\\*\\VC\\Tools\\MSVC\\*\\bin\\Hostx86\\x64\\cl.exe", "", ""),
        ],
        // 必须显式带 VCTools 工作负载，否则装完只有空壳、没有 cl.exe
        plan: Plan::WingetOverride {
            id: "Microsoft.VisualStudio.2022.BuildTools",
            extra: "--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended",
        },
    },
    Item {
        id: "probe_rs",
        name: "probe-rs（嵌入式 Rust 烧录 / 调试）",
        kind_cn: "烧录",
        desc: "Rust 生态的通用烧录与调试器：一条命令烧 .elf、开 RTT 日志、起 GDB Server。支持 CMSIS-DAP / J-Link / ST-Link / ESP32 等。用 cargo install 装（需要先装 Rust）。",
        url: "https://probe.rs/",
        required: false,
        min_version: None,
        size_mb: 80.0,
        rules: &[
            exe("probe-rs.exe", "", "--version", ""),
            glob("%USERPROFILE%\\.cargo\\bin\\probe-rs.exe", "--version", ""),
        ],
        plan: Plan::Cargo { package: "probe-rs-tools" },
    },
    // ── 嵌入式 GUI（LVGL / emWin / TouchGFX / GUI Guider）──
    Item {
        id: "lvgl",
        name: "LVGL（含 Windows 模拟器工程）",
        kind_cn: "GUI",
        desc: "开源嵌入式图形库，配 lv_port_win_visual_studio 能在 Windows 上直接跑模拟器调界面，不用先上板。装完到安装目录打开 LvglWindowsSimulator，用 Visual Studio 编译（需要 MSVC 生成工具）。",
        url: "https://lvgl.io/",
        required: false,
        min_version: None,
        size_mb: 60.0,
        rules: &[
            glob("%ENVDIR%\\lvgl\\*.sln", "", ""),
            glob("%ENVDIR%\\lvgl\\*.slnx", "", ""),
            glob("%ENVDIR%\\lvgl\\LvglPlatform\\lvgl\\lvgl.h", "", ""),
        ],
        plan: Plan::GitSub { repo: "https://github.com/lvgl/lv_port_win_visual_studio.git" },
    },
    Item {
        id: "squareline",
        name: "SquareLine Studio（LVGL 可视化设计器）",
        kind_cn: "GUI",
        desc: "LVGL 官方向导式拖拽设计器：画好界面直接导出 C 代码。个人试用免费，但下载要注册账号，所以这里只给官网入口。",
        url: "https://squareline.io/downloads",
        required: false,
        min_version: None,
        size_mb: 200.0,
        rules: &[
            glob("*:\\Program Files\\SquareLine Studio*\\SquareLine Studio.exe", "", ""),
            glob("*:\\Users\\*\\AppData\\Local\\Programs\\SquareLine Studio*\\SquareLine Studio.exe", "", ""),
            glob("*:\\Users\\*\\AppData\\Local\\squareline*\\SquareLine Studio.exe", "", ""),
        ],
        plan: Plan::Manual,
    },
    Item {
        id: "appwizard",
        name: "SEGGER AppWizard（emWin 界面设计器）",
        kind_cn: "GUI",
        desc: "SEGGER emWin 的官方可视化设计器，生成 emWin 代码。试用版免费但要填表下载，官网入口在这里。",
        url: "https://www.segger.com/products/user-interface/emwin/",
        required: false,
        min_version: None,
        size_mb: 300.0,
        rules: &[
            glob("*:\\Program Files\\SEGGER\\AppWizard*\\AppWizard.exe", "", ""),
            glob("*:\\Program Files (x86)\\SEGGER\\AppWizard*\\AppWizard.exe", "", ""),
            glob("*:\\Program Files\\SEGGER\\emWin*\\AppWizard.exe", "", ""),
        ],
        plan: Plan::Manual,
    },
    Item {
        id: "touchgfx",
        name: "TouchGFX Designer（ST 图形框架）",
        kind_cn: "GUI",
        desc: "ST 的 MCU 图形框架与设计器，配 STM32 + LTDC / Chrom-ART 用。随 STM32CubeMX 或 X-CUBE-TOUCHGFX 包分发，要先有 ST 账号。",
        url: "https://www.st.com/en/development-tools/touchgfxdesigner.html",
        required: false,
        min_version: None,
        size_mb: 400.0,
        rules: &[
            glob("*:\\Program Files\\TouchGFX*\\TouchGFX Designer.exe", "", ""),
            glob("*:\\ST\\*TouchGFX*\\TouchGFX Designer.exe", "", ""),
            glob("*:\\Users\\*\\STM32Cube\\*TouchGFX*\\TouchGFX Designer.exe", "", ""),
        ],
        plan: Plan::Manual,
    },
    Item {
        id: "gui_guider",
        name: "NXP GUI Guider（LVGL 设计器）",
        kind_cn: "GUI",
        desc: "NXP 免费提供的 LVGL 图形界面设计器，支持多家芯片（不只 NXP）。导出 LVGL 代码，带模拟器预览。下载需要 NXP 账号。",
        url: "https://www.nxp.com/design/design-center/software/development-software/gui-guider:GUI-GUIDER",
        required: false,
        min_version: None,
        size_mb: 600.0,
        rules: &[
            glob("*:\\NXP\\GUI Guider*\\GUI Guider.exe", "", ""),
            glob("*:\\Program Files\\NXP\\GUI Guider*\\GUI Guider.exe", "", ""),
            glob("*:\\Users\\*\\AppData\\Local\\Programs\\GUI Guider*\\GUI Guider.exe", "", ""),
        ],
        plan: Plan::Manual,
    },
    // ── MQTT / 物联网协议 ──
    Item {
        id: "mosquitto",
        name: "Eclipse Mosquitto（MQTT Broker）",
        kind_cn: "MQTT",
        desc: "最常用的开源 MQTT broker：本机起一个就能让设备连上来联调，不用连公网服务器。装完到服务里启动 mosquitto。",
        url: "https://mosquitto.org/download/",
        required: false,
        min_version: None,
        size_mb: 15.0,
        rules: &[
            exe("mosquitto.exe", "C:\\Program Files\\mosquitto;F:\\ENV;D:\\ENV", "-h", ""),
            glob("*:\\Program Files\\mosquitto\\mosquitto.exe", "-h", ""),
        ],
        plan: Plan::Winget { id: "EclipseFoundation.Mosquitto" },
    },
    Item {
        id: "mqttx",
        name: "MQTTX（MQTT 5.0 客户端）",
        kind_cn: "MQTT",
        desc: "EMQ 出的 MQTT 客户端：多连接、订阅发布、看消息流、支持 MQTT 5.0 属性，调设备上报和下发很顺手。",
        url: "https://mqttx.app/",
        required: false,
        min_version: None,
        size_mb: 150.0,
        rules: &[
            glob("*:\\Users\\*\\AppData\\Local\\Programs\\MQTTX\\MQTTX.exe", "", ""),
            glob("*:\\Program Files\\MQTTX\\MQTTX.exe", "", ""),
        ],
        plan: Plan::Winget { id: "EMQ.MQTTX" },
    },
    Item {
        id: "mqtt_explorer",
        name: "MQTT Explorer（MQTT 拓扑浏览）",
        kind_cn: "MQTT",
        desc: "按主题树浏览 MQTT 上的全部消息，适合排查「设备到底发到哪个 topic 了」。比纯客户端更适合摸清别人的 broker。",
        url: "https://mqtt-explorer.com/",
        required: false,
        min_version: None,
        size_mb: 120.0,
        rules: &[
            glob("*:\\Users\\*\\AppData\\Local\\Programs\\MQTT Explorer\\MQTT Explorer.exe", "", ""),
            glob("*:\\Program Files\\MQTT Explorer\\MQTT Explorer.exe", "", ""),
        ],
        plan: Plan::Winget { id: "thomasnordquist.MQTT-Explorer" },
    },
    Item {
        id: "paho_mqtt",
        name: "paho-mqtt（Python MQTT 库）",
        kind_cn: "MQTT",
        desc: "Python 的 MQTT 客户端库，写自动化测试脚本、批量造数据时用。装完 import paho.mqtt.client 可用。",
        url: "https://pypi.org/project/paho-mqtt/",
        required: false,
        min_version: None,
        size_mb: 1.0,
        rules: &[pip("paho-mqtt")],
        plan: Plan::Pip { packages: "paho-mqtt" },
    },
    // ── CAN / CAN FD / Modbus ──
    Item {
        id: "pcan",
        name: "PEAK PCAN 驱动与工具（CAN / CAN FD）",
        kind_cn: "总线",
        desc: "PEAK-System 的 PCAN 系列驱动包：USB 转 CAN / CAN FD 适配器的驱动、PCAN-View 收发工具、PCAN-Basic API（含 CAN FD）。C++ / Python 调 PCAN-Basic 都要先装它。",
        url: "https://www.peak-system.com/Drivers.523.0.html",
        required: false,
        min_version: None,
        size_mb: 40.0,
        rules: &[
            inf("pcan_usb.inf"),
            inf("pcan_usb_fd.inf"),
            glob("*:\\Program Files\\PEAK-System\\PCAN-View\\PCAN-View.exe", "", ""),
            glob("*:\\Program Files (x86)\\PEAK-System\\PCAN-View\\PCAN-View.exe", "", ""),
        ],
        plan: Plan::Winget { id: "PEAKSystem.PEAKDrivers" },
    },
    Item {
        id: "cangaroo",
        name: "Cangaroo（开源 CAN / CAN FD 分析仪）",
        kind_cn: "总线",
        desc: "开源 CAN 分析工具：支持 candleLight（CANable / CANable2 这类廉价适配器）、SocketCAN，带 DBC 解析、报文时间差视图。Windows 版在 GitHub Releases，需要自己下。",
        url: "https://github.com/HubertD/cangaroo/releases",
        required: false,
        min_version: None,
        size_mb: 60.0,
        rules: &[
            glob("*:\\Program Files\\cangaroo*\\cangaroo.exe", "", ""),
            glob("%ENVDIR%\\cangaroo\\cangaroo.exe", "", ""),
        ],
        plan: Plan::Manual,
    },
    Item {
        id: "python_can",
        name: "python-can + cantools（CAN 脚本与 DBC 解析）",
        kind_cn: "总线",
        desc: "python-can 提供统一接口（PCAN / Vector / SocketCAN / SLCAN 都能接），cantools 解析 .dbc 报文定义。写 CAN / CAN FD 自动化测试最常用的两个库。",
        url: "https://pypi.org/project/python-can/",
        required: false,
        min_version: None,
        size_mb: 8.0,
        rules: &[pip("python-can"), pip("cantools")],
        plan: Plan::Pip { packages: "python-can cantools" },
    },
    Item {
        id: "modbus_tool",
        name: "ModbusTool（Modbus 主站 / 从站调试）",
        kind_cn: "总线",
        desc: "开源 Modbus 主站和从站模拟器，支持 TCP / UDP / RTU，能导入导出寄存器表。测 Modbus RTU 从机（485）和 TCP 服务端都用它。",
        url: "https://github.com/ClassicDIY/ModbusTool",
        required: false,
        min_version: None,
        size_mb: 20.0,
        rules: &[
            glob("*:\\Users\\*\\AppData\\Local\\Programs\\ModbusTool*\\ModbusTool.exe", "", ""),
            glob("*:\\Program Files\\ModbusTool*\\ModbusTool.exe", "", ""),
        ],
        plan: Plan::Winget { id: "ClassicDIY.ModbusTool" },
    },
    Item {
        id: "pymodbus",
        name: "pymodbus（Python Modbus 库）",
        kind_cn: "总线",
        desc: "Python 的 Modbus 客户端 / 服务端库，支持串口 RTU 与 TCP。做寄存器扫描、批量读写、自动化回归时用。",
        url: "https://pypi.org/project/pymodbus/",
        required: false,
        min_version: None,
        size_mb: 2.0,
        rules: &[pip("pymodbus")],
        plan: Plan::Pip { packages: "pymodbus" },
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

/// 整个 pip 环境一次取完（包名小写 → 版本）。
///
/// 为什么不逐个 `pip show`：一次扫描里有 5 个 pip 组件，每个组件还要试 3 个解释器，
/// 最坏情况是 15 次进程启动（每次 100~300ms），扫描就直接多出好几秒。
/// `pip list --format=freeze` 一次拿到全量，之后全是内存查找。
static PIP_CACHE: std::sync::Mutex<Option<std::collections::HashMap<String, String>>> =
    std::sync::Mutex::new(None);

fn pip_inventory() -> std::collections::HashMap<String, String> {
    if let Ok(g) = PIP_CACHE.lock() {
        if let Some(m) = g.as_ref() {
            return m.clone();
        }
    }
    let mut out = std::collections::HashMap::new();
    // 三种解释器都试：python（装进 PATH 的）、py -3（官方启动器）、python3
    for (prog, pre) in [("python.exe", &[][..]), ("py.exe", &["-3"][..]), ("python3.exe", &[][..])] {
        let mut args: Vec<&str> = pre.to_vec();
        args.extend(["-m", "pip", "list", "--format=freeze", "--disable-pip-version-check"]);
        let Some(t) = run_out(prog, &args) else { continue };
        // freeze 每行形如 `包名==版本`；没有 `==` 的行（警告、提示）直接跳过
        for line in t.lines() {
            if let Some((name, v)) = line.trim().split_once("==") {
                let k = name.trim().to_lowercase().replace('_', "-");
                if !k.is_empty() {
                    out.insert(k, v.trim().to_string());
                }
            }
        }
        break;   // 第一个能跑通 pip 的解释器就够了
    }
    if let Ok(mut g) = PIP_CACHE.lock() {
        *g = Some(out.clone());
    }
    out
}

/// 查一个 pip 包装没装，装了返回版本号（没装返回 None）
fn pip_show(pkg: &str) -> Option<String> {
    let key = pkg.trim().to_lowercase().replace('_', "-");
    pip_inventory().get(&key).cloned()
}

pub fn scan_one(it: &Item, infs: &str) -> Value {
    let mut path: Option<PathBuf> = None;
    let mut version: Option<String> = None;
    let mut detail = String::new();
    let mut installed = false;
    let mut warning = "";
    let mut usbpcap_driver: Option<(bool, &'static str)> = None;
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
            Kind::Device => {
                if let Some(v) = crate::usb::matching_device_detail(r.a) {
                    installed = true;
                    detail = v;
                    break;
                }
            }
            Kind::PyOcd => {
                if let Some(v) = crate::usb::cmsis_dap_detail() {
                    installed = true;
                    detail = v;
                    break;
                }
            }
            Kind::Pip => {
                // 纯库组件（python-can / cantools / pymodbus）没有自己的 exe，只能问 pip。
                // 用 `pip show` 而不是 import：import 会真的把库加载一遍（慢、还可能报错）。
                if let Some(v) = pip_show(r.a) {
                    installed = true;
                    version = Some(v.clone());
                    detail = format!("pip {}", r.a);
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
    if it.id == "usbpcap" {
        let status = crate::usbcapture::status_snapshot();
        if version.is_none() {
            version = reg_query(
                "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\USBPcap",
                "DisplayVersion",
            );
        }
        if status.command_installed {
            installed = true;
        }
        usbpcap_driver = Some((status.driver_ready, status.driver_state));
        if installed {
            let driver = match status.driver_state {
                "ready" => "驱动已加载",
                "elevation-required" => "驱动已加载（抓包时请求管理员权限）",
                "missing" => "驱动未加载",
                _ => "驱动状态未知",
            };
            if !status.driver_ready {
                warning = "驱动未加载";
            }
            detail = format!(
                "USBPcap {} · {}",
                version.as_deref().unwrap_or("已安装"),
                driver
            );
        }
    }
    let outdated = match (it.min_version, version.as_ref()) {
        (Some(min), Some(v)) => ver_cmp(v, min) == std::cmp::Ordering::Less,
        _ => false,
    };
    let mut out = json!({
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
    });
    if it.id == "usbpcap" {
        let (driver_ready, driver_state) =
            usbpcap_driver.unwrap_or((false, "unknown"));
        out["warning"] = json!(warning);
        out["driverReady"] = json!(driver_ready);
        out["driverState"] = json!(driver_state);
    }
    out
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
    // pip 包清单先一次性取好：清单里有 5 个 pip 组件，逐个 `pip show` 会重复启动进程
    // （每次 100~300ms），这里是唯一会用到它的地方，提前预热后 scan_one 里全是内存查找。
    if ITEMS.iter().any(|it| it.rules.iter().any(|r| r.kind == Kind::Pip)) {
        let _ = pip_inventory();
    }
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
pub async fn env_install(
    app: tauri::AppHandle,
    id: String,
    dir: Option<String>,
    dry: Option<bool>,
    force: Option<bool>,
) -> Result<String, String> {
    let dry = dry.unwrap_or(false);
    let it = ITEMS.iter().find(|x| x.id == id).ok_or_else(|| format!("不认识的组件：{id}"))?;
    let target = dir.unwrap_or_else(|| {
        let d = env_dir();
        if d.trim().is_empty() { default_env_dir() } else { d }
    });
    set_env_dir(&target);          // 后面的检测规则（%ENVDIR%）按这个目录找
    emit(&app, it.id, "start", 0, &format!("准备安装 {}", it.name));

    // USBPcap 的官方安装器在检测到已经安装后会重新弹安装器，甚至停在
    // “already installed”等待用户点击。先走和扫描相同的检测；已安装就只
    // 返回真实驱动状态，不再盲目重跑安装器。
    if it.id == "usbpcap" && !dry && !force.unwrap_or(false) {
        let status = crate::usbcapture::status_snapshot();
        let registered = reg_query(
            "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\USBPcap",
            "DisplayVersion",
        );
        if status.command_installed || registered.is_some() {
            emit(&app, it.id, "done", 100, "已检测到安装，跳过安装器");
            if status.driver_ready {
                return Ok(format!(
                    "USBPcap 已安装，抓包驱动已就绪（{}），无需重装。",
                    status.driver_state
                ));
            }
            return Ok(format!(
                "USBPcap 已安装（{}），本次已跳过安装器，避免卡在“已经安装”。\n\
                 但抓包控制设备仍未加载（{}）。请使用“重新启动”而不是关机后快速开机；\
                 若仍不出现，先卸载 USBPcap，再安装 1.5.4.0 并完整重启。",
                registered.unwrap_or_else(|| "版本未知".to_string()),
                status.driver_state
            ));
        }
    }

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
        Plan::GitSub { repo } => {
            // 带 submodule 的仓库：--recursive 必须**在 clone 时就给**。
            // 先普通 clone 再 submodule update 也行，但 LVGL 那个工程里 freetype 还要再嵌一层，
            // --recursive 会把嵌套的一起拉下来；--depth 1 跟 submodule 一起用会在老 git 上报错，
            // 所以这里不浅克隆（工程不大，稳比快重要）。
            let dst = Path::new(&target).join(it.id);
            if dst.join(".git").is_dir() {
                emit(&app, it.id, "install", 70, "已有仓库，执行 git pull + submodule update");
                if dry {
                    format!("（模拟）会在 {} 里跑 git pull && git submodule update --init --recursive", dst.display())
                } else {
                    let a = run_out("git.exe", &["-C", &dst.to_string_lossy(), "pull", "--ff-only"]).unwrap_or_default();
                    let b = run_out(
                        "git.exe",
                        &["-C", &dst.to_string_lossy(), "submodule", "update", "--init", "--recursive"],
                    )
                    .unwrap_or_default();
                    format!("{a}\n{b}")
                }
            } else {
                std::fs::create_dir_all(Path::new(&target)).map_err(|e| e.to_string())?;
                if dry {
                    format!("（模拟）会 git clone --recursive {} {}", repo, dst.display())
                } else {
                    emit(&app, it.id, "install", 60, "克隆仓库（含 submodule，可能要几分钟）…");
                    run_out(
                        "git.exe",
                        &["clone", "--recursive", repo, &dst.to_string_lossy()],
                    )
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
        Plan::WingetOverride { id: wid, extra } => {
            if run_out("winget.exe", &["--version"]).is_none() {
                return Ok(format!(
                    "这台机器上没有 winget（应用安装程序），装不了「{}」。请到官网下载安装：{}",
                    it.name, it.url
                ));
            }
            if dry { format!("（模拟）会跑 winget install --id {} --override \"{}\"", wid, extra) }
            else {
                // --override 会把安装器参数整串替掉，所以这里必须一次给全（含静默开关）
                run_powershell(&app, it.id, &format!(
                    "winget install --id {wid} --override \"{extra}\" --accept-package-agreements --accept-source-agreements --disable-interactivity; exit $LASTEXITCODE"
                ), false)?
            }
        }
        Plan::Pip { packages } => {
            let py = if run_out("python.exe", &["--version"]).is_some() {
                "python"
            } else if run_out("py.exe", &["-3", "--version"]).is_some() {
                "py -3"
            } else {
                return Ok(format!(
                    "没找到 Python。先装环境配置里的 Python，或到 {} 安装后重试。",
                    it.url
                ));
            };
            if dry {
                format!("（模拟）会跑 {py} -m pip install --user --upgrade {packages}")
            } else {
                run_powershell(&app, it.id, &format!(
                    "$env:NO_PROXY='*'; $env:no_proxy='*'; $env:HTTPS_PROXY=''; $env:HTTP_PROXY=''; \
                     {py} -m pip install --user --upgrade {packages}; exit $LASTEXITCODE"
                ), false)?
            }
        }
        Plan::Cargo { package } => {
            // Rust 工具链是 cargo 的来源；没有就先让用户装 Rust（清单里上一项），别去猜 rustup 直链
            if run_out("cargo.exe", &["--version"]).is_none() {
                return Ok(format!(
                    "没找到 cargo。先装「{}」，或者到 https://rustup.rs 装 Rust 工具链后重试。",
                    "Rust 工具链（rustup）"
                ));
            }
            if dry {
                format!("（模拟）会跑 cargo install --locked {package}")
            } else {
                run_powershell(&app, it.id, &format!(
                    "cargo install --locked {package}; exit $LASTEXITCODE"
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
        Plan::WinUsb { hwids, label } => {
            let dir = Path::new(&target).join(it.id);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let inf = dir.join(format!("kdock_{}.inf", it.id));
            let script = dir.join("install-winusb.ps1");
            std::fs::write(&inf, winusb_inf_text(it.id, label, hwids)).map_err(|e| e.to_string())?;
            std::fs::write(&script, WINUSB_INSTALL_PS).map_err(|e| e.to_string())?;
            emit(&app, it.id, "install", 30, "生成 WinUSB 驱动包…");
            if dry {
                format!("（模拟）会生成 {}，把 {} 绑定到 WinUSB（需要 UAC）", inf.display(), hwids.join("、"))
            } else {
                run_elevated_script(&app, it.id, &script)?
            }
        }
        Plan::DsView => {
            let root = Path::new(&target).join("dsview");
            let sigrok = root.join("sigrok");
            if dry {
                format!("（模拟）会装夜间版 sigrok-cli 到 {}，并从 DSView 安装目录复制/适配解码器", sigrok.display())
            } else {
                std::fs::create_dir_all(&sigrok).map_err(|e| e.to_string())?;
                let setup = download(
                    &app,
                    it.id,
                    "https://sigrok.org/download/binary/sigrok-cli/sigrok-cli-NIGHTLY-x86_64-release-installer.exe",
                    "sigrok-cli-nightly.exe",
                )?;
                emit(&app, it.id, "install", 55, "安装夜间版 sigrok-cli…");
                run_powershell(
                    &app,
                    it.id,
                    &format!(
                        "Start-Process -FilePath '{}' -ArgumentList '/S','/D={}' -Wait",
                        setup.display(),
                        sigrok.display()
                    ),
                    false,
                )?;
                // DSView 的解码器跟着 DSView 安装包走；优先本机已装的 DSView。
                let dec_src = [
                    "D:/DSview1.3.0/DSView/decoders",
                    "D:/DSview/DSView/decoders",
                    "C:/Program Files/DSView/decoders",
                    "C:/Program Files/DSView/DSView/decoders",
                    "C:/Program Files (x86)/DSView/decoders",
                ]
                .iter()
                .map(Path::new)
                .find(|p| p.is_dir())
                .ok_or_else(|| "没找到 DSView 的解码器目录，先安装 DSView（https://github.com/DreamSourceLab/DSView）".to_string())?;
                let dst = sigrok.join("share").join("libsigrokdecode").join("decoders");
                let script = root.join("prepare-decoders.py");
                std::fs::write(&script, include_str!("../../tools/dsview/prepare-decoders.py"))
                    .map_err(|e| e.to_string())?;
                emit(&app, it.id, "install", 75, "复制并适配 DSView 解码器…");
                let out = run_out(
                    "py.exe",
                    &["-3", &script.to_string_lossy(), &dec_src.to_string_lossy(), &dst.to_string_lossy()],
                )
                .or_else(|| {
                    run_out(
                        "python.exe",
                        &["-3", &script.to_string_lossy(), &dec_src.to_string_lossy(), &dst.to_string_lossy()],
                    )
                })
                .ok_or_else(|| "需要 Python 3 来适配 DSView 解码器（环境配置里装 Python）".to_string())?;
                // FX2 固件 + FPGA 位流：先找 DSView 安装目录里的 res，没有再按官方仓库下载。
                let fw_dir = sigrok.join("share").join("sigrok-firmware");
                std::fs::create_dir_all(&fw_dir).map_err(|e| e.to_string())?;
                let res = dec_src.parent().map(|p| p.join("res"));
                for (src, dst_name) in [
                    ("DSLogicPlus.fw", "dreamsourcelab-dslogic-plus-fx2.fw"),
                    ("DSLogicPlus.bin", "dreamsourcelab-dslogic-plus-fpga.fw"),
                ] {
                    let local = res.as_ref().map(|r| r.join(src));
                    let target_file = fw_dir.join(dst_name);
                    if let Some(p) = local.filter(|p| p.is_file()) {
                        std::fs::copy(&p, &target_file).map_err(|e| e.to_string())?;
                    } else {
                        let url = format!(
                            "https://github.com/DreamSourceLab/DSView/raw/886b847c21c606df3138ce7ad8f8e8c363ee758b/DSView/res/{src}"
                        );
                        let f = download(&app, it.id, &url, dst_name)?;
                        std::fs::copy(&f, &target_file).map_err(|e| e.to_string())?;
                    }
                }
                format!("{}\n解码器：{} → {}\n固件：{}", out.trim(), dec_src.display(), dst.display(), fw_dir.display())
            }
        }
    };
    if let Ok(mut g) = SCAN_CACHE.lock() { *g = None; }   // 装完让下次扫描重新跑
    if let Ok(mut g) = PIP_CACHE.lock() { *g = None; }    // pip 包清单也要重取（刚装完的包才会出现）
    emit(&app, it.id, "done", 100, "完成");
    Ok(log)
}

/// WinUSB 驱动包：只引用 Windows 自带的 winusb.inf，不携带第三方 .sys。
/// 因此自签名目录 + 本机受信任证书就足够，不依赖厂商安装包和联网下载。
fn winusb_inf_text(id: &str, label: &str, hwids: &[&str]) -> String {
    let mut t = format!(
        "[Version]\r\n\
         Signature=\"$Windows NT$\"\r\n\
         Class=USBDevice\r\n\
         ClassGuid={{88BAE032-5A81-49f0-BC3D-A4FF138216D6}}\r\n\
         Provider=%ProviderName%\r\n\
         CatalogFile=kdock_{id}.cat\r\n\
         DriverVer=10/20/2026,1.0.0.0\r\n\r\n\
         [Manufacturer]\r\n\
         %ProviderName%=KdockDevices,NTamd64\r\n\r\n\
         [KdockDevices.NTamd64]\r\n"
    );
    for h in hwids {
        t.push_str(&format!("%DeviceDesc%=WinUSB_Install, {h}\r\n"));
    }
    t.push_str(
        "\r\n[WinUSB_Install]\r\n\
         Include=winusb.inf\r\n\
         Needs=WINUSB.NT\r\n\r\n\
         [WinUSB_Install.Services]\r\n\
         Include=winusb.inf\r\n\
         Needs=WINUSB.NT.Services\r\n\r\n\
         [WinUSB_Install.HW]\r\n\
         AddReg=WinUSB_AddReg\r\n\r\n\
         [WinUSB_AddReg]\r\n\
         HKR,,DeviceInterfaceGUIDs,0x10000,\"{8C3B9E11-6D77-4B0A-9D4E-5F2A1C7E9B31}\"\r\n\r\n\
         [Strings]\r\n\
         ProviderName=\"KDock\"\r\n",
    );
    t.push_str(&format!("DeviceDesc=\"{label} (WinUSB)\"\r\n"));
    t
}

/// 提权跑一个 .ps1。用 -File 而不是把脚本内容塞进 -Command，路径里有空格/中文也不会散架。
fn run_elevated_script(app: &tauri::AppHandle, id: &str, script: &Path) -> Result<String, String> {
    emit(app, id, "install", 55, "等待 UAC 授权…");
    let path = script.to_string_lossy().replace('\'', "''");
    let ps = format!(
        "$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru \
         -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"{path}\"'; \
         Write-Output ('elevated-exit=' + $p.ExitCode)"
    );
    let out = run_out("powershell.exe", &["-NoProfile", "-Command", &ps])
        .ok_or_else(|| "没能启动提权进程（UAC 被拒绝？）".to_string())?;
    let tail: String = out.chars().rev().take(6000).collect::<String>().chars().rev().collect();
    if !tail.contains("elevated-exit=0") || tail.contains("Catalog signature: Invalid") {
        return Err(format!("驱动安装失败（需要确认 UAC）：\n{tail}"));
    }
    emit(app, id, "install", 95, "驱动已安装，正在重新枚举设备…");
    Ok(tail)
}

const WINUSB_INSTALL_PS: &str = r#"$ErrorActionPreference = 'Stop'
$inf = Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'kdock_*.inf' | Select-Object -First 1
if (-not $inf) { Write-Output 'no-inf'; exit 2 }
$cat = [IO.Path]::ChangeExtension($inf.FullName, '.cat')
$cer = Join-Path $PSScriptRoot 'kdock-winusb.cer'
$cert = Get-ChildItem Cert:\LocalMachine\My |
    Where-Object { $_.Subject -eq 'CN=KDock WinUSB Driver' } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $cert) {
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=KDock WinUSB Driver' `
        -CertStoreLocation Cert:\LocalMachine\My -HashAlgorithm SHA256 `
        -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(10)
}
Export-Certificate -Cert $cert -FilePath $cer -Force | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher | Out-Null
if (Test-Path -LiteralPath $cat) { Remove-Item -LiteralPath $cat -Force }
New-FileCatalog -Path $PSScriptRoot -CatalogFilePath $cat -CatalogVersion 2 | Out-Null
$sig = Set-AuthenticodeSignature -FilePath $cat -Certificate $cert -HashAlgorithm SHA256
Write-Output ("Catalog signature: " + $sig.Status)
& pnputil.exe /add-driver $inf.FullName /install
Write-Output ("pnputil=" + $LASTEXITCODE)
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& pnputil.exe /scan-devices
"#;

#[cfg(test)]
mod tests {
    use super::*;

    /// 清单是手写的长数组，最容易犯的错是复制粘贴留下重复 id（装的时候按 id 查，重复就永远命中最前面那条）。
    /// 顺手把几个"性质"也钉住：每条至少一个检测规则、pip 规则必须有包名。
    #[test]
    fn item_ids_are_unique_and_every_item_is_scannable() {
        let mut seen = std::collections::HashSet::new();
        for it in ITEMS {
            assert!(seen.insert(it.id), "重复的组件 id：{}", it.id);
            assert!(!it.name.trim().is_empty(), "{} 没有名字", it.id);
            assert!(!it.desc.trim().is_empty(), "{} 没有说明", it.id);
            assert!(!it.rules.is_empty(), "{} 没有任何检测规则", it.id);
            for r in it.rules {
                if r.kind == Kind::Pip {
                    assert!(!r.a.trim().is_empty(), "{} 的 pip 规则缺包名", it.id);
                }
            }
            // 有自动安装方式的才能"一键装"；Manual 的卡片上只给官网
            if matches!(it.plan, Plan::Manual) {
                assert!(!it.url.trim().is_empty(), "{} 只能手动装，必须给官网地址", it.id);
            }
        }
    }

    #[test]
    fn winusb_inf_binds_each_probe_interface() {
        let t = winusb_inf_text(
            "wchlink",
            "WCH CMSIS-DAP",
            &["USB\\VID_1A86&PID_8012&MI_00", "USB\\VID_1A86&PID_8010&MI_00"],
        );
        assert!(t.contains("CatalogFile=kdock_wchlink.cat"));
        assert!(t.contains("%DeviceDesc%=WinUSB_Install, USB\\VID_1A86&PID_8012&MI_00"));
        assert!(t.contains("%DeviceDesc%=WinUSB_Install, USB\\VID_1A86&PID_8010&MI_00"));
        assert!(t.contains("Include=winusb.inf"));
        assert!(t.contains("Needs=WINUSB.NT.Services"));
        // 复合设备的父节点不能绑：绑了会把同设备的串口一起吞掉
        assert!(!t.contains("%DeviceDesc%=WinUSB_Install, USB\\VID_1A86&PID_8012\r\n"));
    }

    #[test]
    fn stlink_plan_is_one_click_and_covers_common_pids() {
        let it = ITEMS.iter().find(|x| x.id == "stlink").expect("stlink item");
        match it.plan {
            Plan::WinUsb { hwids, .. } => {
                assert!(hwids.iter().any(|h| h.contains("PID_3748")));
                assert!(hwids.iter().any(|h| h.contains("PID_374B&MI_00")));
            }
            _ => panic!("ST-Link should install through WinUSB without a vendor download"),
        }
    }

    #[test]
    #[ignore = "requires a connected Infineon DAS JDS TriBoard"]
    fn infineon_triboard_is_detected_with_its_com_port() {
        let item = ITEMS
            .iter()
            .find(|it| it.id == "infineon_das")
            .expect("infineon_das item");
        let got = scan_one(item, "");
        assert_eq!(got["installed"], json!(true), "{}", got["detail"]);
        assert!(
            got["detail"].as_str().unwrap_or("").contains("COM"),
            "detail should include the DAS JDS COM port: {}",
            got["detail"]
        );
    }

    #[test]
    #[ignore = "requires a connected SEGGER J-Link / J-Link OB"]
    fn jlink_probe_is_detected_with_its_com_port() {
        let item = ITEMS
            .iter()
            .find(|it| it.id == "jlink_probe")
            .expect("jlink_probe item");
        let got = scan_one(item, "");
        assert_eq!(got["installed"], json!(true), "{}", got["detail"]);
        assert!(
            got["detail"].as_str().unwrap_or("").contains("COM"),
            "detail should include the J-Link CDC COM port: {}",
            got["detail"]
        );
        assert!(
            got["detail"].as_str().unwrap_or("").contains("J-Link-OB-RA4M2-Full"),
            "detail should include the probe product name: {}",
            got["detail"]
        );
    }

    #[test]
    #[ignore = "requires a connected CMSIS-DAP probe"]
    fn cmsis_dap_probe_is_detected() {
        let item = ITEMS
            .iter()
            .find(|it| it.id == "cmsis_dap_probe")
            .expect("cmsis_dap_probe item");
        let got = scan_one(item, "");
        assert_eq!(got["installed"], json!(true), "{}", got["detail"]);
    }

    /// pip 类组件的检测走的是「一次 pip list 全量拿，再内存查」，这里验证那条链路真的通。
    #[test]
    #[ignore = "manual: needs Python with pip on this machine"]
    fn pip_inventory_finds_installed_packages() {
        let inv = pip_inventory();
        assert!(inv.len() > 5, "pip 清单应当有内容，实际 {} 条", inv.len());
        assert!(
            pip_show("pip").is_some(),
            "pip 自己一定在清单里（扫描链路可能没走通）"
        );
        assert!(pip_show("definitely-not-a-real-package-xyz").is_none());
    }
}

