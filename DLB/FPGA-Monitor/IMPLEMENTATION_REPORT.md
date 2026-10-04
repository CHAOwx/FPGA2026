# FPGA Monitor 实现与验收报告

完成时间：2026-10-02，北京时间。实现位置：`D:\github\FPGA2026\FPGA2026\DLB\FPGA-Monitor`。规格来源：`../CODEX_TASK.md`。

## 交付内容

已交付可独立运行的桌面 FPGA UART 上位机，包含 Web Serial、Protocol V1 流解析、自动 Channel 发现、单图实时波形、左右 Y 轴 Auto/Manual、Pause/Live、参数 Slider/Numeric Input、SET_PARAM、Telemetry 同步确认、配置持久化、IndexedDB 实验记录、历史管理、CSV 和有限通信日志。无 UI 框架、云服务或 CDN 运行依赖，无未完成实现占位。

开发前阅读任务书、仓库 README、DLB/AGENT.md、UART 协议与 RX/TX 模块使用文档、Seg8 文档，以及 DLB 工程现有 RTL 和约束。已有 `HTML/` 工程是独立 Block Studio，未重用其业务模型，也未修改它。仅新增 PC 上位机内容，保留所有 FPGA RTL、用户资料及开发开始前已经暂存的 11 项协议/RTL/文档变更。

## 目录结构

```text
DLB/
  CODEX_TASK.md                  原任务书，未修改
  IMPLEMENTATION_REPORT.md       本报告的入口
  FPGA-Monitor/
    index.html
    package.json / package-lock.json
    vite.config.js / .gitignore
    README.md / ARCHITECTURE.md / AGENTS.md
    IMPLEMENTATION_REPORT.md
    src/
      main.js
      core/Events.js
      app/AppController.js
      serial/SerialTransport.js / MockTransport.js
      protocol/ProtocolConstants.js / CRC16.js / ValueCodec.js
      protocol/ProtocolDecoder.js / ProtocolEncoder.js
      store/ChannelStore.js / ConfigStore.js
      chart/ChartController.js
      control/ParameterController.js
      recorder/HistoryStore.js
      logger/FrameLogger.js
      styles/main.css
    tests/
      crc16.test.js / valueCodec.test.js
      protocolDecoder.test.js / protocolEncoder.test.js
      state.test.js / serialTransport.test.js
      history.test.js / capacity.test.js
    dist/                        本地生产构建，Git 忽略
    node_modules/                本地安装依赖，Git 忽略
```

## 核心架构与协议

Transport 字节事件交给 Decoder，合法 Telemetry 统一进入 ChannelStore；图表、UI 和 Recorder 消费该中心状态。真实 SerialPort 只有 SerialTransport 持有；UI 不拼帧，图表不解析 UART；ValueCodec 是唯一 RAW ↔ Human 转换模块。完整 18 条维护不变量记录在 ARCHITECTURE.md，每个主要 JS 模块带职责、依赖、禁止职责、API 与不变量文件头。

Protocol V1：A5 5A、版本 01、LE SEQ/LEN/VALUE/CRC；CRC 初始 FFFF、多项式 A001，计算范围 VER 至 Payload。TELEMETRY LEN=1+COUNT×6，SET_PARAM LEN=6。Decoder 处理任意拆包、粘包、单字节输入、A5 A5 5A、坏 CRC、非法版本/长度/COUNT、未知消息；未知数据类型保留 RAW，不做假解码。SEQ 统计正确处理 65535→0、丢帧、重复和旧帧。PC 只发送 SET_PARAM，没有 ACK/GET_PARAM/COMMAND。

Q16.16 0.25 编码为 RAW=16384、VALUE 小端 `00 40 00 00`；Q16.16 0.2 量化为 13107；-1.5 编码为 32 位补码并恢复为负小数。Q8.24、INT32、UINT32、类型边界、NaN/Infinity 均有测试。

参数门控来自用户 writable 配置，与 ID 名称无关。拖动 50ms 节流，松开立即发送最终值，Numeric Input 按 Enter 发送；Requested 使用量化值，下一帧 TYPE 和 RAW 一致才显示 SYNCED，超过 2 秒不一致显示未同步。

