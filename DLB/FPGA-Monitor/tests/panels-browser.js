// Browser acceptance: fresh Playwright context, Vite dev at localhost:5173.
// This script clears only the isolated test context's configuration.
async page => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  const geometry = () => page.evaluate(async () => {
    const echarts = await import('/node_modules/.vite/deps/echarts_core.js');
    const element = document.querySelector('#chart'), chart = echarts.getInstanceByDom(element);
    const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    return { chart: box('#chart'), left: box('.channels-panel'), right: box('.control-panel'), log: box('.log-panel'),
      canvas: [chart.getWidth(), chart.getHeight()], mode: element.dataset.mode,
      overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
      range: chart.getOption().dataZoom[0], series: chart.getOption().series.map(s => ({ name: s.name, axis: s.yAxisIndex, data: s.data })),
      config: JSON.parse(localStorage.getItem('fpga-monitor-config-v1')) };
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  for (const [width, height] of [[1920, 1080], [1366, 768]]) {
    await page.setViewportSize({ width, height }); await page.goto('http://127.0.0.1:5173');
    await page.evaluate(() => localStorage.clear()); await page.reload(); await page.locator('#demo').click();
    await page.waitForFunction(() => document.querySelector('#channel-count').textContent === '7');
    const float = page.locator('.channel[data-id="32"]');
    assert((await float.innerText()).includes('FLOAT32') && (await float.innerText()).includes('RAW 0x'), 'FLOAT32 discovery and bit display');
    await float.getByRole('button', { name: '设置' }).click();
    await page.locator('#channel-form input[name="writable"]').check();
    await page.locator('#channel-form select[name="axis"]').selectOption('right');
    await page.locator('#channel-form input[name="sliderMin"]').fill('-1');
    await page.locator('#channel-form button[type="submit"]').click();
    const input = page.locator('.parameter[data-id="32"] input[type="number"]');
    await input.fill('0.25'); await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('.parameter[data-id="32"] .sync')?.textContent.includes('SYNCED'));
    await page.waitForFunction(() => document.querySelector('.log-entry.TX .log-hex')?.textContent.includes('20 05 00 00 80 3E'));
    const tx = page.locator('.log-entry.TX').last();
    const groups = await tx.locator('.hex-data').allTextContents();
    assert(groups[5] === '20 05 00 00 80 3E' && groups.length === 7, 'TX grouped payload');
    const colors = await tx.evaluate(row => [getComputedStyle(row.querySelector('.hex-data')).color, getComputedStyle(row.querySelector('.hex-separator')).color]);
    assert(colors[0] !== colors[1], 'HEX and comma colors differ');
    await tx.getByRole('button', { name: 'Copy Raw HEX' }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert(copied.includes('20 05 00 00 80 3E') && !copied.includes(','), 'copy button copies unmodified raw HEX');
    // Selecting grouped HEX also strips visual separators via the copy handler.
    const selectionCopy = await tx.locator('.log-hex').evaluate(hex => {
      const range = document.createRange(); range.selectNodeContents(hex); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      const event = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
      hex.dispatchEvent(event); const text = event.clipboardData.getData('text/plain'); selection.removeAllRanges(); return text;
    });
    assert(selectionCopy === copied, 'selected grouped HEX copies raw bytes');
    const txBefore = await page.locator('#tx-count').innerText(); await input.fill('2'); await input.press('Enter'); await page.waitForTimeout(240);
    assert(await page.locator('#tx-count').innerText() === txBefore, 'out-of-range FLOAT32 is not transmitted');
    await input.fill('0.25');
    await page.locator('#grouped-hex').uncheck(); await page.waitForTimeout(240);
    assert(await page.locator('.hex-separator').count() === 0, 'raw view has no commas');
    await page.locator('#grouped-hex').check(); await page.waitForTimeout(240);
    const rxGroups = await page.locator('.log-entry.RX').last().locator('.hex-data').allTextContents();
    assert(rxGroups.length === 14 && rxGroups.slice(6, -1).every(s => s.split(' ').length === 6), 'seven Telemetry parameters each have six bytes');
    await page.locator('#pause').click(); await page.waitForTimeout(200);
    const base = await geometry(), frozenEnd = await page.locator('#chart').getAttribute('data-end');
    assert(base.series.find(s => s.name === 'Channel 0x20').axis === 1, 'FLOAT32 right Y axis');
    const combinations = [];
    for (let mask = 0; mask < 8; mask++) {
      for (const [side, bit] of [['left', 1], ['right', 2], ['log', 4]]) {
        const toggle = page.locator(`#toggle-${side}-panel`), collapsed = await toggle.getAttribute('aria-expanded') === 'false';
        if (collapsed !== !!(mask & bit)) await toggle.click();
      }
      await page.waitForTimeout(240); const state = await geometry();
      assert(!state.overflow, `${width} mask ${mask}: viewport overflow`);
      assert(state.canvas[0] === state.chart.width && state.canvas[1] === state.chart.height, `${width} mask ${mask}: ECharts resized`);
      assert(state.chart.x >= state.left.right && state.chart.right <= state.right.x, 'panels do not overlap chart');
      assert(state.mode === 'pause' && await page.locator('#chart').getAttribute('data-end') === frozenEnd, 'resize preserves PAUSE');
      const expectedWidth = base.chart.width + (mask & 1 ? base.left.width - 34 : 0) + (mask & 2 ? base.right.width - 34 : 0);
      assert(Math.abs(state.chart.width - expectedWidth) < 1, 'chart consumes released side width');
      assert(Math.abs(state.chart.height - base.chart.height - (mask & 4 ? base.log.height - 38 : 0)) < 1, 'chart consumes released log height');
      combinations.push({ mask, chart: [state.chart.width, state.chart.height] });
    }
    await page.locator('#grouped-hex').uncheck();
    const saved = (await geometry()).config;
    await page.reload(); await page.waitForTimeout(250);
    for (const side of ['left', 'right', 'log']) assert(await page.locator(`#toggle-${side}-panel`).getAttribute('aria-expanded') === 'false', 'collapsed state survives refresh');
    assert(!(await page.locator('#grouped-hex').isChecked()), 'raw preference survives refresh');
    assert(JSON.stringify((await geometry()).config) === JSON.stringify(saved), 'configuration survives refresh');
    await page.locator('#demo').click(); await page.waitForTimeout(350);
    await page.screenshot({ path: `D:/github/FPGA2026/FPGA2026/Claude_Temp/fpga-browser-output/panels-collapsed-${width}.png` });
    for (const side of ['left', 'right', 'log']) await page.locator(`#toggle-${side}-panel`).click();
    await page.locator('#grouped-hex').check(); await page.waitForTimeout(300);
    await page.screenshot({ path: `D:/github/FPGA2026/FPGA2026/Claude_Temp/fpga-browser-output/panels-expanded-${width}.png` });
    // Slider still uses the FLOAT32 send/readback path.
    const slider = page.locator('.parameter[data-id="32"] input[type="range"]');
    await slider.focus(); await slider.press('Home'); await slider.press('ArrowRight'); await page.waitForTimeout(300);
    assert((await page.locator('.parameter[data-id="32"] .sync').innerText()).includes('SYNCED'), 'FLOAT32 slider readback');
    await page.locator('#record').click(); await page.waitForTimeout(500); await page.locator('#pause').click();
    await page.locator('#toggle-log-panel').click(); await page.waitForTimeout(250); await page.locator('#toggle-log-panel').click();
    await page.locator('#stop').click(); await page.locator('#history').click();
    const session = page.locator('.session').first(); const downloadPromise = page.waitForEvent('download');
    await session.getByRole('button', { name: '导出 CSV' }).click(); const download = await downloadPromise;
    await download.saveAs(`D:/github/FPGA2026/FPGA2026/Claude_Temp/fpga-browser-output/float32-${width}.csv`);
    await session.getByRole('button', { name: '查看', exact: true }).click(); await page.waitForTimeout(250);
    assert((await geometry()).series.some(s => s.name === 'Channel 0x20' && s.data.length > 0), 'FLOAT32 recorded history plots');
    await page.locator('#toggle-left-panel').click(); await page.waitForTimeout(200); assert((await geometry()).mode === 'history', 'history resize preserves mode');
    await page.locator('#toggle-left-panel').click(); await page.locator('#live').click();
    await page.locator('#inject-crc').click(); await page.waitForTimeout(250);
    assert(Number(await page.locator('#crc').innerText()) === 1, 'CRC diagnostics remain functional');
    await page.locator('#disconnect').click(); results.push({ viewport: `${width}x${height}`, combinations, colors, copied });
  }
  // Inject exceptional wire bits into the test-only mock module, then exercise the real UI/recording pipeline.
  await page.route('**/src/serial/MockTransport.js*', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('value: Math.sin(t * 0.8)', 'rawBits: [0x7fc01234, 0x7f800000, 0xff800000, 0x3e800000][Math.floor(t) % 4]');
    await route.fulfill({ response, body });
  });
  await page.reload(); await page.locator('#demo').click();
  await page.waitForFunction(() => document.querySelector('.channel[data-id="32"] .channel-value')?.textContent === 'NaN');
  await page.locator('#record').click();
  for (const text of ['Infinity', '-Infinity', '0.25']) await page.waitForFunction(text => document.querySelector('.channel[data-id="32"] .channel-value')?.textContent === text, text);
  await page.locator('#pause').click(); await page.waitForTimeout(240);
  const exceptional = await geometry(), values = exceptional.series.find(s => s.name === 'Channel 0x20').data.map(p => p[1]);
  assert(values.includes(null) && values.includes(0.25) && values.every(v => v === null || Number.isFinite(v)), 'exceptional RX values become safe chart gaps');
  assert(await page.locator('.parameter[data-id="32"] input[type="number"]').inputValue() === '0.25', 'numeric control recovers after exceptional RX');
  await page.locator('#stop').click();
  const stored = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('fpga-monitor-db-v1'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const frames = await new Promise((resolve, reject) => { const r = db.transaction('frames').objectStore('frames').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    db.close(); return [...new Set(frames.flatMap(f => f.samples.filter(s => s.sourceId === 32).map(s => s.rawBits)))];
  });
  assert([0x7fc01234, 0x7f800000, 0xff800000].every(bits => stored.includes(bits)), 'IndexedDB retains exceptional raw bits');
  await page.locator('#disconnect').click();
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  return { result: 'PASS', results, errors };
}
