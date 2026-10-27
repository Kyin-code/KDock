# KDock 便携固件分析器第三方声明

> 适用产物：`resources/bingraph`、便携 ZIP 中的 `resources/bingraph`，以及环境配置页
> “准备 / 更新分析器”在应用数据目录组装出的同一套目录。
>
> 本文件是 [KDock NOTICE](../../NOTICE) 的补充，不替代各上游软件包内的许可证原文。
> 完整许可证文件随分析器一起分发，位于 `site-packages/*.dist-info/licenses/` 与
> `licenses/`。

## 1. 发行边界

KDock 自身采用 Apache-2.0。便携固件分析器是**独立子进程**，通过仅监听
`127.0.0.1` 的 HTTP JSON 接口与 KDock 通信。KDock 不把 Python、angr、pybingraph
或其依赖静态链接进 `KDock.exe`，也不修改上游 `site-packages` 中的代码。

分析器包包含：

- Python 3.13.13 官方 Windows embeddable runtime，许可为 PSF-2.0；
- `pybingraph 0.2.5`，许可为 BSD-2-Clause；
- `angr 10.0.4` 及其锁定依赖，共 77 个 Python distributions；
- KDock 自己的 `bingraph_native` 启动器与 JSON 路由代码；
- 可选的 Cytoscape.js 静态文件（上游页面的离线依赖），MIT。

默认不打包 Graphviz。KDock 的运行结构页面只消费 JSON，不调用 `dot`；即使
构建时显式传入 `-GraphvizBin`，它也只作为独立程序存在，不改变 KDock 自身许可。

## 2. 关键组件与义务

### Python 3.13.13

- 项目：<https://www.python.org/>
- 版本：`3.13.13`
- 许可：Python Software Foundation License 2.0（PSF-2.0）
- 用途：运行便携分析器
- 许可证原文：`python/LICENSE.txt`，并在 `licenses/PYTHON-3.13-LICENSE.txt` 再保留一份

### pybingraph 0.2.5

- 项目：<https://github.com/manelfx/pybingraph>
- 许可：BSD-2-Clause
- Copyright (c) 2026 Manel Fernandez
- 用途：ELF/PE 加载、函数符号、CFG、调用图和 FastAPI 服务
- 许可证原文：`site-packages/pybingraph-0.2.5.dist-info/licenses/LICENSE`
- 上游额外声明：同目录 `NOTICE`，说明 bingraphvis、angr-utils 与 angr 的适配来源

### angr 10.0.4 / CLE / PyVEX / archinfo / pypcode

- 项目：<https://angr.io/>
- 许可：各包以自身元数据为准；angr、CLE、archinfo 为 BSD-2-Clause
- PyVEX 元数据为 `BSD-2-Clause AND GPL-2.0-or-later`
- pypcode 元数据为 `BSD-2-Clause AND Apache-2.0 AND Zlib`
- 用途：二进制加载、CFG 恢复、反汇编、基本块和跨架构分析
- 许可证原文：各自的 `site-packages/*.dist-info/licenses/`

**LibVEX / GPL 边界**：`pyvex` 的 `vex/LICENSE.README` 明确说明其内置 LibVEX
按 GPL-3.0-or-later 分发，对应 `vex/LICENSE.GPL` 随包保留。KDock 不修改 LibVEX，
也不把它静态链接进 KDock 主程序；它只存在于独立分析器子进程中。重新分发便携包时，
必须保留这些许可证和版权声明，并遵守 GPL 对 LibVEX 及其衍生作品的要求。
KDock 自身代码不因调用独立进程而被重新许可为 GPL。

### Cytoscape.js 3.33.1

- 项目：<https://js.cytoscape.org/>
- 许可：MIT
- Copyright (c) 2016-2025, The Cytoscape Consortium
- 用途：上游 pybingraph 离线页面的图形渲染；KDock 原生页面不依赖它
- 许可证原文：`launcher/bingraph_native/static/cytoscape.min.js` 文件头

### Graphviz

- 项目：<https://graphviz.org/>
- 许可：EPL-1.0（具体发行版还可能包含其他组件，以安装目录为准）
- 默认状态：**不打包**。运行结构 JSON、KDock 原生画布、自动整理和 CFG 详情都不需要 Graphviz
- 如构建者主动用 `-GraphvizBin` 打包，必须自行保留 Graphviz 的许可证文件并满足 EPL 要求

## 3. 77 项锁定 Python 依赖

下表由实际构建出的 Python 3.13.13 便携环境读取 `importlib.metadata` 生成，版本与
`tools/bingraph/requirements.txt` 一致。许可证栏来自包元数据；写着
“See bundled license”的包需要直接查看对应 `dist-info` 中的文件。

