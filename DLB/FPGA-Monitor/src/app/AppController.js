/**
 * Responsibility: Compose services, bind DOM actions, render compact channel/control/log/session UI.
 * Allowed dependencies: Public APIs of transport, protocol, store, chart, recorder, control and logger.
 * Forbidden responsibilities: SerialPort access, CRC computation, byte packing, Q conversion.
 * Public API: AppController(root), dispose().
 * Architecture invariants: ChannelStore feeds chart/UI/recorder; DOM uses textContent for user data.
 */
import { SerialTransport } from '../serial/SerialTransport.js';
import { MockTransport } from '../serial/MockTransport.js';
import { ProtocolDecoder } from '../protocol/ProtocolDecoder.js';
import { ProtocolEncoder } from '../protocol/ProtocolEncoder.js';
import { hexId, MSG } from '../protocol/ProtocolConstants.js';
import { typeName, supported, rawText } from '../protocol/ValueCodec.js';
import { ConfigStore, validateUI } from '../store/ConfigStore.js';
import { ChannelStore, channelConfig } from '../store/ChannelStore.js';
import { FrameLogger } from '../logger/FrameLogger.js';
import { ChartController } from '../chart/ChartController.js';
import { ParameterController } from '../control/ParameterController.js';
import { HistoryStore } from '../recorder/HistoryStore.js';
const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const numberText = value => value === null || value === undefined ? '—' : Number.isInteger(value) ? String(value) : Number(value.toPrecision(8)).toString();
export class AppController {
  constructor(root) {
    this.root = root; this.logger = new FrameLogger(); this.error = error => {
      this.logger.add('ERR', error.message ?? String(error)); this.$('notice').textContent = error.message ?? String(error);
    };
    let storage = null; try { storage = globalThis.localStorage; } catch (error) { this.error(error); }
    this.config = new ConfigStore(storage, this.error); this.store = new ChannelStore(this.config);
    this.decoder = new ProtocolDecoder(); this.encoder = new ProtocolEncoder(); this.history = new HistoryStore();
    this.parameters = new ParameterController(this.store, this.encoder, () => this.transport, this.logger, this.error);
    this.chart = new ChartController(this.$('chart'), this.store, this.config, mode => this.modeChanged(mode));
    this.channelNodes = new Map(); this.controlNodes = new Map(); this.rebuild = true; this.busy = false;
    this.decoder.on('telemetry', frame => this.store.ingest(frame));
    this.decoder.on('frame', frame => this.logger.add(frame.type === MSG.TELEMETRY ? 'RX' : 'WARN', frame.type === MSG.TELEMETRY
      ? `TELEMETRY SEQ=${frame.seq} COUNT=${frame.bytes[8]}` : `Ignored MSG_TYPE=${hexId(frame.type)} SEQ=${frame.seq}`, frame.bytes));
    this.decoder.on('error', error => {
      this.store.stats[error.kind === 'CRC' ? 'crc' : 'format']++;
      this.logger.add('ERR', `${error.kind} ERROR ${error.detail}`, error.bytes);
    });
    this.store.on('discover', () => { this.rebuild = true; });
    this.store.on('config', () => { this.rebuild = true; this.chart.invalidate(); });
    this.store.on('frame', frame => this.history.capture(frame, this.store.channels));
    this.history.on('error', this.error); this.history.on('state', () => this.refreshStatus());
    this.history.init().then(() => { this.dbReady = true; this.refreshStatus(); }).catch(this.error);
    this.bind(); this.restoreUI();
    this.refreshTimer = setInterval(() => this.refresh(), 200);
    this.logger.add('WARN', '就绪 · 启动 Demo 或连接 FPGA；参数名称与 Writable 完全由用户配置');
    this.unload = event => {
      if (this.history.session) { this.history.flush().catch(() => {}); event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', this.unload);
    this.visibility = () => { if (document.hidden) this.history.flush().catch(this.error); };
    document.addEventListener('visibilitychange', this.visibility);
  }
  $(id) { return document.getElementById(id); }
  act(fn) { return (...args) => Promise.resolve().then(() => fn(...args)).catch(this.error); }
  bind() {
    this.root.addEventListener('contextmenu', event => event.preventDefault());
    this.$('demo').onclick = this.act(() => this.connect(true));
    this.$('connect').onclick = this.act(() => this.connect(false));
    this.$('disconnect').onclick = this.act(() => this.disconnect());
    this.$('baud').onchange = () => this.config.saveUI({ baud: Number(this.$('baud').value) });
    this.$('live').onclick = () => { this.historySession = null; this.historyGeneration = (this.historyGeneration ?? 0) + 1; this.$('history-nav').hidden = true; this.chart.live(); };
    this.$('pause').onclick = () => this.chart.pause();
    this.$('reset-view').onclick = () => this.chart.resetView();
    this.$('windows').onclick = this.act(async event => {
      const size = Number(event.target.dataset.window); if (!size) return;
      this.config.saveUI({ timeWindow: size }); this.restoreUI();
      if (this.historySession) await this.loadHistory();
      else this.chart.resetView();
    });
    this.$('axes').onclick = () => {
      const form = this.$('axis-form');
      for (const side of ['left', 'right']) for (const key of ['mode', 'min', 'max']) {
        form.elements.namedItem(side + key[0].toUpperCase() + key.slice(1)).value = this.config.data.ui[side][key];
      }
      form.querySelector('.form-error').textContent = ''; this.$('axis-dialog').showModal();
    };
    this.$('axis-form').onsubmit = event => {
      event.preventDefault(); const form = event.currentTarget; const patch = {};
      try {
        for (const side of ['left', 'right']) patch[side] = {
          mode: form.elements.namedItem(side + 'Mode').value,
          min: Number(form.elements.namedItem(side + 'Min').value), max: Number(form.elements.namedItem(side + 'Max').value),
        };
        validateUI({ ...this.config.data.ui, ...patch }); this.config.saveUI(patch); this.chart.resetYAxis(); this.$('axis-dialog').close();
      } catch (error) { form.querySelector('.form-error').textContent = error.message; }
    };
    this.$('channel-form').onsubmit = event => {
      event.preventDefault(); const form = event.currentTarget; const patch = {};
      try {
        for (const [key, value] of Object.entries(channelConfig(this.store.channels.get(this.editId)))) {
          const input = form.elements.namedItem(key);
          patch[key] = typeof value === 'boolean' ? input.checked : typeof value === 'number' ? Number(input.value) : input.value.trim();
        }
        this.parameters.cancel(); this.store.configure(this.editId, patch); this.$('channel-dialog').close();
      } catch (error) { form.querySelector('.form-error').textContent = error.message; }
    };
    for (const btn of document.querySelectorAll('[data-close]')) btn.onclick = () => btn.closest('dialog').close();
    this.$('record').onclick = this.act(async () => {
      if (!this.transport?.connected) throw new Error('请先连接');
      this.$('record').disabled = true;
      await this.history.start(this.store.channels, performance.now()); this.refreshStatus();
    });
    this.$('stop').onclick = this.act(async () => { await this.history.stop(); this.refreshStatus(); });
    this.$('history').onclick = this.act(async () => { await this.renderSessions(); this.$('history-dialog').showModal(); });
    this.$('history-load').onclick = this.act(() => this.loadHistory());
    this.$('history-position').onchange = this.act(async () => { this.$('history-start').value = this.$('history-position').value; await this.loadHistory(); });
    this.$('inject-crc').onclick = () => this.transport?.injectCRCError();
    for (const side of ['left', 'right', 'log']) this.$(`toggle-${side}-panel`).onclick = () => {
      const key = `${side}PanelCollapsed`;
      this.config.saveUI({ [key]: !this.config.data.ui[key] }); this.restoreUI();
    };
    this.$('grouped-hex').onchange = () => this.config.saveUI({ groupedHex: this.$('grouped-hex').checked });
    this.$('logs').addEventListener('copy', event => {
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      const hex = (anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement)?.closest('.log-hex');
      if (hex && hex.contains(selection.focusNode) && event.clipboardData) {
        event.clipboardData.setData('text/plain', selection.toString().replaceAll(',', '').trim()); event.preventDefault();
      }
    });
    this.$('clear-log').onclick = () => this.logger.clear();
    this.$('log-filters').onchange = () => this.config.saveUI({ logFilters: [...this.$('log-filters').querySelectorAll('input:checked')].map(i => i.value) });
  }
  restoreUI() {
    const ui = this.config.data.ui;
    for (const side of ['left', 'right', 'log']) {
      const collapsed = ui[`${side}PanelCollapsed`], button = this.$(`toggle-${side}-panel`);
      this.root.classList.toggle(`${side}-panel-collapsed`, collapsed);
      button.textContent = side === 'left' ? (collapsed ? '▶' : '◀') : side === 'right' ? (collapsed ? '◀' : '▶') : (collapsed ? '▼' : '▲');
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute('aria-label', `${collapsed ? '展开' : '折叠'} ${side === 'left' ? 'Channels' : side === 'right' ? 'Parameter Control' : 'Communication Log'}`);
      button.title = button.getAttribute('aria-label');
    }
    this.$('channels').hidden = ui.leftPanelCollapsed; this.$('parameter-body').hidden = ui.rightPanelCollapsed;
    this.$('logs').hidden = ui.logPanelCollapsed; this.$('grouped-hex').checked = ui.groupedHex;
    this.$('baud').value = this.config.data.ui.baud;
    for (const btn of this.$('windows').children) btn.classList.toggle('selected', Number(btn.dataset.window) === this.config.data.ui.timeWindow);
    for (const input of this.$('log-filters').querySelectorAll('input')) input.checked = this.config.data.ui.logFilters.includes(input.value);
  }
  async connect(demo) {
    if (this.busy) return;
    this.busy = true; this.refreshStatus();
    try {
      await this.disconnect();
      const transport = demo ? new MockTransport() : new SerialTransport();
      this.transport = transport;
      transport.on('bytes', bytes => this.decoder.push(bytes, performance.now()));
      transport.on('error', this.error);
      transport.on('state', state => {
        this.$('connection-state').textContent = state;
        this.logger.add('WARN', `${state} · ${transport.portLabel}`);
        if (state === 'Disconnected') {
          this.parameters.cancel();
          if (this.history.session) this.history.stop().catch(this.error);
        }
        this.refreshStatus();
      });
      this.decoder.reset(); this.store.resetTimeline(); this.encoder = new ProtocolEncoder(); this.parameters.encoder = this.encoder;
      this.historySession = null; this.$('history-nav').hidden = true; this.chart.live();
      await transport.open({ baudRate: this.config.data.ui.baud });
      this.$('notice').textContent = ''; this.rebuild = true;
    } catch (error) {
      if (error.name === 'NotFoundError') this.logger.add('WARN', '用户取消串口选择');
      else throw error;
    } finally { this.busy = false; this.refreshStatus(); }
  }
  async disconnect() {
    this.parameters.cancel();
    if (this.history.session) await this.history.stop();
    if (this.transport) await this.transport.close();
    this.refreshStatus();
  }
  modeChanged(mode) {
    this.$('view-mode').textContent = mode.toUpperCase();
    this.$('live').classList.toggle('selected', mode === 'live'); this.$('pause').classList.toggle('selected', mode === 'pause');
  }
  editChannel(id) {
    this.editId = id; const c = this.store.channels.get(id); const form = this.$('channel-form');
    this.$('channel-id').textContent = hexId(id);
    for (const [key, value] of Object.entries(channelConfig(c))) {
      const input = form.elements.namedItem(key); if (typeof value === 'boolean') input.checked = value; else input.value = value;
    }
    form.querySelector('.form-error').textContent = ''; this.$('channel-dialog').showModal();
  }
  buildChannels() {
    const container = this.$('channels'); this.channelNodes.clear(); container.replaceChildren();
    for (const c of this.store.channels.values()) {
      const row = node('div', 'channel'); row.dataset.id = c.sourceId;
      const top = node('div', 'channel-top'); const eye = node('input'); eye.type = 'checkbox'; eye.checked = c.visible; eye.setAttribute('aria-label', `显示 ${c.name}`);
      eye.onchange = () => this.store.configure(c.sourceId, { visible: eye.checked });
      const swatch = node('span', 'swatch'); swatch.style.background = c.color;
      const name = node('span', 'name', c.name); name.title = c.name;
      const settings = node('button', '', '设置'); settings.onclick = () => this.editChannel(c.sourceId);
      settings.setAttribute('aria-label', `设置 ${hexId(c.sourceId)}`); top.append(eye, swatch, name, settings);
      const value = node('div', 'channel-value'); const meta = node('div', 'channel-meta'); row.append(top, value, meta); container.append(row);
      this.channelNodes.set(c.sourceId, { value, meta });
    }
    this.$('channel-count').textContent = this.store.channels.size;
  }
  buildControls() {
    const container = this.$('controls'); container.replaceChildren(); this.controlNodes.clear();
    for (const c of this.store.channels.values()) {
      if (!c.writable) continue;
      const row = node('div', 'parameter'); row.dataset.id = c.sourceId;
      const title = node('h3', '', c.name); const type = node('small', '', `${hexId(c.sourceId)} · ${typeName(c.type)}`);
      const actual = node('div', 'actual'); const slider = node('input'); slider.type = 'range'; slider.min = c.sliderMin; slider.max = c.sliderMax; slider.step = c.sliderStep;
      slider.setAttribute('aria-label', `${c.name} Slider`);
      const range = node('div', 'range-labels'); range.append(node('span', '', String(c.sliderMin)), node('span', '', String(c.sliderMax)));
      const input = node('input'); input.type = 'number'; input.step = 'any'; input.min = c.sliderMin; input.max = c.sliderMax; input.setAttribute('aria-label', `${c.name} Numeric Input`);
      input.value = Number.isFinite(c.value) ? c.value : c.sliderMin; slider.value = input.value;
      const sync = node('div', 'sync', '通过下一帧 Telemetry 确认');
      const numeric = () => {
        if (!input.value.trim()) return this.error(new Error('参数不能为空'));
        const value = Number(input.value); slider.value = value; this.parameters.finish(c.sourceId, value).catch(this.error);
      };
      slider.oninput = () => { input.value = slider.value; try { this.parameters.drag(c.sourceId, Number(slider.value)); } catch (error) { this.error(error); } };
      slider.onchange = () => { input.value = slider.value; this.parameters.finish(c.sourceId, Number(slider.value)).catch(this.error); };
      input.oninput = () => { if (input.value.trim() && Number.isFinite(Number(input.value))) slider.value = input.value; };
      input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); numeric(); } };
      row.append(title, type, actual, slider, range, input, sync); container.append(row);
      this.controlNodes.set(c.sourceId, { slider, input, actual, sync, type });
    }
    if (!this.controlNodes.size) container.append(node('p', 'empty', '暂无可写通道'));
  }
  refresh() {
    if (this.rebuild) { this.buildChannels(); this.buildControls(); this.rebuild = false; }
    for (const c of this.store.channels.values()) {
      const row = this.channelNodes.get(c.sourceId);
      if (row) {
        row.value.replaceChildren(document.createTextNode(numberText(c.value)), node('small', '', c.unit));
        row.meta.textContent = `${hexId(c.sourceId)} · ${typeName(c.type)} · ${c.axis.toUpperCase()} · RAW ${rawText(c.type, c.seen ? c.rawBits : null)}`;
      }
      const controls = this.controlNodes.get(c.sourceId); if (!controls) continue;
      const { slider, input, actual, sync, type } = controls;
      slider.disabled = input.disabled = !this.transport?.connected || !c.seen || !supported(c.type);
      type.textContent = `${hexId(c.sourceId)} · ${typeName(c.type)}`;
      actual.textContent = `Actual ${numberText(c.value)} ${c.unit} · RAW ${rawText(c.type, c.seen ? c.rawBits : null)}`;
      if (!c.requested && document.activeElement !== input && document.activeElement !== slider) { input.value = Number.isFinite(c.value) ? c.value : c.sliderMin; slider.value = input.value; }
      if (!c.requested) { sync.textContent = supported(c.type) ? '通过 Telemetry 回读同步' : typeName(c.type); sync.className = 'sync'; }
      else {
        sync.textContent = `Requested ${numberText(c.requested.value)} · ${c.requested.synced ? '✓ SYNCED' : performance.now() - c.requested.at > 2000 ? '未同步' : '等待 Telemetry'}`;
        sync.className = `sync ${c.requested.synced ? 'synced' : 'pending'}`;
      }
    }
    this.refreshStatus(); this.renderLogs();
  }
  refreshStatus() {
    const connected = !!this.transport?.connected; const recording = !!this.history.session;
    this.$('connection-state').textContent = connected ? 'Connected' : 'Disconnected';
    this.$('connection-state').classList.toggle('connected', connected); this.$('port').textContent = this.transport?.portLabel ?? '—';
    this.$('connect').disabled = this.$('demo').disabled = this.busy;
    this.$('baud').disabled = connected || this.busy; this.$('disconnect').disabled = !connected || this.busy;
    this.$('inject-crc').disabled = !(this.transport instanceof MockTransport && connected);
    this.$('record').disabled = !this.dbReady || !connected || recording; this.$('stop').disabled = !recording || this.history.stopping;
    this.$('record-status').textContent = this.history.failure ? '● 记录失败 · Stop 可重试保存' : recording ? `● RECORDING · ${this.history.session.frames} 帧` : '● 未记录';
    const stats = this.store.stats;
    for (const [id, key] of [['tx-count', 'tx'], ['seq', 'seq'], ['lost', 'lost'], ['crc', 'crc'], ['format', 'format']]) this.$(id).textContent = stats[key] ?? '—';
    const now = performance.now();
    if (!this.rateAt || now - this.rateAt >= 1000) {
      const count = stats.frames; const rate = this.rateAt && count >= this.rateFrames ? (count - this.rateFrames) * 1000 / (now - this.rateAt) : 0;
      this.$('rx-rate').textContent = connected ? rate.toFixed(1) : '0'; this.rateAt = now; this.rateFrames = count;
    }
  }
  renderLogs() {
    if (this.config.data.ui.logPanelCollapsed) return;
    const signature = `${this.logger.revision}:${this.config.data.ui.logFilters.join()}:${this.config.data.ui.groupedHex}`;
    if (signature === this.logSignature) return; this.logSignature = signature;
    const container = this.$('logs'); const bottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
    const fragment = document.createDocumentFragment();
    for (const entry of this.logger.filtered(this.config.data.ui.logFilters)) {
      const row = node('div', `log-entry ${entry.direction}`); const content = node('span', 'log-summary', entry.summary);
      if (entry.hex) {
        const hex = node('span', 'log-hex');
        if (this.config.data.ui.groupedHex) for (const segment of entry.segments) {
          const part = node('span', `hex-${segment.type}`, segment.text);
          if (segment.label) part.title = segment.label;
          hex.append(part);
        } else hex.textContent = entry.hex;
        const copy = node('button', 'copy-hex', 'Copy Raw HEX');
        copy.onclick = this.act(() => navigator.clipboard.writeText(entry.hex));
        content.append(hex, copy);
      }
      const localTime = new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false }) + '.' + entry.time.slice(20, 23);
      row.append(node('span', 'log-time', localTime), node('span', 'log-dir', entry.direction), content); fragment.append(row);
    }
    container.replaceChildren(fragment); if (bottom) container.scrollTop = container.scrollHeight;
  }
  async renderSessions() {
    const container = this.$('sessions'); container.replaceChildren();
    const sessions = await this.history.list();
    if (!sessions.length) container.append(node('p', 'empty', this.dbReady ? '暂无历史记录，连接后点击 Record' : '历史数据库不可用'));
    for (const session of sessions) {
      const row = node('div', 'session'); row.dataset.id = session.id;
      const info = node('div', 'session-info'); const name = node('input'); name.value = session.name; name.maxLength = 120; name.setAttribute('aria-label', 'Session 名称');
      info.append(name, node('small', '', `${new Date(session.startedAt).toLocaleString()} · ${session.duration.toFixed(2)}s · ${session.frames} frames / ${session.samples} samples · ${session.status}`)); row.append(info);
      const button = (label, action) => { const b = node('button', '', label); b.onclick = this.act(async () => { b.disabled = true; try { await action(); } finally { b.disabled = false; } }); row.append(b); return b; };
      const active = session.id === this.history.session?.id;
      button('重命名', async () => { await this.history.rename(session.id, name.value); await this.renderSessions(); });
      button('查看', async () => {
        this.historySession = session; this.$('history-start').value = 0; this.$('history-position').max = session.duration;
        this.$('history-nav').hidden = false; await this.loadHistory(); this.$('history-dialog').close();
      }).disabled = active;
      button('导出 CSV', async () => {
        const blob = await this.history.csv(session); const url = URL.createObjectURL(blob);
        const a = node('a'); a.href = url; a.download = `fpga-${session.id}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
        this.logger.add('WARN', `CSV 已导出 · ${session.frames} 帧`);
      }).disabled = active;
      const remove = button('删除', async () => {
        if (remove.dataset.confirm !== 'yes') { remove.dataset.confirm = 'yes'; remove.textContent = '再次点击删除'; return; }
        await this.history.remove(session.id);
        if (this.historySession?.id === session.id) this.$('live').click();
        await this.renderSessions();
      }); remove.disabled = active;
      container.append(row);
    }
  }
  async loadHistory() {
    const session = this.historySession; if (!session) return;
    const start = Number(this.$('history-start').value);
    if (!Number.isFinite(start) || start < 0 || start > session.duration) throw new Error('历史起点超出 Session 时间范围');
    const end = Math.min(session.duration, start + this.config.data.ui.timeWindow);
    const generation = this.historyGeneration = (this.historyGeneration ?? 0) + 1;
    const rows = await this.history.window(session.id, start, Math.max(start, end));
    if (generation !== this.historyGeneration || session !== this.historySession) return;
    this.$('history-position').value = start; this.$('history-caption').textContent = session.name;
    this.chart.showHistory(session, rows, start, Math.max(start + 0.02, end));
  }
  dispose() {
    clearInterval(this.refreshTimer); this.chart.dispose(); this.parameters.cancel();
    window.removeEventListener('beforeunload', this.unload); document.removeEventListener('visibilitychange', this.visibility);
    return this.disconnect();
  }
}
