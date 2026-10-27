# KDock 便携固件分析器

这个目录是 **KDock 生成的便携分析器**，不是需要用户手工配置的 Python 环境。

正式包、便携 ZIP 和通过“环境配置 → 固件运行结构分析器 → 准备 / 更新”生成的
目录结构相同：

```text
bingraph/
├─ python/
│  └─ python.exe              Python 3.13.13 embeddable
├─ site-packages/             锁定的 78 个 Python distributions（含 pybingraph）
├─ launcher/                  KDock 的兼容启动器与 JSON 路由
├─ run.py                     稳定入口
├─ VERSION.json               构建版本
├─ THIRD_PARTY_NOTICES.md     完整第三方许可清单
├─ licenses/                  Python 与各依赖的许可证副本
└─ README.md                  本文件
```

## 用户无需安装

- 不需要系统 Python；
- 不需要 `uv`；
- 不需要 Graphviz；
- 不需要把分析器加入 PATH。

KDock 只启动本目录里的 `python\python.exe`，随机选择 `127.0.0.1` 上的空闲端口，
分析结束或退出时自动回收进程树。

## 支持的分析范围

- **全固件函数**：列出 `CFGFast` 能识别的所有函数和调用边，不要求从 `main` 可达；
- **main 运行链**：从 `main` 展开，并单独挂载向量表中的中断处理函数；
- **单函数 CFG**：在画布上点选函数后查看基本块、地址和指令数。

ELF/PE 通常能直接读到函数符号。裸机 BIN 必须提供加载基址、架构，必要时还要
提供入口和向量表基址；无符号 BIN 的函数名会是 `sub_xxxx`。

## 重建

从 KDock 源码根目录执行：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File tools/bingraph/build-portable.ps1 -NoGraphviz
```

构建脚本优先用 `uv`；没有 `uv` 时会下载官方 `get-pip.py` 引导 pip，再按
`tools/bingraph/requirements.txt` 安装锁定版本。构建约需下载 500 MB，完成后写入
`resources/bingraph`。

## 许可证

KDock 本身采用 Apache-2.0。分析器的 Python、pybingraph、angr 及其他依赖各自按
上游许可证提供；完整清单见 `THIRD_PARTY_NOTICES.md`，原始许可证见 `licenses/`
和 `site-packages/*.dist-info/licenses/`。Graphviz 默认不打包，运行结构 JSON 不需要它。