| 包 | 版本 | 元数据许可 | 项目地址 |
| --- | --- | --- | --- |
| angr | 10.0.4 | BSD-2-Clause | https://angr.io/ |
| angr-data | 0.2.0 | BSD-2-Clause | https://angr.io/ |
| annotated-doc | 0.0.5 | MIT | https://github.com/fastapi/annotated-doc |
| annotated-types | 0.8.0 | MIT | https://github.com/annotated-types/annotated-types |
| anyio | 4.15.1 | MIT | https://github.com/agronholm/anyio |
| archinfo | 10.0.4 | BSD-2-Clause | https://api.angr.io/projects/archinfo/en/latest/ |
| arpy | 1.1.1 | Simplified BSD | https://github.com/viraptor/arpy |
| bitarray | 3.12.3 | PSF-2.0 | https://github.com/ilanschnell/bitarray |
| bitstring | 4.4.0 | MIT | https://github.com/scott-griffiths/bitstring |
| cachetools | 7.2.5 | MIT | https://github.com/tkem/cachetools/ |
| capstone | 5.0.9 | BSD-3-Clause | https://www.capstone-engine.org |
| cart | 1.2.3 | MIT | https://github.com/CybercentreCanada/cart |
| cffi | 2.1.1 | MIT-0 | https://github.com/python-cffi/cffi |
| cle | 10.0.4 | BSD-2-Clause | https://api.angr.io/projects/cle/en/latest/ |
| click | 8.5.0 | BSD-3-Clause | https://github.com/pallets/click/ |
| colorama | 0.4.6 | See bundled license | https://github.com/tartley/colorama |
| cxxfilt | 0.3.0 | BSD | https://github.com/afq984/python-cxxfilt |
| cxxheaderparser | 2.2.0 | BSD-3-Clause | https://github.com/robotpy/cxxheaderparser |
| fastapi | 0.162.0 | MIT | https://github.com/fastapi/fastapi |
| future | 1.0.0 | MIT | https://python-future.org |
| gitdb | 4.0.12 | BSD License | https://github.com/gitpython-developers/gitdb |
| GitPython | 3.2.1 | BSD-3-Clause | https://github.com/gitpython-developers/GitPython |
| graphviz | 0.21 | MIT | https://github.com/xflr6/graphviz |
| h11 | 0.16.0 | MIT | https://github.com/python-hyper/h11 |
| httpcore2 | 2.16.0 | BSD-3-Clause | https://github.com/pydantic/httpx2 |
| httptools | 0.9.0 | MIT | https://github.com/MagicStack/httptools |
| httpx2 | 2.16.0 | BSD-3-Clause | https://github.com/pydantic/httpx2 |
| idna | 3.20 | BSD-3-Clause | https://github.com/kjd/idna |
| Jinja2 | 3.1.6 | See bundled license | https://github.com/pallets/jinja/ |
| lmdb | 3.0.0 | OLDAP-2.8 | http://github.com/jnwatson/py-lmdb/ |
| loguru | 0.7.3 | See bundled license | https://github.com/Delgan/loguru |
| markdown-it-py | 4.2.0 | See bundled license | https://github.com/executablebooks/markdown-it-py |
| MarkupSafe | 3.0.4 | BSD-3-Clause | https://github.com/pallets/markupsafe/ |
| mdurl | 0.1.2 | See bundled license | https://github.com/executablebooks/mdurl |
| minidump | 0.0.24 | See bundled license | https://github.com/skelsec/minidump |
| mpmath | 1.3.0 | BSD | http://mpmath.org/ |
| msgspec | 0.22.0 | BSD-3-Clause | https://msgspec.dev |
| mulpyplexer | 0.9 | BSD | — |
| networkx | 3.7 | BSD-3-Clause | https://networkx.org/ |
| opentelemetry-api | 1.45.1 | Apache-2.0 | https://github.com/open-telemetry/opentelemetry-python/tree/main/opentelemetry-api |
| pefile | 2024.8.26 | MIT | https://github.com/erocarrera/pefile |
| platformdirs | 4.13.5 | MIT | https://github.com/tox-dev/platformdirs |
| protobuf | 7.36.2 | 3-Clause BSD License | https://developers.google.com/protocol-buffers/ |
| psutil | 7.2.2 | BSD-3-Clause | https://github.com/giampaolo/psutil |
| pybingraph | 0.2.5 | BSD-2-Clause | https://github.com/manelfx/pybingraph |
| pycparser | 3.11 | BSD-3-Clause | https://github.com/eliben/pycparser |
| pycryptodome | 4.2.0 | BSD-2-Clause AND Unlicense AND MIT | https://www.pycryptodome.org |
| pydantic | 2.14.1 | MIT | https://github.com/pydantic/pydantic |
| pydantic-settings | 2.16.1 | MIT | https://github.com/pydantic/pydantic-settings |
| pydantic_core | 2.50.1 | MIT | https://github.com/pydantic/pydantic |
| pydemumble | 0.1.3 | See bundled license | https://github.com/angr/pydemumble |
| pydot | 4.0.1 | MIT | https://github.com/pydot/pydot |
| pyelftools | 0.33 | Public domain | https://github.com/eliben/pyelftools |
| Pygments | 2.21.0 | BSD-2-Clause | https://pygments.org |
| pyparsing | 3.3.3 | MIT | https://github.com/pyparsing/pyparsing/ |
| pypcode | 4.0.1 | BSD-2-Clause AND Apache-2.0 AND Zlib | https://api.angr.io/projects/pypcode/en/latest/ |
| python-dotenv | 1.2.4 | BSD-3-Clause | https://github.com/theskumar/python-dotenv |
| pyvex | 10.0.4 | BSD-2-Clause AND GPL-2.0-or-later | https://api.angr.io/projects/pyvex/en/latest/ |
| pyxbe | 1.0.4 | MIT | https://github.com/mborgerson/pyxbe |
| pyxdia | 0.1.1 | See bundled license | https://github.com/mborgerson/xdia |
| PyYAML | 6.0.3 | MIT | https://pyyaml.org/ |
| rich | 15.0.0 | MIT | https://github.com/Textualize/rich |
| smmap | 5.0.3 | BSD-3-Clause | https://github.com/gitpython-developers/smmap |
| sortedcontainers | 2.4.0 | Apache 2.0 | http://www.grantjenks.com/docs/sortedcontainers/ |
| starlette | 1.10.0 | BSD-3-Clause | https://github.com/Kludex/starlette |
| sympy | 1.14.0 | BSD | https://sympy.org |
| tibs | 0.5.7 | See bundled license | https://github.com/scott-griffiths/tibs |
| truststore | 0.10.5 | MIT | https://github.com/sethmlarson/truststore |
| typing-inspection | 0.4.4 | MIT | https://github.com/pydantic/typing-inspection |
| typing_extensions | 4.16.0 | PSF-2.0 | https://github.com/python/typing_extensions |
| uefi_firmware | 1.16 | BSD-3-Clause | https://github.com/theopolis/uefi-firmware-parser |
| unicorn | 2.1.4 | BSD License | http://www.unicorn-engine.org |
| uvicorn | 0.54.0 | BSD-3-Clause | https://uvicorn.dev/ |
| watchfiles | 1.3.0 | MIT | https://github.com/samuelcolvin/watchfiles |
| websockets | 17.3 | BSD-3-Clause | https://github.com/python-websockets/websockets |
| win32_setctime | 1.2.1 | MIT license | https://github.com/Delgan/win32-setctime |
| z3-solver | 5.1.0.0 | MIT License | https://github.com/Z3Prover/z3 |