配置使用版本化 localStorage key；坏 JSON / 不兼容版本 / 非法字段安全 fallback，配额错误报 ERR。持久化只保留 UI 字段，不能覆盖机器 ID 或 RingBuffer。每通道 RingBuffer 20,000 点，日志 2000 条、显示 150 条。图表独立约 25 FPS，有限极值降采样。暂停冻结已有缓存，接收/记录继续；统一 Tooltip 显示全部可见线最近点，不虚构插值。

记录每 500ms 或 250 帧批量提交，单个事务包含样本与对应 durable Session 元数据，最多一个并行 flush。同步及异步 DB 失败均保留 RAM 批次，Stop 可重试；Stop 可并发调用而共享完成过程。积压上限 5000 帧，超限明确停止接收记录。历史采用时间索引与限定时间窗，每通道固定 2000 桶 min/max；CSV 使用 500 帧分页读取，UTF-8 BOM、标准引号转义，保留负数、小数和 SEQ。

## 自动化测试结果

实际运行 `npm install`、`npm run test`、`npm run build`。最终 `npm run test`：**8 个测试文件，72 项全部通过**，约 8 秒墙钟时间。

| 文件 | 项数 | 主要验证 |
| --- | ---: | --- |
| crc16.test.js | 3 | ASCII 123456789→4B37、空输入、确定 Modbus 请求 |
| valueCodec.test.js | 31 | 四类型正负数、小数、补码、边界、非法输入、未知类型 |
| protocolEncoder.test.js | 3 | 完整 SET_PARAM 字段、LE、CRC、SEQ 回绕、拒绝非法值 |
| protocolDecoder.test.js | 14 | 所有分割位置、单字节、确定伪随机 chunk、粘包、垃圾、CRC/版本/LEN/COUNT、未知消息/类型、最大 COUNT |
| state.test.js | 10 | 所有 UI 配置恢复、坏配置、字段隔离、隐藏缓存、有限日志、SEQ、可写门控、节流、回读同步、Mock |
| serialTransport.test.js | 3 | 实际 JS Streams 测读写、8N1、写顺序、关闭锁释放、拔出错误、取消授权、不支持浏览器 |
| history.test.js | 6 | 批量保存、hidden 样本、准确计数、分页 CSV、名称转义、窗口极值、中断恢复、DB 失败与重试、并发 Stop |
| capacity.test.js | 2 | 30 通道 / 54 万帧容量验证，绘图降采样保留孤立极值 |

容量测试加速处理 540,000 帧（50 Hz 下相当于 3 小时），共 16,200,000 次 Channel 更新，SEQ 多次回绕无误；每通道缓存仍严格 20,000 点，日志仍 2000 条。此测试验证中心状态容量边界，**不等同于真实浏览器和硬件连续运行 3 小时**。

首次 fake-indexeddb 的 2000 帧窗口测试超过默认 5 秒；已确认是模拟数据库遍历耗时，对该容量测试设定 15 秒超时，验证仍检查实际窗口结果与保留峰值。修复了批次同步失败保护、过多排队 flush、并发 Stop 和配置额外字段覆盖问题，并增加回归测试。

## Chrome 实际交互验收

使用 Playwright CLI 技能在本机实际 Chrome 中执行，不是仅检查文件存在。开发版和生产版均完成端到端验收；生产版检查 25 类交互，**PASS，pageerror=[]**。最终完整验收 Session 保存 158 帧、948 samples，下载 CSV 共 949 行（含标题）。

