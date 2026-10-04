# FPGA Monitor

Windows 11 上的 FPGA UART 调试上位机：实时示波器、动态通道、参数修改、实验记录和 CSV 导出。界面采用白色面板、蓝色控件和灰色虚线网格，波形导航参考 VOFA。使用 Vanilla JavaScript、Vite、Apache ECharts、Web Serial、IndexedDB。通道由 FPGA 上传的 PARAM_ID 自动发现；名称、单位和可写属性由用户设置，不需要为新 ID 修改网页源码。

## 安装与启动

安装 Node.js 22.12+ 或 24 LTS（测试环境：Node 24.16.0、npm 11.13.0）。在 PowerShell 执行：

```powershell
cd D:\github\FPGA2026\FPGA2026\DLB\FPGA-Monitor
npm install
npm run dev
```

在 Edge / Chrome 打开终端输出的 localhost 地址，默认 `http://127.0.0.1:5173`。若 PowerShell 禁止执行 npm.ps1，可使用 `npm.cmd install`、`npm.cmd run dev`。无需更改系统执行策略。

```powershell
npm run test
npm run build
npm run preview
```

build 生成 `dist/`；preview 可检查生产产物。请通过本地 HTTP 服务或 HTTPS 访问，勿双击 index.html。安装依赖需要 npm 网络；安装及构建完成后，运行不使用互联网 CDN。保持同一主机、端口和浏览器配置，才能恢复同一份本地数据。

## 无 FPGA 的 Demo

点击顶部 **Demo Mode**，立即产生 50 Hz 合法 Protocol V1 Telemetry，自动出现 7 个通道。波形含阶跃、正弦和衰减信号；三条 Q16.16 通道用于测试参数写入，`Channel 0x20` 是 -1～+1 的缓慢 FLOAT32 正弦。名称统一为 `Channel 0xNN`，默认均不可写。将任意通道设为 Writable 后可以发送参数，Demo 会在下一次 Telemetry 回读新 RAW；FLOAT32 的完整正弦范围可将 Slider Min/Max 设为 -1/1，配到 Right Y 更容易观察。点击 **Demo CRC 测试** 注入一帧错误 CRC；顶部 CRC 增加，日志显示期望值、接收值和 HEX，后续帧正常解析，Lost 增加 1。

## 连接真实 FPGA

1. FPGA 需要实际发送 Protocol V1 Telemetry；PC 波特率与 FPGA 相同，默认 115200、8N1、无流控。
2. 连接 USB UART，关闭其他占用端口的软件，点击 **连接串口**，在浏览器授权窗口选择设备。
3. 收到合法 Telemetry 后自动创建通道。浏览器仅能提供 USB VID/PID 或通用设备标签，Web Serial 不提供可靠的 Windows COM 编号；可在系统设备管理器核对。
4. **断开** 会先保存当前记录、取消读操作、释放读写锁，再关闭设备。取消端口选择只留下 WARN。设备拔出后显示 Disconnected。

现有 `../DLB/DLB.srcs/sources_1/new/Test.v` 已接入自动启摆、角度内环和位置外环，每20ms上传两环goal/real/set及六项Kp/Ki/Kd，共12个通道。烧录 `../build/pid_uart/Test.bit` 后，按 [PID_UART_README.md](../PID_UART_README.md) 的ID表重命名通道，仅将0x10/0x11/0x12和0x20/0x21/0x22设置为Writable。K1/K2按下改变位置目标±34；K3按下启摆/停止。所有可写参数通过Telemetry回读；实际电机与UART硬件联调需上板验证。

## 通道配置与参数控制

左侧每个通道显示名称、当前数值、单位、ID、类型、RAW 和轴。点击 **设置**：

