import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { ChartController, decimate } from '../src/chart/ChartController.js';
import { ConfigStore } from '../src/store/ConfigStore.js';
import { ChannelStore } from '../src/store/ChannelStore.js';
vi.mock('echarts/core', () => ({ use: () => {}, init: () => ({
  option: {}, handlers: {}, on(name, handler) { this.handlers[name] = handler; },
  setOption: vi.fn(function(option) { this.option = option; }), getOption() { return this.option; },
  containPixel: (_, [x, y]) => x >= 70 && x <= 930 && y >= 42 && y <= 422,
  convertFromPixel({ xAxisIndex, yAxisIndex }, pixel) {
    if (xAxisIndex === 0) {
      const zoom = this.option.dataZoom[0];
      return zoom.startValue + (pixel - 70) / 860 * (zoom.endValue - zoom.startValue);
    }
    const axis = this.option.yAxis[yAxisIndex];
    const min = axis.min ?? (yAxisIndex === 0 ? -100 : -1);
    const max = axis.max ?? (yAxisIndex === 0 ? 100 : 1);
    return max - (pixel - 42) / 380 * (max - min);
  },
  resize: vi.fn(), dispose: vi.fn(),
}) }));
let controller, config, store, element, onMode;
const receive = (seq, seconds, value = seq) => store.ingest({ seq, hostReceiveTime: seconds * 1000,
  samples: [{ sourceId: 1, type: 1, rawBits: value >>> 0, rawValue: value, value }] });
