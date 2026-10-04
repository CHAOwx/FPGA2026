// Browser acceptance: playwright-cli run-code --filename=.../tests/chart-browser.js
// Use a fresh browser context and the running Vite dev server on port 5173.
async page => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const close = (a, b) => Math.abs(a - b) < Math.max(1, Math.abs(b)) * 1e-7;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const read = (x = 300, y = 150) => page.evaluate(async ({ x, y }) => {
    const echarts = await import('/node_modules/.vite/deps/echarts_core.js');
    const element = document.querySelector('#chart'), chart = echarts.getInstanceByDom(element), option = chart.getOption();
    return {
      mode: element.dataset.mode, end: Number(element.dataset.end), seq: Number(document.querySelector('#seq').textContent),
      range: [option.dataZoom[0].startValue, option.dataZoom[0].endValue],
      axes: [0, 1].map(yAxisIndex => [chart.convertFromPixel({ yAxisIndex }, element.clientHeight - 78), chart.convertFromPixel({ yAxisIndex }, 42)]),
      anchor: [chart.convertFromPixel({ xAxisIndex: 0 }, x), ...[0, 1].map(yAxisIndex => chart.convertFromPixel({ yAxisIndex }, y))],
      data: option.series[0]?.data ?? [], color: getComputedStyle(document.documentElement).colorScheme,
    };
  }, { x, y });
  const span = range => range[1] - range[0];
  const results = [];
  for (const [width, height] of [[1920, 1080], [1366, 768]]) {
    if (await page.locator('#stop').count() && await page.locator('#stop').isEnabled()) await page.locator('#stop').click();
    await page.setViewportSize({ width, height }); await page.goto('http://127.0.0.1:5173/');
    await page.evaluate(() => localStorage.clear()); await page.reload(); await page.locator('#demo').click();
    await page.waitForFunction(() => document.querySelector('#channel-count').textContent === '7');
    await page.locator('.channel[data-id="16"] button').click();
    await page.locator('#channel-form select[name="axis"]').selectOption('right');
    await page.locator('#channel-form input[name="writable"]').check();
    await page.locator('#channel-form button[type="submit"]').click();
    await page.locator('#pause').click(); await page.waitForTimeout(180);
    const autoBox = await page.locator('#chart').boundingBox(), autoBefore = await read();
    await page.mouse.move(autoBox.x + 200, autoBox.y + 110); await page.mouse.down();
    await page.mouse.move(autoBox.x + 200, autoBox.y + 130, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(180);
    const autoPan = await read();
    assert(autoPan.axes.every((range, i) => range[0] > autoBefore.axes[i][0]), `${width}: Auto Y axes must support vertical drag`);
    await page.locator('#live').click();
    await page.locator('#axes').click();
    for (const [side, min, max] of [['left', -500, 1500], ['right', -1, 1]]) {
      await page.locator(`#axis-form select[name="${side}Mode"]`).selectOption('manual');
      await page.locator(`#axis-form input[name="${side}Min"]`).fill(String(min));
      await page.locator(`#axis-form input[name="${side}Max"]`).fill(String(max));
    }
    await page.locator('#axis-form button[type="submit"]').click(); await page.locator('[data-window="1"]').click();
    await page.waitForFunction(() => Number(document.querySelector('#chart').dataset.end) > 2);
    await page.locator('#record').click(); await page.locator('#pause').click(); await page.waitForTimeout(180);
    let box = await page.locator('#chart').boundingBox();
    const px = Math.floor(70 + (box.width - 140) * .31), py = Math.floor(42 + (box.height - 120) * .27);
    const wheel = async (x, y, delta = -300) => { await page.mouse.move(box.x + x, box.y + y); await page.mouse.wheel(0, delta); await page.waitForTimeout(180); };
    const before = await read(px, py); await wheel(px, py); const plot = await read(px, py);
    assert(before.color === 'light', `${width}: white theme required`);
    assert(plot.anchor.every((value, i) => close(value, before.anchor[i])), `${width}: plot zoom must preserve all mouse anchors`);
    assert(close(span(plot.range), span(before.range) * Math.exp(-.3)), `${width}: plot wheel must zoom X`);
    assert(plot.axes.every((range, i) => close(span(range), span(before.axes[i]) * Math.exp(-.3))), `${width}: plot wheel must zoom both Y axes`);
    await wheel(px, py, 300); const reverse = await read(px, py);
    assert(reverse.anchor.every((value, i) => close(value, before.anchor[i])) && close(span(reverse.range), span(before.range)), `${width}: zoom out must reverse zoom in`);
    await wheel(px, box.height - 60); const xOnly = await read(px, py);
    assert(xOnly.axes.every((range, i) => range.every((v, j) => close(v, reverse.axes[i][j]))), `${width}: X-axis wheel must retain Y`);
    assert(close(xOnly.anchor[0], reverse.anchor[0]) && span(xOnly.range) < span(reverse.range), `${width}: X-axis wheel must anchor and scale X`);
    await wheel(35, py); const leftOnly = await read(px, py);
    assert(leftOnly.range.every((v, i) => close(v, xOnly.range[i])) && leftOnly.axes[1].every((v, i) => close(v, xOnly.axes[1][i])), `${width}: left Y wheel must affect only left Y`);
    assert(close(leftOnly.anchor[1], xOnly.anchor[1]) && span(leftOnly.axes[0]) < span(xOnly.axes[0]), `${width}: left Y anchor and scale`);
    await wheel(box.width - 35, py); const rightOnly = await read(px, py);
    assert(rightOnly.range.every((v, i) => close(v, leftOnly.range[i])) && rightOnly.axes[0].every((v, i) => close(v, leftOnly.axes[0][i])), `${width}: right Y wheel must affect only right Y`);
    assert(close(rightOnly.anchor[2], leftOnly.anchor[2]) && span(rightOnly.axes[1]) < span(leftOnly.axes[1]), `${width}: right Y anchor and scale`);
    // A diagonal drag pans X and both Y, and returning to the starting point restores the view.
    await page.mouse.move(box.x + px, box.y + py); await page.mouse.down();
    await page.mouse.move(box.x + px + 65, box.y + py + 25, { steps: 8 }); await page.waitForTimeout(180);
    const panned = await read(px, py);
    assert(panned.range[0] < rightOnly.range[0] && panned.axes.every((r, i) => r[0] > rightOnly.axes[i][0]), `${width}: diagonal left drag pans all axes`);
    assert(close(span(panned.range), span(rightOnly.range)) && panned.axes.every((r, i) => close(span(r), span(rightOnly.axes[i]))), `${width}: drag retains all scales`);
    await page.mouse.move(box.x + px, box.y + py, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(180);
    const returned = await read(px, py);
    assert(returned.range.every((v, i) => close(v, rightOnly.range[i])) && returned.axes.every((r, i) => r.every((v, j) => close(v, rightOnly.axes[i][j]))), `${width}: returning drag to origin restores view`);
    await page.waitForTimeout(350); const frozen = await read();
    assert(frozen.end === before.end && frozen.seq > before.seq && frozen.mode === 'pause', `${width}: PAUSE freezes display while recording/reception continue`);
    // Repeated drags may move beyond the original time domain, leaving blank space without invented data.
    await page.locator('[data-window="5"]').click(); await page.waitForTimeout(180);
    for (let step = 0; step < 2; step++) {
      await page.mouse.move(box.x + 80, box.y + py); await page.mouse.down();
      await page.mouse.move(box.x + box.width - 80, box.y + py, { steps: 12 }); await page.mouse.up(); await page.waitForTimeout(180);
    }
    const empty = await read();
    assert(empty.range[1] < 0 && empty.data.length === 0, `${width}: free pan before time zero must show empty space`);
    await page.locator('#reset-view').click(); await page.waitForTimeout(180); const reset = await read();
    assert(reset.mode === 'pause' && reset.end === before.end && reset.axes[0][0] === -500 && reset.axes[1][0] === -1 && reset.data.length > 0, `${width}: reset restores paused data and configured axes`);
    await page.locator('[data-window="1"]').click(); await page.locator('#live').click(); await page.waitForTimeout(200);
    await wheel(px, py); const liveZoom = await read(); await page.waitForTimeout(650); const flowing = await read();
    assert(flowing.mode === 'live' && flowing.seq > liveZoom.seq && flowing.data.at(-1)[0] > liveZoom.data.at(-1)[0] + .3, `${width}: zoomed series must keep receiving fresh samples`);
    assert(close(span(flowing.range), span(liveZoom.range)) && flowing.range[1] > liveZoom.range[1] + .3, `${width}: live time range follows data without losing scale`);
    await page.mouse.move(box.x + px, box.y + py); await page.mouse.down();
    await page.mouse.move(box.x + px + 25, box.y + py + 20, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(200);
    const livePan = await read(); await page.waitForTimeout(450); const panFlow = await read();
    assert(panFlow.mode === 'live' && panFlow.data.at(-1)[0] > livePan.data.at(-1)[0] + .2 && close(panFlow.axes[0][0], livePan.axes[0][0]), `${width}: live pan must keep drawing and preserve Y offset`);
    await page.locator('#live').click(); await page.waitForTimeout(180); const resumed = await read();
    assert(close(resumed.range[1], resumed.end) && close(span(resumed.range), 1), `${width}: LIVE resets the time range to latest`);
    await page.locator('#stop').click(); await page.locator('#history').click();
    const sessionText = await page.locator('.session').first().innerText();
    assert(/\b[1-9]\d*\s+frames\b/i.test(sessionText), `${width}: durable recording through navigation: ${sessionText}`);
    await page.locator('.session').first().getByRole('button', { name: '查看', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#chart').dataset.mode === 'history');
    await wheel(px, py); assert((await read()).mode === 'history', `${width}: history navigation must remain in history`);
    await page.locator('#live').click(); await page.waitForTimeout(180);
    assert((await read()).mode === 'live', `${width}: history must return to LIVE`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: UI must fit viewport`);
    await page.mouse.move(10, 10);
    await page.screenshot({ path: `D:/github/FPGA2026/FPGA2026/Claude_Temp/fpga-browser-output/vofa-${width}.png` });
    results.push({ viewport: `${width}x${height}`, anchors: { before: before.anchor, after: plot.anchor }, emptyRange: empty.range,
      liveSample: [liveZoom.data.at(-1)[0], flowing.data.at(-1)[0]], leftAxis: leftOnly.axes[0], rightAxis: rightOnly.axes[1] });
    await page.locator('#disconnect').click();
  }
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  return { result: 'PASS', results, errors };
}