- **名称 / 单位**：可使用中文；名称不是机器身份，同名通道仍由 ID 区分。
- **颜色**：颜色选择器修改波形颜色；首次发现按适合白底的固定 Palette 顺序分配颜色，已保存的颜色继续保留。
- **显示波形**：也可使用列表复选框快速隐藏。隐藏只影响图表，接收、实时缓存和记录继续。
- **Y 轴**：选择 Left / Right。大信号可用左轴，小信号可用右轴。
- **Writable**：启用后右侧动态生成 Slider 和 Numeric Input。
- **Slider Min / Max / Step**：有限数值，Min < Max，Step > 0。数值还必须满足 DATA_TYPE 可表示范围。

配置点击 **保存** 生效，随 localStorage 持久化。未见到当前连接 Telemetry 的通道禁止发送。未知类型保留 RAW 并显示 `Unsupported Type 0xNN`，写入控件禁用。

拖动 Slider 最多约 20 Hz 发送，松开立即发送最终值。Numeric Input 与 Slider 联动，在数字框按 **Enter** 发送，采用类型量化后的值作为 Requested。输入空值、NaN、Infinity、类型溢出、超出用户配置范围不会发送；INT32/UINT32 必须是整数。范围 Step 决定滑块刻度，数字框允许任意合法数值。

例如 Q16.16 输入 `0.25`，RAW=16384，Payload=`10 03 00 40 00 00`（此例 ID=0x10）。TX 日志显示实际完整 HEX、SEQ、类型、RAW 与数值。只有后续 Telemetry 的 TYPE 和 RAW 与请求相同才显示 **✓ SYNCED**；2 秒后仍不一致显示 **未同步**。没有独立 ACK，也不会自动重试参数。

FLOAT32 使用 IEEE-754 single precision（32 bit、小端），不经过 Q 格式量化。ID=0x20 输入 `0.25` 时 Payload=`20 05 00 00 80 3E`，RAW 显示位模式 `0x3E800000`；Requested 使用实际 float32 舍入后的数值。写入拒绝 NaN、Infinity、-Infinity 和 FLOAT32 范围溢出，极小有限数值可以下溢为零。接收的异常浮点仍显示、记录和保留 RAW，图表以空缺处理；后续有限值继续绘制。

## 面板与通信日志

Channels、Parameter Control 标题栏箭头可独立折叠，折叠后保留 34px 窄边和展开按钮；Communication Log 折叠后保留标题栏。Waveform 自动利用释放的宽度和高度，ECharts 监听容器尺寸并 resize，LIVE / PAUSE / 历史及当前导航范围保持不变。箭头支持键盘操作，侧栏滚动时标题栏保持可见。

三个面板状态与“协议分组”开关统一由 ConfigStore 保存，刷新后恢复。旧 v1 配置自动补默认值：面板全部展开，协议分组开启；已有通道和轴设置继续保留。

日志默认按 Header、Version、MSG_TYPE、SEQ、Payload Length、Payload、CRC16 分组；Telemetry Payload 先显示 COUNT，随后每个参数恰好 6 Byte 一组，SET_PARAM 的 6 Byte Payload 是一组。HEX 使用正文色，辅助逗号使用蓝灰色；悬停分组显示字段含义。取消 **协议分组** 可看连续 Raw HEX；每条日志的 **Copy Raw HEX** 始终复制原始 HEX 字节、不含逗号，选中单条 HEX 复制也会去掉辅助逗号。未知消息 Payload 保持整组，长度/COUNT 不完整的诊断日志安全回退到 Raw HEX；分组不执行 CRC 验证、不改变原始帧或实验记录。折叠日志仍继续接收日志，最多 2000 条，展开后显示最近 150 条。

## 示波器