## 4. 文件查找方法

便携包解压后，可用以下方式核对许可证：

```powershell
Get-ChildItem resources\bingraph\licenses -Recurse -File
Get-ChildItem resources\bingraph\site-packages -Recurse -File |
  Where-Object { $_.Name -match '^(LICENSE|LICENCE|COPYING|NOTICE|AUTHORS)' }
```

`build-portable.ps1` 会：

1. 保留 `site-packages/*.dist-info` 内上游自带的许可证；
2. 额外复制一份到 `resources/bingraph/licenses/<dist-info>/`；
3. 复制 Python 的 `LICENSE.txt`；
4. 把本文件和 `README.md` 放到分析器根目录。

## 5. 重新生成清单

在便携环境构建完成后执行：

```powershell
$py = "resources\bingraph\python\python.exe"
& $py -c "import importlib.metadata as m; print(len(list(m.distributions())))"
```

预期输出为 `77`。如果依赖版本或数量变化，必须同步更新
`tools/bingraph/requirements.txt`、本清单以及 KDock 根目录的 `NOTICE`。

## 6. 免责声明

本清单按“尽力而为”的方式整理，不构成法律意见。各组件版权归原作者所有。
若上游元数据、许可证文件或实际发行内容发生冲突，以对应上游项目随包提供的
许可证原文为准。重新分发前请自行完成目标司法辖区的合规审查。