| 任务验收项 | 验证结果 |
| --- | --- |
| Demo 自动生成通道与动态波形 | 6 Channel，约 50 frames/s，图表时间持续推进 |
| 名称 / 单位 / 颜色 / 隐藏配置 | 实际修改、保存、刷新后整体配置 JSON 一致 |
| Writable 动态控件 | 启用后生成 Slider + Numeric Input，实际鼠标拖动与 Enter 双向联动 |
| Q16.16 SET_PARAM | 0.25→RAW16384、TX完整HEX、下一帧实际值确认 SYNCED |
| 非法参数 | 输入999999不增加TX计数，产生用户可见错误 |
| 左右 Y / Manual | ECharts 实际 option：Left=-300..1400，Right=-1..1；ID16 在轴1 |
| Tooltip / Zoom / Pan | tooltip.trigger=axis；实际滚轮使窗口5s缩短为约4.546s，拖动使startValue变化 |
| Pause / Live | PAUSE 时固定图表结束时间，同时 SEQ 与 Recording 继续；LIVE恢复 |
| Communication Log | RX/TX 颜色不同、Raw HEX、过滤RX后不显示RX；CRC注入显示Expected/Received和计数 |
| Record / IndexedDB | 真浏览器DB含完整帧，隐藏ID02的每帧样本仍保存 |
| 历史 | 重命名、查看、指定时间窗加载、CSV下载、双击确认删除均完成 |
| 响应式 | 1920×1080、1366×768截图检查；1366页宽=1366、图表高376px、工具栏bottom598px，无横向溢出 |
| 右键菜单 | 应用内contextmenu事件被preventDefault |
| 运行不依赖CDN | 阻断所有外部网络请求，生产资源全部来自127.0.0.1，Demo仍生成6通道和滚动波形 |

临时验收工具和证据位于工作区 `Claude_Temp/`，不属于运行依赖：

- `fpga-browser-acceptance.js`：完整交互脚本。
- `fpga-browser-chart.js`：实际 ECharts 配置、鼠标滑块、滚轮和平移检查。
- `fpga-browser-production.js`：阻断外网的生产构建检查。
- `fpga-browser-output/desktop-1920.png`、`desktop-1366.png`、`acceptance.csv`：截图与 CSV 证据。

依用户“不提问”要求保留这些临时文件，没有删除既有 Claude_Temp 内容。

## Build 结果

Node 24.16.0、npm 11.13.0；lockfile 实际依赖：ECharts 6.1.0、Vite 7.3.6、Vitest 3.2.7、fake-indexeddb 6.2.5。`npm install` 成功，增加55个本地包，未使用全局安装。

最终 `npm run build` 成功，605 modules、约2.3秒：

| 文件 | 未压缩大小 |
| --- | ---: |
| dist/index.html | 6.14 kB |
| dist/assets/index-IyUF21d9.css | 7.08 kB |
| dist/assets/index-CjVGYm9l.js | 38.79 kB |
| dist/assets/echarts-Bb4k66ly.js | 530.59 kB（gzip约180.27 kB） |

Vite 对 ECharts chunk 超过500kB产生大小提示，**非错误**；已按用途独立打包应用和 ECharts，未通过提高阈值隐藏提示。Chart/Grid/Tooltip/DataZoom/Canvas按模块引入；无在线CDN。

## 运行与设备接入

```powershell
cd D:\github\FPGA2026\FPGA2026\DLB\FPGA-Monitor
npm install
npm run dev
```

使用 Edge/Chrome 打开终端URL，点击 Demo Mode。生产版可 `npm run build` 后 `npm run preview`。本次验收预览地址为 `http://127.0.0.1:4173`，服务仅绑定本机。

真实设备：确认 FPGA 顶层已连接 telemetry_param_mux→protocol_tx→UART_TX 以及 UART_RX→protocol_rx→parameter_manager；PC/FPGA都采用115200 8N1，在浏览器端点击连接并授权设备。每个可写参数必须同时接入 Telemetry，供 Requested/Actual 同步比较。名称和可写属性在左侧设置，新增 ID 无需修改网页源码。

## 已知限制与验证边界

