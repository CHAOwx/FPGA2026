/**
 * Responsibility: One ECharts plot, independent 25 FPS rendering, live/pause and history navigation.
 * Allowed dependencies: ECharts, ChannelStore, ConfigStore, ValueCodec display labels.
 * Forbidden responsibilities: UART, protocol parsing, persistence transactions, RAW conversion.
 * Public API: live(), pause(), resetView(), resetYAxis(), invalidate(), showHistory(), dispose().
 * Architecture invariants: Receive never calls setOption; history input is a bounded time window.
 */
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, DataZoomComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
echarts.use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);
const grid = { left: 70, right: 70, top: 42, bottom: 78 };
export function decimate(points, budget = 3000) {
  if (points.length <= budget) return points;
  const result = [];
  const gaps = points.some(p => !Number.isFinite(p.value));
  const step = Math.ceil(points.length / (budget / (gaps ? 3 : 2)));
  for (let i = 0; i < points.length; i += step) {
    let min = null, max = null, gap = null;
    for (let j = i; j < Math.min(i + step, points.length); j++) {
      const p = points[j];
      if (!Number.isFinite(p.value)) { gap ??= p; continue; }
      if (!min || p.value < min.value) min = p;
      if (!max || p.value > max.value) max = p;
    }
    result.push(...[...new Set([min, max, gap])].filter(Boolean).sort((a, b) => a.time - b.time));
  }
  return result;
}
export class ChartController {
  constructor(element, store, config, onMode) {
    Object.assign(this, { element, store, config, onMode });
    this.chart = echarts.init(element, null, { renderer: 'canvas' }); this.mode = 'live'; this.dirty = true;
    this.resize = new ResizeObserver(() => { this.chart.resize(); this.invalidate(); }); this.resize.observe(element);
    this.xView = null; this.yView = [null, null];
    this.chart.on('datazoom', () => {
      const zoom = this.chart.getOption().dataZoom?.[0];
      if (zoom) this.setXRange({ min: zoom.startValue, max: zoom.endValue });
    });
    this.bindNavigation();
    this.loop = now => {
      this.raf = requestAnimationFrame(this.loop);
      if (now - (this.last ?? 0) < 40) return;
      this.last = now;
      if (this.mode === 'live' || this.dirty) { this.render(); this.dirty = false; }
    };
    this.raf = requestAnimationFrame(this.loop);
  }
  invalidate() { this.dirty = true; }
  resetYAxis() { this.yView = [null, null]; this.drag = null; this.element.classList.remove('panning'); this.dirty = true; }
  resetView() { this.xView = null; this.resetYAxis(); }
  live() { this.mode = 'live'; this.history = null; this.frozen = null; this.resetView(); this.onMode('live'); }
  pause() {
    if (this.mode === 'history') return;
    if (this.mode === 'pause') return;
    this.frozenEnd = this.store.latestTime; this.mode = 'pause';
    this.frozen = new Map([...this.store.channels].map(([id, c]) => [id, c.points.values()]));
    this.onMode('pause'); this.dirty = true;
  }
  showHistory(session, rows, min, max) {
    this.history = { session, rows, min, max }; this.mode = 'history'; this.frozen = null; this.resetView(); this.onMode('history');
  }
  point(event) {
    const rect = this.element.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }
  referenceEnd() { return this.mode === 'live' ? this.store.latestTime : this.mode === 'pause' ? this.frozenEnd : this.history.max; }
  timeRange() {
    const end = this.referenceEnd();
    if (this.xView) return { min: end + this.xView.min, max: end + this.xView.max };
    const min = this.mode === 'history' ? this.history.min : Math.max(0, end - this.config.data.ui.timeWindow);
    return { min, max: Math.max(min + 0.02, end) };
  }
  setXRange(range) {
    if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max - range.min < 1e-6 || range.max - range.min > 1e8) return;
    const end = this.referenceEnd();
    this.xView = { min: range.min - end, max: range.max - end }; this.dirty = true;
  }
  navigationRegion([x, y]) {
    const right = this.element.clientWidth - grid.right, bottom = this.element.clientHeight - grid.bottom;
    if (x >= grid.left && x <= right) {
      if (y >= grid.top && y <= bottom) return 'plot';
      if (y > bottom && y < this.element.clientHeight - 44) return 'x';
    }
    if (y >= grid.top && y <= bottom) {
      if (x >= 0 && x < grid.left) return 'left';
      if (x > right && x <= this.element.clientWidth) return 'right';
    }
    return null;
  }
  axisRanges() {
    const bottom = this.element.clientHeight - grid.bottom;
    return [0, 1].map(yAxisIndex => {
      const min = this.chart.convertFromPixel({ yAxisIndex }, bottom);
      const max = this.chart.convertFromPixel({ yAxisIndex }, grid.top);
      return Number.isFinite(min) && Number.isFinite(max) && min < max ? { min, max } : null;
    });
  }
  bindNavigation() {
    // Local view ranges allow free panning; the overview slider remains bounded to its domain.
    this.pointerDown = event => {
      if (event.button !== 0 || !this.chart.containPixel({ gridIndex: 0 }, this.point(event))) return;
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, ranges: this.axisRanges(),
        time: this.timeRange(), end: this.referenceEnd(),
        width: this.element.clientWidth - grid.left - grid.right,
        height: this.element.clientHeight - grid.top - grid.bottom };
      this.element.classList.add('panning');
    };
    this.pointerMove = event => {
      if (!this.drag || this.drag.id !== event.pointerId) return;
      if (!(event.buttons & 1)) { this.pointerUp(); return; }
      const dx = event.clientX - this.drag.x;
      const delta = event.clientY - this.drag.y;
      if (!this.drag.moved && Math.abs(dx) < 2 && Math.abs(delta) < 2) return;
      this.drag.moved = true;
      if (this.drag.width > 0) {
        const shift = dx / this.drag.width * (this.drag.time.max - this.drag.time.min);
        this.xView = { min: this.drag.time.min - this.drag.end - shift, max: this.drag.time.max - this.drag.end - shift };
      }
      if (this.drag.height > 0) this.yView = this.drag.ranges.map(range => {
        if (!range) return null;
        const shift = delta / this.drag.height * (range.max - range.min);
        const min = range.min + shift, max = range.max + shift;
        return Number.isFinite(min) && Number.isFinite(max) && min < max ? { min, max } : range;
      });
      this.dirty = true;
    };
    this.pointerUp = () => { this.drag = null; this.element.classList.remove('panning'); };
    this.wheel = event => {
      const point = this.point(event);
      const region = this.navigationRegion(point);
      if (!region) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.element.clientHeight : 1);
      const factor = Math.exp(Math.max(-1, Math.min(1, pixels * 0.001)));
      if (region === 'plot' || region === 'x') {
        const range = this.timeRange();
        const anchor = this.chart.convertFromPixel({ xAxisIndex: 0 }, point[0]);
        this.setXRange({ min: anchor + (range.min - anchor) * factor, max: anchor + (range.max - anchor) * factor });
      }
      if (region !== 'x') this.yView = this.axisRanges().map((range, yAxisIndex) => {
        if (region === 'left' && yAxisIndex !== 0 || region === 'right' && yAxisIndex !== 1) return this.yView[yAxisIndex];
        if (!range) return null;
        const anchor = this.chart.convertFromPixel({ yAxisIndex }, point[1]);
        const min = anchor + (range.min - anchor) * factor, max = anchor + (range.max - anchor) * factor;
        return Number.isFinite(min) && Number.isFinite(max) && min < max ? { min, max } : range;
      });
      this.dirty = true;
    };
    this.element.addEventListener('pointerdown', this.pointerDown);
    this.element.addEventListener('wheel', this.wheel, { capture: true, passive: false });
    window.addEventListener('pointermove', this.pointerMove);
    window.addEventListener('pointerup', this.pointerUp);
    window.addEventListener('pointercancel', this.pointerUp);
    window.addEventListener('blur', this.pointerUp);
  }
  render() {
    const ui = this.config.data.ui;
    const end = this.referenceEnd();
    const view = this.timeRange();
    const min = view.min, max = view.max;
    const channels = this.mode === 'history' ? Object.values(this.history.session.channels) : [...this.store.channels.values()];
    const series = channels.filter(c => c.visible).map(c => {
      const points = this.mode === 'history' ? (this.history.rows.get(c.sourceId) ?? []).filter(p => p.time >= min && p.time <= max)
        : this.mode === 'pause' ? (this.frozen.get(c.sourceId) ?? []).filter(p => p.time >= min && p.time <= max) : c.points.values(min, max);
      return { id: String(c.sourceId), name: c.name + (c.unit ? ` [${c.unit}]` : ''), type: 'line', yAxisIndex: c.axis === 'right' ? 1 : 0,
        showSymbol: false, connectNulls: false, animation: false, lineStyle: { width: 1.5, color: c.color }, itemStyle: { color: c.color },
        data: decimate(points).map(p => [p.time, Number.isFinite(p.value) ? p.value : null]) };
    });
    const axis = (a, name, position, view) => ({ type: 'value', name, position, scale: true,
      min: view?.min ?? (a.mode === 'manual' ? a.min : null), max: view?.max ?? (a.mode === 'manual' ? a.max : null),
      axisLabel: { color: '#526174', fontSize: 11, formatter: v => Number(v.toPrecision(7)).toString() }, nameTextStyle: { color: '#526174' },
      splitLine: { show: position === 'left', lineStyle: { color: '#d6dce4', type: 'dashed' } } });
    // Recalculate absolute slider bounds from relative view offsets on every live repaint.
    const zoom = { startValue: min, endValue: max, rangeMode: ['value', 'value'] };
    this.chart.setOption({ animation: false, backgroundColor: '#ffffff', textStyle: { color: '#263445' },
      grid,
      tooltip: { trigger: 'axis', confine: true, renderMode: 'richText', backgroundColor: '#ffffff', borderColor: '#cbd5df', textStyle: { color: '#263445' },
        formatter: params => {
          const time = Number(params[0]?.axisValue ?? 0);
          return [`Time  ${time.toFixed(3)} s`, ...series.map(s => {
            const data = s.data; let low = 0, high = data.length;
            while (low < high) { const mid = (low + high) >>> 1; if (data[mid][0] < time) low = mid + 1; else high = mid; }
            const a = data[Math.min(low, data.length - 1)], b = data[Math.max(0, low - 1)];
            const nearest = a && b ? Math.abs(a[0] - time) < Math.abs(b[0] - time) ? a : b : a ?? b;
            return `${s.name}  ${nearest?.[1] == null ? '—' : Number(nearest[1]).toPrecision(8)}`;
          })].join('\n');
        },
        valueFormatter: v => v == null ? '—' : Number(v).toPrecision(8), axisPointer: { type: 'cross', label: { precision: 3 } } },
      xAxis: { type: 'value', name: 'Host time (s)', nameLocation: 'middle', nameGap: 28,
        min: Math.min(min, this.mode === 'history' ? this.history.min : Math.max(0, end - ui.timeWindow)),
        max: Math.max(max, end), axisLabel: { color: '#526174', formatter: v => `${Number(v.toFixed(6))} s` }, splitLine: { lineStyle: { color: '#d6dce4', type: 'dashed' } } },
      yAxis: [axis(ui.left, 'LEFT Y', 'left', this.yView[0]), axis(ui.right, 'RIGHT Y', 'right', this.yView[1])],
      dataZoom: [{ id: 'time-slider', type: 'slider', xAxisIndex: 0, filterMode: 'none', height: 18, bottom: 12, borderColor: '#cbd5df', backgroundColor: '#f3f6fa', fillerColor: '#1677c822', dataBackground: { lineStyle: { color: '#8da5bf' }, areaStyle: { color: '#d6e2ef' } }, selectedDataBackground: { lineStyle: { color: '#1677c8' }, areaStyle: { color: '#c3dcf2' } }, textStyle: { color: '#526174' }, ...zoom }],
      series,
    }, { replaceMerge: ['series'], lazyUpdate: true });
    this.element.dataset.mode = this.mode; this.element.dataset.end = String(end);
  }
  dispose() {
    cancelAnimationFrame(this.raf); this.resize.disconnect();
    this.element.removeEventListener('pointerdown', this.pointerDown);
    this.element.removeEventListener('wheel', this.wheel, true);
    window.removeEventListener('pointermove', this.pointerMove);
    window.removeEventListener('pointerup', this.pointerUp);
    window.removeEventListener('pointercancel', this.pointerUp);
    window.removeEventListener('blur', this.pointerUp);
    this.chart.dispose();
  }
}