- **1s / 5s / 10s / 30s / 60s**：切换实时观察时间窗并保存。
- **LIVE**：跟随当前接收时间，缩放或拖动后仍持续更新。**PAUSE**：只有点击该按钮才冻结已有波形；串口接收、解析、实验记录继续。再次 LIVE 返回最新数据并复位视图。
- **Y Axis**：左右轴各自配置 Auto 或 Manual Min/Max；必须有限 Min < Max。
- **左键自由拖动**：在绘图区按住左键，上下左右移动同时平移时间轴和双 Y 轴；保持当前标度，可以进入缓存中的旧数据区域，也可以移到负时间或空白区域，没有数据的位置留空。
- **绘图区滚轮**：同时缩放 X 和双 Y 轴，鼠标所在点的坐标保持不动；向上滚动放大，向下滚动缩小，无需按 Shift。
- **坐标轴滚轮**：移到绘图区下方的 X 轴刻度/标题区域，只缩放 X；移到左侧或右侧 Y 轴刻度区域，只缩放对应的 Y 轴。轴上也以鼠标位置为缩放中心。底部 DataZoom 概览滑块仍用于调整时间范围。
- LIVE 中保持缩放后的时间跨度和相对最新时间的位置，随接收时间持续前进；需要在固定时刻观察时点击 PAUSE。接收、通道数值和实验记录不受图表导航影响。
- **RESET VIEW**：复位缩放和平移，Y 轴恢复已配置的 Auto / Manual 范围，不改变 LIVE / PAUSE / 历史状态。纵向拖动和缩放属于当前视图的临时范围，刷新页面后恢复已保存的 Y Axis 配置；在 Y Axis 对话框应用新范围也会清除纵向临时范围。
- 应用区域禁用浏览器默认右键菜单。

实时缓存每通道保留最近 20,000 点，50 Hz 下约 400 秒；暂停快照有相同上限。历史实验必须使用 Record 才会完整保存。图表独立约 25 FPS 刷新，绘制每条线最多约 3000 个保留极值的点；原始缓存和记录不进行绘图降采样。统一 Tooltip 显示所有可见通道，在游标时间取最近的绘图点；没有数据或类型不支持时显示“—”，不进行虚构插值。

## Record、历史与 CSV

连接后点击 **Record** 创建 Session，点击 **Stop** 批量提交剩余数据和结束信息。每帧记录 SEQ、hostReceiveTime、Session 相对时间，以及所有参数的 ID、TYPE、原始补码 bits、signed/unsigned RAW 和 decoded value。每 500ms 或累积 250 帧触发批量提交，单次最多 250 帧，数据与对应元信息在同一事务提交。

**历史 Sessions** 显示名称、开始时间、时长、Frame/Sample 数和状态：

1. 编辑名称后点击 **重命名**。
2. 点击 **查看**，按当前时间窗读取历史数据；下方历史起点、时间位置滑块和 **加载时间窗** 浏览其他区段。每次只查询选定范围，每通道最多 2000 时间桶、每桶 min/max 两点；不把整个 Session 放进图表。
3. 点击 **导出 CSV** 下载长表；活动记录需先 Stop。导出逐页读数据库，不依赖实时 RingBuffer。
4. **删除** 需再点击一次“再次点击删除”，删除 Session 与对应帧。活动记录禁止删除。

CSV 为 UTF-8（带 BOM）、CRLF、标准双引号转义，列：

| 列 | 含义 |
| --- | --- |
| timestamp | Session 开始后的主机相对秒，6 位小数 |
| seq | FPGA 上传帧序号 |
| channelId | 两位 HEX ID |
| channelName | Session 保存的通道名称 |
| type | 类型名称，未知类型保留说明 |
| raw | signed RAW（INT32 / Q）或 unsigned 原始 bits（UINT32 / FLOAT32 / 未知）；FLOAT32 此列不是浮点值 |
| value | 解码值，负数和小数直接保留；未知类型空值 |
| hostReceiveTime | 页面 performance.now() 毫秒，帧完成接收时刻 |
| hostTimestamp | Session 开始墙钟时间加相对时间的 ISO 时间 |

同一帧每个参数一行。用户名称中的引号、逗号会转义；可能被 Excel 执行的公式文本加单引号防护，负数数值不受影响。CSV 导出时最终 Blob 大小与文件大小成正比，超大实验应分成多个 Session。