1. **真实 FPGA UART 硬件未接入测试**，不能声称物理端口授权、板端协议、参数寄存器更新和板级电气连接已验证。SerialTransport 的自动测试以真实 JS Streams 替代设备，Demo 只证明 PC完整链路。
2. **当前既有 Test.v 是 ADC 数码管顶层，未接入 Protocol TX/RX**。本任务限定只改上位机，保留该 RTL；单独烧录它不会产生协议数据，板端须按已有文档集成。
3. 真实浏览器验收使用 Chrome；Edge 具有相同目标API，但未在本次单独启动 Edge 测试。
4. 主机接收时间并非 FPGA 精确采样时间。现有 TX 逐个参数锁存；稀疏数据/降采样 Tooltip 使用最近点；不声称同步采样。
5. 浏览器只提供USB VID/PID或通用标签，无法保证显示真实COM编号。不持久化串口权限对象。
6. 背景页面可能被浏览器节流；容量测试是加速状态验证，未执行真实浏览器连续数小时硬件压力测试。
7. 浏览器异常退出可能损失最后未提交RAM批次；已提交记录会在下次打开标为interrupted。存储受IndexedDB配额影响，超过积压上限会明确停止记录。清除站点数据会删除配置和历史。
8. CSV最后构造Blob，内存与导出文件大小成正比，超大实验宜拆Session。跨设备配置导入导出、FFT、多图等不在V1范围。
9. 同一PARAM_ID跨设备共享同一origin的UI配置；没有设备业务识别。设备复位后需重新连接以重置SEQ统计。
10. DB同时多窗口操作没有协同录制锁；建议一个浏览器页面连接一个实验设备。

## 后续扩展位置

未来 FPGA timestamp 可增加 Frame 独立字段及新的明确协议版本；新增 DATA_TYPE 只在 ValueCodec 与测试扩展；设备差异配置可在版本化 ConfigStore 迁移时引入 profile。更大的导出可替换为流式文件保存，历史图表仍维持有限窗口。此次未加入账号、云数据库、WiFi、WebSocket、自动整定或插件系统。

## 2026-10-02 后续修复：纵向拖动与缩放后实时更新

根据用户实际使用反馈，修复仅能横向平移和缩放后波形停止更新两项问题。本节为后续行为，覆盖前文初次交付中“手动缩放进入PAUSE”的设计；后续位置环RTL集成情况见上一级IMPLEMENTATION_REPORT.md。

原因：原ChartController仅配置X轴DataZoom，且datazoom事件直接调用pause；绝对startValue/endValue和一次性keepZoom状态也不适合持续移动的实时窗口。

完成变更：

- ChartController保留用户选定的X轴百分比范围，LIVE时随接收时间窗推进，缩放/平移不再改变模式，也不重置用户选择的比例。
- 左键在绘图区上下左右拖动支持X轴和双Y轴平移；双Y轴按各自当前显示量程换算相同像素位移，保持各自比例。Auto和Manual轴均支持。
- 普通滚轮缩放X轴；Shift+滚轮围绕鼠标位置缩放双Y轴，不触发X缩放。
- 增加RESET VIEW，恢复完整时间窗及已保存的Auto/Manual Y范围，保留当前LIVE/PAUSE/历史状态。LIVE恢复最新数据并重置导航；Y Axis应用新设置清除临时纵向范围。
- PAUSE仅显式触发，缩放、重复PAUSE和更改时间窗均不重新捕获正在接收的数据。暂停数据先筛选选定时间窗，再降采样，保持该窗口内的绘图分辨率。接收和IndexedDB记录始终独立继续。
- 纵向导航属于ChartController临时视图；不改localStorage/IndexedDB Schema、协议、参数写入、环形缓存限制或FPGA代码。退出图表时解除窗口级指针监听。

本轮修改文件：`src/chart/ChartController.js`、`src/app/AppController.js`、`index.html`、README.md、ARCHITECTURE.md、本报告；新增`tests/chart.test.js`与`tests/chart-browser.js`。dist重新构建，根目录Claude_Change.md追加完整文件记录。

验证结果：