const slider = (min, max) => {
  Object.assign(controller.chart.option.dataZoom[0], { startValue: min, endValue: max });
  controller.chart.handlers.datazoom();
};
const pointer = (x = 200, y = 200, patch = {}) => ({ clientX: x + 100, clientY: y + 50, pointerId: 1, button: 0, buttons: 1, ...patch });
const wheel = (x, y, deltaY = -300, patch = {}) => {
  const event = { ...pointer(x, y), deltaY, deltaMode: 0, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...patch };
  controller.wheel(event); controller.render(); return event;
};
const valuesAt = (x, y) => [controller.chart.convertFromPixel({ xAxisIndex: 0 }, x),
  ...[0, 1].map(yAxisIndex => controller.chart.convertFromPixel({ yAxisIndex }, y))];
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} });
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  element = { dataset: {}, clientHeight: 500, clientWidth: 1000, classList: { add: vi.fn(), remove: vi.fn() },
    getBoundingClientRect: () => ({ left: 100, top: 50 }), addEventListener: vi.fn(), removeEventListener: vi.fn() };
  config = new ConfigStore({ getItem: () => null, setItem: () => {} });
  store = new ChannelStore(config); store.resetTimeline(0); receive(0, 10, 10); receive(1, 11, 11);
  onMode = vi.fn(); controller = new ChartController(element, store, config, onMode); controller.loop(40);
});
afterEach(() => { controller.dispose(); vi.unstubAllGlobals(); });
describe('VOFA-style chart navigation', () => {
  it('slider zoom stays LIVE and advances its displayed range and actual samples at a fixed scale', () => {
    slider(6, 11); expect(controller.mode).toBe('live'); expect(onMode).not.toHaveBeenCalled();
    receive(2, 12, 12); controller.loop(80);
    expect(controller.chart.option.series[0].data.at(-1)).toEqual([12, 12]);
    expect(controller.chart.option.dataZoom[0]).toMatchObject({ startValue: 7, endValue: 12 });
    receive(3, 13, 13); controller.loop(120);
    expect(controller.timeRange()).toEqual({ min: 8, max: 13 });
    expect(controller.chart.option.series[0].data.at(-1)).toEqual([13, 13]);
  });
  it('plot wheel scales X and both Y around a non-central mouse point without requiring modifier keys', () => {
    const before = valuesAt(285, 137), width = controller.timeRange().max - controller.timeRange().min;
    wheel(285, 137);
    valuesAt(285, 137).forEach((value, index) => expect(value).toBeCloseTo(before[index], 10));
    expect(controller.timeRange().max - controller.timeRange().min).toBeCloseTo(width * Math.exp(-0.3));
    const [left, right] = controller.chart.option.yAxis;
    expect(left.max - left.min).toBeCloseTo(200 * Math.exp(-0.3));
    expect(right.max - right.min).toBeCloseTo(2 * Math.exp(-0.3));
    expect(controller.mode).toBe('live');
  });
  it('wheel over X labels scales only X, while each Y axis scales only that axis', () => {
    const before = valuesAt(400, 180); wheel(400, 440);
    expect(controller.yView).toEqual([null, null]); expect(valuesAt(400, 180)[0]).toBeCloseTo(before[0]);
    const time = { ...controller.timeRange() };
    wheel(35, 180); expect(controller.timeRange()).toEqual(time); expect(controller.yView[0]).not.toBeNull(); expect(controller.yView[1]).toBeNull();
    expect(valuesAt(400, 180)[1]).toBeCloseTo(before[1]);
    const left = { ...controller.yView[0] };
    wheel(965, 180); expect(controller.timeRange()).toEqual(time); expect(controller.yView[0]).toEqual(left);
    expect(controller.yView[1]).not.toBeNull(); expect(valuesAt(400, 180)[2]).toBeCloseTo(before[2]);
  });
  it('zoom out reverses zoom in at the same anchor and ignores header/overview wheel events', () => {
    const time = controller.timeRange(); wheel(350, 150, -300); wheel(350, 150, 300);
    expect(controller.timeRange().min).toBeCloseTo(time.min); expect(controller.timeRange().max).toBeCloseTo(time.max);
    expect(controller.yView[0].min).toBeCloseTo(-100); expect(controller.yView[0].max).toBeCloseTo(100);
    const ignored = wheel(350, 480); expect(ignored.preventDefault).not.toHaveBeenCalled();
    expect(wheel(350, 10).preventDefault).not.toHaveBeenCalled();
  });
  it('left drag freely pans both axes beyond the original domain and retains spans and live updates', () => {
    controller.pointerDown(pointer()); controller.pointerMove(pointer(1060, 238)); controller.pointerUp(); controller.render();
    expect(controller.timeRange()).toEqual({ min: -9, max: 1 }); // Full-width drag beyond time zero.
    const [left, right] = controller.chart.option.yAxis;
    expect(left.min).toBeCloseTo(-80); expect(left.max).toBeCloseTo(120);
    expect(right.min).toBeCloseTo(-0.8); expect(right.max).toBeCloseTo(1.2);
    expect(controller.chart.option.series[0].data).toEqual([]); // No fabricated samples in empty space.
    receive(2, 12, 12); controller.loop(80); expect(controller.timeRange()).toEqual({ min: -8, max: 2 });
    expect(controller.mode).toBe('live'); expect(config.data.ui.left.mode).toBe('auto');
  });
  it('panning backwards displays older retained samples outside the default current window', () => {
    receive(2, 20, 20); controller.render();
    controller.pointerDown(pointer()); controller.pointerMove(pointer(630, 200)); controller.pointerUp(); controller.render();
    expect(controller.timeRange()).toEqual({ min: 5, max: 15 });
    expect(controller.chart.option.series[0].data).toEqual([[10, 10], [11, 11]]);
  });
  it('dragging back to its starting pixel restores both axes instead of leaving the last offset', () => {
    const time = controller.timeRange();
    controller.pointerDown(pointer()); controller.pointerMove(pointer(500, 250)); controller.render();
    controller.pointerMove(pointer()); controller.pointerUp(); controller.render();
    expect(controller.timeRange()).toEqual(time);
    expect(controller.yView).toEqual([{ min: -100, max: 100 }, { min: -1, max: 1 }]);
  });
  it('PAUSE freezes samples and time through wheel, repeated pause and time-window changes', () => {
    controller.pause(); receive(2, 12, 99); wheel(400, 232); const range = controller.timeRange(); controller.pause(); controller.loop(80);
    expect(controller.referenceEnd()).toBe(11); expect(store.channels.get(1).value).toBe(99);
    expect(controller.chart.option.series[0].data.every(point => point[0] <= 11)).toBe(true);
    config.saveUI({ timeWindow: 5 }); controller.resetView(); controller.loop(120);
    expect(controller.timeRange()).toEqual({ min: 6, max: 11 }); expect(range.max).toBeLessThan(11);
    controller.live(); controller.loop(160); expect(controller.chart.option.series[0].data.at(-1)).toEqual([12, 99]);
    expect(controller.xView).toBeNull();
  });
  it('PAUSE filters before plotting and expands its frozen window without new samples', () => {
    receive(2, 12, 12); config.saveUI({ timeWindow: 1 }); controller.pause(); controller.loop(80);
    expect(controller.chart.option.series[0].data).toEqual([[11, 11], [12, 12]]);
    receive(3, 13, 13); config.saveUI({ timeWindow: 5 }); controller.resetView(); controller.loop(120);
    expect(controller.chart.option.series[0].data).toEqual([[10, 10], [11, 11], [12, 12]]);
  });
  it('outside-grid/right-button/other-pointer moves leave the view unchanged; release clears the grab cursor', () => {
    controller.pointerDown(pointer(200, 10)); controller.pointerMove(pointer(500, 80)); expect(controller.xView).toBeNull();
    controller.pointerDown(pointer(200, 200, { button: 2 })); controller.pointerMove(pointer(500, 200)); expect(controller.xView).toBeNull();
    controller.pointerDown(pointer()); controller.pointerMove(pointer(600, 250, { pointerId: 2 })); expect(controller.xView).toBeNull();
    controller.pointerMove(pointer(600, 250, { buttons: 0 })); expect(controller.drag).toBeNull();
    expect(element.classList.remove).toHaveBeenCalledWith('panning');
  });
  it('RESET VIEW restores configured axes without changing PAUSE; applying Y settings clears only Y navigation', () => {
    config.saveUI({ left: { mode: 'manual', min: -20, max: 80 } }); controller.render(); wheel(400, 232); controller.pause();
    controller.resetView(); controller.loop(80); expect(controller.mode).toBe('pause'); expect(controller.xView).toBeNull();
    expect(controller.chart.option.yAxis[0]).toMatchObject({ min: -20, max: 80 });
    wheel(400, 232); const time = controller.timeRange();
    config.saveUI({ left: { mode: 'manual', min: -50, max: 50 } }); controller.resetYAxis(); controller.loop(120);
    expect(controller.chart.option.yAxis[0]).toMatchObject({ min: -50, max: 50 }); expect(controller.timeRange()).toEqual(time);
  });
  it('history remains bounded, stays in history through navigation, and LIVE discards its viewport', () => {
    controller.showHistory({ channels: { 1: { ...store.channels.get(1) } } }, new Map([[1, [{ time: 1, value: 5 }]]]), 0, 5);
    controller.loop(80); wheel(400, 232); receive(2, 12, 99);
    expect(controller.mode).toBe('history'); expect(controller.referenceEnd()).toBe(5);
    controller.live(); controller.loop(160); expect(controller.chart.option.series[0].data.at(-1)).toEqual([12, 99]); expect(controller.xView).toBeNull();
  });
  it('rejects non-finite or collapsed X ranges without poisoning the current view', () => {
    controller.setXRange({ min: NaN, max: 10 }); controller.setXRange({ min: 0, max: Infinity });
    controller.setXRange({ min: 1, max: 1 }); expect(controller.xView).toBeNull();
  });
  it('dispose removes global gesture listeners', () => {
    controller.dispose(); expect(window.removeEventListener).toHaveBeenCalledWith('pointermove', controller.pointerMove);
    expect(element.removeEventListener).toHaveBeenCalledWith('wheel', controller.wheel, true);
  });
  it('panel resize resizes ECharts and invalidates a paused viewport without changing navigation', () => {
    controller.pause(); slider(6, 11); controller.render(); controller.dirty = false;
    controller.resize.callback(); expect(controller.chart.resize).toHaveBeenCalledTimes(1); expect(controller.dirty).toBe(true);
    expect(controller.mode).toBe('pause'); expect(controller.timeRange()).toEqual({ min: 6, max: 11 });
  });
  it('non-finite RX values produce gaps in live, pause and history without poisoning stored values', () => {
    receive(2, 12, NaN); receive(3, 13, Infinity); receive(4, 14, -Infinity); receive(5, 15, 1);
    for (const mode of ['live', 'pause', 'history']) {
      if (mode === 'pause') controller.pause();
      if (mode === 'history') controller.showHistory({ channels: { 1: { ...store.channels.get(1) } } }, new Map([[1, store.channels.get(1).points.values()]]), 10, 15);
      controller.render(); expect(controller.chart.option.series[0].data).toEqual([[10, 10], [11, 11], [12, null], [13, null], [14, null], [15, 1]]);
      expect(controller.chart.option.tooltip.formatter([{ axisValue: 13 }])).toContain('—');
    }
    expect(store.channels.get(1).points.values()[2].value).toBeNaN();
  });
  it('bounded decimation preserves finite spikes and invalid gaps even at bucket starts', () => {
    const points = Array.from({ length: 20000 }, (_, time) => ({ time, value: time % 20 === 0 ? NaN : time === 10001 ? 1000 : time === 10002 ? -1000 : 0 }));
    const data = decimate(points); expect(data.length).toBeLessThanOrEqual(3000);
    expect(data.some(p => !Number.isFinite(p.value))).toBe(true); expect(data.some(p => p.value === 1000)).toBe(true); expect(data.some(p => p.value === -1000)).toBe(true);
  });
});