刷新会恢复 UI 配置，历史存在 IndexedDB，不会自动恢复串口连接。运行中刷新提示先停止记录；突然退出后，下次打开把未结束 Session 标为 `interrupted`，保留已提交帧，最后未提交的 RAM 批次可能丢失。IndexedDB 失败或存储积压超过 5000 帧时日志报错并停止记录接收，可点击 Stop 重试保存保留的 RAM 数据；不会宣称保存成功。

## Protocol V1 概要

Frame：`A5 5A | VER=01 | MSG_TYPE | SEQ uint16 | LEN uint16 | Payload | CRC uint16`，多字节 Little Endian。CRC-16/MODBUS：初始 FFFF，多项式 A001，覆盖 VER 至 Payload，排除 Header 和 CRC。

TELEMETRY `0x01`：`COUNT uint8` 后重复 `PARAM_ID uint8 + DATA_TYPE uint8 + VALUE uint32 bits`，LEN=`1+COUNT*6`，最大 255 参数。SET_PARAM `0x10`：单个参数，LEN=6。PC 不实现 GET_PARAM、COMMAND、ACK 等其他指令，未知消息经 CRC 校验后安全忽略。

| 类型 | ID | 转换 |
| --- | --- | --- |
| INT32 | 0x01 | signed int32 |
| UINT32 | 0x02 | unsigned int32 |
| Q16.16 | 0x03 | signed RAW / 65536 |
| Q8.24 | 0x04 | signed RAW / 16777216 |
| FLOAT32 | 0x05 | IEEE-754 single precision，32 bit，Little Endian |

所有转换只在 ValueCodec；整数/Q 编码采用 Math.round，正好半 LSB 时遵循 JavaScript 向正无穷的舍入规则。FLOAT32 使用 DataView 的 getFloat32/setFloat32 小端转换，VALUE 仍固定 4 Byte，不改变 Frame/LEN/CRC 结构。`1.0f` 位模式 `0x3F800000`，UART VALUE=`00 00 80 3F`；`0.25f` 为 `00 00 80 3E`。STM32 发送 float32 时也必须遵守上述小端顺序。SEQ 65535→0 自然溢出，统计前向间隔中的 Lost；重复和旧帧不制造 65535 个丢帧。设备复位后请断开再连接以重置统计基准。主机时间不是 FPGA 采样时间；倒立摆Test顶层每20ms对两环最近控制量、实测值和系数整帧锁存，其他仅直接使用逐参数锁存TX的顶层需自行保证采样一致性。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 无法选串口 | 使用 localhost / HTTPS 的 Chrome / Edge；检查授权及设备是否被其他软件占用 |
| 已连接无通道 | 确认烧录了 Protocol V1 TX 顶层、波特率一致，检查串口方向与板端文档 |
| CRC / Format 增长 | 检查波特率、LE、CRC 范围、COUNT/LEN 与线路质量；坏帧不会更新参数 |
| 小数与输入稍有差异 | Q 格式量化或 FLOAT32 精度舍入；例如 0.2 在 Q16.16 回读约 0.199996948，在 FLOAT32 回读约 0.200000003 |
| 显示未同步 | FPGA 是否允许该 ID/TYPE、是否将更新后的参数加入 Telemetry；日志查看 TX 与 RAW |
| 刷新配置不见 | 核对浏览器、主机、端口；隐私模式 / 清除站点数据可能清掉本地数据 |
| 历史不可用 | 查看 ERR；检查 IndexedDB 权限、磁盘配额；实时监视和日志仍可运行 |
| 后台掉速 | 浏览器会节流后台页面定时器；Demo 和绘图尤其受影响，前台观察效果最好 |

维护前阅读 [ARCHITECTURE.md](ARCHITECTURE.md)、[AGENTS.md](AGENTS.md)、[CODEX_TASK.md](../CODEX_TASK.md)。验收证据和真实硬件测试边界见 [IMPLEMENTATION_REPORT.md](IMPLEMENTATION_REPORT.md)。

参考：[Apache ECharts 动态更新文档](https://echarts.apache.org/handbook/en/how-to/data/dynamic-data/)、[Chrome Web Serial 文档](https://developer.chrome.com/docs/capabilities/serial)。