| 检查 | 结果 |
| --- | --- |
| Vitest | 9个测试文件、81项通过；新增9项覆盖实时缩放不暂停、数据继续绘制、暂停快照稳定、时间窗筛选、双轴上下平移、Shift缩放、复位、历史和事件清理 |
| 实际Chrome Demo | 1920×1080、1366×768全部通过；使用真实鼠标滚轮、左键斜向拖动和Shift键，无浏览器脚本错误，工具栏无横向溢出 |
| 浏览器图表数值检查 | 直接读取ECharts选项和series验证缩放比例保持、时间范围随接收前进、实际series的新样本时间继续增加；验证Auto/Manual双Y平移与纵向缩放 |
| 暂停/记录/历史 | 明确PAUSE后series和显示时间冻结，SEQ继续增加；切换时间窗不偷换快照；记录正常持久化；历史缩放保持历史模式，LIVE返回最新样本 |
| Vite生产构建 | 成功，605 modules；应用JS为`dist/assets/index-DTbCdLUk.js`（41.26kB），生产入口6.20kB；ECharts大小提示仍为非错误 |
| 生产preview实际Chrome | 本机4173端口：缩放后保持LIVE、时间与SEQ增加且Canvas内容持续变化；PAUSE冻结视图但继续接收，LIVE恢复；无脚本错误 |

可复现：在项目目录执行`npm.cmd run test`与`npm.cmd run build`；Vite dev启动后，以新浏览器测试会话执行`playwright-cli run-code --filename=<绝对路径>/tests/chart-browser.js`。该浏览器脚本明确用于独立测试会话，会清空该会话的localStorage并产生Demo实验记录，不应用于用户正在进行的真实串口实验。

本轮浏览器证据保存在工作区`Claude_Temp/fpga-browser-output/`：`chart-fix-acceptance.log`、`chart-production-smoke.log`、`chart-fixed-1920.png`、`chart-fixed-1366.png`。本轮仍未测试真实FPGA硬件；不将Demo结果描述为实机联调。

## Git 与文件变更

开发前后均执行 git status；只新增 `DLB/FPGA-Monitor/`、`DLB/IMPLEMENTATION_REPORT.md` 和根目录追加的 `Claude_Change.md`。源码与8个测试文件如目录结构所列，依赖和构建产物由项目.gitignore排除，Claude_Temp和变更日志由仓库已有规则排除。未commit、未push、未删除或覆盖用户已暂存修改；`git diff --name-only` 无已有跟踪文件的额外未暂存改动。完整本轮新增文件清单见工作区根目录Claude_Change.md。

## 2026-10-02：白色界面与 VOFA 风格鼠标导航

按用户最新指令，将原任务书的深色优先样式改为白色界面，并替换上一阶段普通滚轮/Shift滚轮的交互。当前操作以本节及README为准。

实现内容：

- 主页面、通道区、参数区、日志、输入控件和对话框采用白色/浅灰背景、蓝色交互控件；图表白底与灰色虚线网格，Tooltip同步改为白色。新发现通道使用适合白底的固定Palette，保留用户已有颜色。
- 左键在绘图区自由平移X和双Y，保持三轴跨度，不受默认时间窗/零点边界夹紧。可返回保留缓存中的旧数据；负时间、未来或缓存之外显示空白，不虚构数据。拖动回起点精确恢复原范围，结束/失焦/取消时清除拖动状态。
- 绘图区滚轮围绕鼠标点同时缩放X和双Y，无需Shift；X轴刻度/标题区滚轮仅缩放X，左/右Y轴刻度区滚轮仅缩放对应Y。正反方向滚轮可在相同锚点恢复跨度，轴标签截短到合理有效位数。
- X视图由百分比改为相对当前模式末端的秒数偏移。LIVE每次绘图重算绝对范围，持续更新并保持跨度；PAUSE快照和历史仍使用固定末端。移除inside DataZoom重复手势，概览slider保留；RESET VIEW和LIVE恢复视图。
- 维持25 FPS、每通道20,000点RingBuffer、约3000点绘图降采样、有限日志和历史加载窗口。接收、参数控制、记录、协议和存储Schema继续独立工作。

验证结果：

