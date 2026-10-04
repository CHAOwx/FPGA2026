/**
 * Responsibility: Versioned, validated localStorage configuration with safe fallback.
 * Allowed dependencies: None.
 * Forbidden responsibilities: Telemetry history, serial permission objects, DOM.
 * Public API: data, channel(), saveChannel(), saveUI(), validateChannel(), validateUI().
 * Architecture invariants: v1 schema remains stable; persistence errors surface through onError.
 */
export const CONFIG_KEY = 'fpga-monitor-config-v1';
export const PALETTE = ['#1479c9', '#15966d', '#d28418', '#8552c1', '#d33b76', '#088b9c', '#4968ce', '#997c14'];
const defaults = () => ({ version: 1, channels: {}, ui: {
  baud: 115200, timeWindow: 10, logFilters: ['RX', 'TX', 'ERR', 'WARN'],
  leftPanelCollapsed: false, rightPanelCollapsed: false, logPanelCollapsed: false, groupedHex: true,
  left: { mode: 'auto', min: -1, max: 1 }, right: { mode: 'auto', min: -1, max: 1 },
} });
export function validateChannel(c) {
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 120) throw new Error('通道名称需为 1–120 个字符');
  if (typeof c.unit !== 'string' || c.unit.length > 40) throw new Error('单位最多 40 个字符');
  if (!/^#[0-9a-f]{6}$/i.test(c.color) || !['left', 'right'].includes(c.axis)) throw new Error('颜色或轴配置无效');
  if (typeof c.visible !== 'boolean' || typeof c.writable !== 'boolean') throw new Error('显示或可写配置无效');
  if (![c.sliderMin, c.sliderMax, c.sliderStep].every(Number.isFinite) || c.sliderMin >= c.sliderMax || c.sliderStep <= 0) throw new Error('Slider 要求有限 Min < Max，Step > 0');
  return Object.fromEntries(['name', 'unit', 'visible', 'color', 'axis', 'writable', 'sliderMin', 'sliderMax', 'sliderStep'].map(key => [key, c[key]]));
}
export function validateUI(ui) {
  if (![9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].includes(ui.baud)) throw new Error('不支持的波特率');
  if (![1, 5, 10, 30, 60].includes(ui.timeWindow)) throw new Error('时间窗无效');
  for (const a of [ui.left, ui.right]) {
    if (!a || !['auto', 'manual'].includes(a.mode) || ![a.min, a.max].every(Number.isFinite) || a.min >= a.max) throw new Error('Y 轴要求有限 Min < Max');
  }
  if (!Array.isArray(ui.logFilters) || ui.logFilters.some(f => !['RX', 'TX', 'ERR', 'WARN'].includes(f))) throw new Error('日志过滤配置无效');
  for (const key of ['leftPanelCollapsed', 'rightPanelCollapsed', 'logPanelCollapsed', 'groupedHex']) {
    if (typeof ui[key] !== 'boolean') throw new Error('面板或 HEX 显示配置无效');
  }
  return ui;
}
export class ConfigStore {
  constructor(storage = globalThis.localStorage, onError = () => {}) {
    this.storage = storage;
    this.onError = onError;
    this.data = defaults();
    try {
      const text = storage?.getItem(CONFIG_KEY);
      if (!text) return;
      const saved = JSON.parse(text);
      if (saved.version !== 1 || !saved.channels || typeof saved.channels !== 'object') throw new Error('配置版本不支持，已安全使用默认值');
      this.data.ui = validateUI({ ...this.data.ui, ...saved.ui });
      for (const [id, c] of Object.entries(saved.channels)) {
        try {
          if (!/^\d+$/.test(id) || Number(id) > 255) throw new Error('Invalid ID');
          this.data.channels[id] = validateChannel(c);
        } catch (error) { onError(error); }
      }
    } catch (error) { this.data = defaults(); onError(error); }
  }
  channel(id) { return this.data.channels[id]; }
  saveChannel(id, config) { this.data.channels[id] = { ...validateChannel(config) }; this.persist(); }
  saveUI(patch) { this.data.ui = validateUI({ ...this.data.ui, ...patch }); this.persist(); }
  persist() { try { this.storage?.setItem(CONFIG_KEY, JSON.stringify(this.data)); } catch (error) { this.onError(error); } }
}