| 检查 | 结果 |
| --- | --- |
| 全部自动测试 | `npm.cmd test`成功：9个文件、86项通过；其中14项chart回归覆盖鼠标锚点、绘图区三轴/坐标轴单轴缩放、逆向缩放、自由平移、旧缓存、空白区域、回起点、LIVE更新、PAUSE/历史、复位和事件清理 |
| 实际Chrome Demo | 1920×1080、1366×768均PASS；真实滚轮和左键拖动，检查Auto及Manual双Y、无横向溢出、无脚本错误 |
| 鼠标锚点数值 | 1920尺寸X锚点缩放前后均1.3932532467532468s；左Y均962.7450980392157、右Y均0.4627450980392156；1366尺寸也保持，仅浮点舍入误差 |
| 自由导航与实时更新 | 双尺寸拖到负时间，series为空；复位返回已冻结样本；LIVE缩放后的实际series末点分别从5.4205→6.06020000000298s和5.42110000000149→6.0675s，时间跨度保持 |
| 记录/历史 | PAUSE显示末端不变而SEQ继续增加，记录能Stop并持久化；查看Session后导航保持history，LIVE恢复最新数据 |
| 生产构建 | `npm.cmd run build`成功，605 modules；入口6.23kB、`index-QWBt9rgY.js`42.98kB、`index-Hk59cEBQ.css`7.32kB；ECharts530.59kB体积提示是非错误 |
| 生产preview实际Chrome | 4173端口确认加载新白色CSS；缩放后LIVE末端2.3011→2.9413s且Canvas哈希改变，轴上滚轮/拖动可执行；PAUSE Canvas哈希固定而SEQ增长，LIVE恢复重绘，无脚本错误 |

浏览器验收脚本为`tests/chart-browser.js`，通过独立Playwright CLI会话运行；脚本清空该测试上下文的localStorage并创建Demo记录，应使用隔离会话。证据位于工作区`Claude_Temp/fpga-browser-output/`：`vofa-acceptance.log`、`vofa-production.log`、`vofa-1920.png`、`vofa-1366.png`、`vofa-production.png`。

运行方式不变：项目内`npm.cmd run dev`，Chrome/Edge打开5173端口；已有网页刷新即可加载新界面。鼠标使用说明见README“示波器”章节。

本轮修改ChartController、ConfigStore默认Palette、main.css、index.html、两个图表测试、README、ARCHITECTURE、两份实现报告，并重新构建dist，根目录Claude_Change.md记录完整变更。git status中的MyPID.v、Test.v、parameter_manager.v、telemetry_param_mux.v、两个PID构建/测试脚本和pid_uart_tb.sv属于已有变更，本轮未编辑；遵循现有忽略规则，未更改.gitignore、提交或推送。

边界：自由导航只显示当前有限缓存/暂停快照/已加载历史窗口的数据；缓存外或未加载的历史区段需要Record及历史窗口加载。LIVE中的坐标随接收时间前进，固定时刻检查请使用PAUSE。尚未联调真实FPGA或电机，本轮Demo/生产浏览器测试不代表硬件已验证。没有未完成TODO。

## 2026-10-03：面板折叠、协议 HEX 分组与 FLOAT32

本轮在现有工程内增量修改，完整读取了 README、ARCHITECTURE、AGENTS、原任务书、所有 src 及测试。保持 Vanilla JS / ECharts / Web Serial / IndexedDB 模块边界，不改 FPGA Frame 格式或共享板端协议资料。

交付内容：

- Channels / Parameter Control 独立折叠为 34px 窄栏，标题栏箭头保留恢复入口，侧栏滚动时标题保持可见；Communication Log 折叠为 38px 标题栏。CSS Grid 自动释放宽度，底部高度让给 Waveform。ChartController 的 ResizeObserver 执行 resize 并 invalidate，PAUSE / history 也正确刷新，保留模式和导航范围。
- ConfigStore 增加 leftPanelCollapsed / rightPanelCollapsed / logPanelCollapsed / groupedHex 四个布尔字段。仍使用原 v1 Key/version，旧配置先合并默认值再验证；不清除原通道、轴、颜色、可写和范围设置。初次使用全展开、分组开启，刷新后恢复状态。
- 新增 logger/FrameDisplay.js：纯函数返回 data/separator segments 和字段 tooltip。Telemetry 参数严格 6 Byte 一组，SET_PARAM Payload 一组；未知消息 Payload 不猜测，缺损 LEN/COUNT 安全回退。该层不解码 VALUE、不验证 CRC、不处理流恢复、不修改原始 bytes。FrameLogger 保留原 hex 和展示快照，AppController 渲染深色 HEX / 蓝灰辅助逗号。协议分组可切换 Raw，并保存；Copy Raw HEX 和单条 HEX 选区复制均不含辅助逗号。容量继续为 2000 条日志、最多 150 条 DOM，折叠仍接收日志。
- TYPE.FLOAT32=0x05，通过 ValueCodec 中 DataView 的小端 getFloat32/setFloat32 集中转换。VALUE 始终 4 Byte；rawValue 保留 unsigned bits 兼容 DB/CSV，通道和 TX 日志显示 RAW 十六进制位模式。Slider/Numeric Input 发送 float32，Requested 使用舍入后的数值、TYPE/rawBits 回读比较。
- FLOAT32 写入拒绝非有限数值和溢出；RX 的 NaN/Infinity 保留并显示，图表安全转换成 null 空缺，有限极值与空缺参与容量受限降采样。修复历史时间桶以 NaN 开头时后续有限极值不能更新的问题，仍每桶最多两点，原记录数据保持不变。
- Demo 增加 Channel 0x20 的 -1～+1 缓慢 FLOAT32 正弦，仍统一默认命名、默认不可写；用户配置 Writable 后沿用真实 Encoder/Decoder 回读链路。原六通道及其类型/功能保留。

确定字节参考：`1.0f` VALUE=`00 00 80 3F`；`0.25f` VALUE=`00 00 80 3E`。SEQ=0x23、ID=0x20 的 SET_PARAM 为 `A5 5A 01 10 23 00 06 00 20 05 00 00 80 3E 97 3E`，CRC=0x3E97。SEQ=7、单参数 FLOAT32=1 的 Telemetry 为 `A5 5A 01 01 07 00 07 00 01 20 05 00 00 80 3F 3A 9D`。原整数/Q/CRC/LEN/SEQ 实现继续使用。

### 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm.cmd run test` | **11 个文件，123 项全部通过**；含原 86 项及 FLOAT32、分组、配置、resize、非有限值和历史恢复测试 |
| FLOAT32 Codec | 0、1、-1、0.25、3.1415926、-12.5、0.2、-0；确定 bits/LE 字节、合理 round-trip tolerance、有限边界、subnormal/下溢、异常 TX 拒绝 |
| Frame / 参数 | 确定 Telemetry / SET_PARAM 字节与 CRC，FLOAT32 Telemetry 全部 chunk 边界，NaN payload bits 保留、后续有限帧恢复，可写门控、Mock 回读同步和非法输入不发送 |
| 分组与持久化 | 参数每组 6 Byte、SET_PARAM 一组、原字节不变、CRC 诊断保留坏字节、缺损数据 fallback、未知消息整组、COUNT=0/255、旧 v1 默认兼容、8 种状态和 Raw 偏好恢复 |
| 实际 Chrome Demo | `tests/panels-browser.js` 双尺寸、全部 8 种折叠组合 PASS；Canvas/ECharts 尺寸等于容器，无页面横向/纵向溢出、无重叠，PAUSE/history 模式不变，刷新恢复状态 |
| Log / FLOAT32 UI | 数据颜色 rgb(38,52,69)，逗号 rgb(124,145,165)；字段 tooltip、分组/Raw、按钮和选区 Raw 复制；FLOAT32 类型与 RAW bits、右 Y、数字输入和真实键盘滑块发送、SYNCED、越界拒绝、CSV/历史、CRC 注入通过 |
| 异常浮点实际 RX | 测试会话对 Mock 源码响应注入 IEEE bits，经过实际串口流解析/Store/UI/Recorder；NaN、±Infinity 显示正常、ECharts data 安全 null、随后0.25恢复，IndexedDB 保留三个异常位模式，pageerror=[] |
| 既有鼠标导航回归 | `tests/chart-browser.js` 双尺寸 PASS：三轴鼠标锚点缩放、单轴缩放、自由平移、回起点、负时间空白、LIVE更新、PAUSE快照、记录和历史均通过 |
| 最终 production build | **成功，606 modules**；入口6.83kB、CSS8.63kB、应用JS46.64kB；ECharts530.59kB（gzip180.27kB）沿用现有体积提示，无构建错误 |
| 生产 preview / Chrome | `tests/production-browser.js` 双尺寸全部组合 PASS；阻断外部HTTP请求，FLOAT32与Q16.16发送回读、LIVE Canvas持续更新、PAUSE Canvas冻结但SEQ增长、resize/持久化/日志分组正常，pageerror=[] |

图表尺寸（CSS px，ECharts 实测一致）：

| 视口 | 全展开 | 仅左收起 | 仅右收起 | 左右收起 | 仅日志收起 | 全收起 |
| --- | --- | --- | --- | --- | --- | --- |
| 1920×1080 | 1372×630 | 1598×630 | 1608×630 | 1834×630 | 1372×802 | 1834×802 |
| 1366×768 | 878×358 | 1074×358 | 1084×358 | 1280×358 | 878×490 | 1280×490 |

### 文件、复现与证据

新增：`src/logger/FrameDisplay.js`、`tests/float32.test.js`、`tests/frameDisplay.test.js`、`tests/panels-browser.js`、`tests/production-browser.js`。修改 AppController、ChartController、ParameterController、FrameLogger、ValueCodec、ProtocolConstants、MockTransport、ChannelStore、ConfigStore、HistoryStore、main.css、index.html、既有 chart/state/history 测试、README、ARCHITECTURE 和本报告，重新生成 dist。根目录 Claude_Change.md 记录本轮清单。

运行方式保持 README 所述 `npm.cmd run dev`（5173）、`npm.cmd run test`、`npm.cmd run build`、`npm.cmd run preview`（4173）。浏览器脚本使用独立上下文，会清空该测试上下文配置并产生 Demo 记录，禁止用于正在记录真实实验的会话。可通过 Playwright CLI 的 `run-code --filename=<脚本绝对路径>` 运行。本机 CLI 后台会话启动失败，实际验收由工作区已有 Playwright 库通过 `Claude_Temp/run-monitor-browser.cjs` 启动同一实际 Chrome 完成，未新增/全局安装依赖。示例：

```powershell
node Claude_Temp/run-monitor-browser.cjs DLB/FPGA-Monitor/tests/panels-browser.js
node Claude_Temp/run-monitor-browser.cjs DLB/FPGA-Monitor/tests/chart-browser.js monitor-chart-regression.json
node Claude_Temp/run-monitor-browser.cjs DLB/FPGA-Monitor/tests/production-browser.js monitor-production.json
```

这些命令在工作区根目录运行，dev/preview 需预先启动。临时工具与证据统一在 `Claude_Temp/`，不参与生产运行：`fpga-browser-output/monitor-upgrade.json`、`monitor-chart-regression.json`、`monitor-production.json`，`panels-expanded-1920.png`、`panels-expanded-1366.png`、`panels-collapsed-1920.png`、`panels-collapsed-1366.png`、`monitor-production-1920.png`、`monitor-production-1366.png`、`float32-1920.csv`、`float32-1366.csv`。已实际查看布局截图和导出 CSV。遵循本轮“不提问”要求保留临时验收证据。

开始时 git status 干净；结束时另见 `DLB/DLB/DLB.srcs/sources_1/new/protocol_rx.v` 修改及 `DLB/CODEX_TASK.md`、`DLB/PID_UART_README.md`、`DLB/pendulum_overview.mmd` 删除。本轮工具未编辑这些路径，未恢复、覆盖或提交这些任务期间出现的其他变更。未 commit / push。

边界：本轮未接入真实 FPGA/STM32 UART 或电机，板端 FLOAT32 支持需设备自行按协议实现；Demo、Streams 和 Chrome 验收证明 PC 链路。Edge 未单独测试。FLOAT32 精度按 IEEE-754 舍入，resolution 返回最小 subnormal 间隔，不代表全范围恒定精度；历史混合桶继续保留有限 min/max，纯异常桶由图表显示空缺。容量及数据库版本保持现有约束。
