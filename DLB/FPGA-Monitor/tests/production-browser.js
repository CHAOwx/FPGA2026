// Browser smoke acceptance for npm run build + npm run preview (4173), isolated context.
async page => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const size = () => page.evaluate(() => {
    const el = document.querySelector('#chart'), canvas = el.querySelector('canvas');
    return { width: el.clientWidth, height: el.clientHeight, canvas: [canvas.width / devicePixelRatio, canvas.height / devicePixelRatio],
      overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight };
  });
  for (const [width, height] of [[1920, 1080], [1366, 768]]) {
    await page.setViewportSize({ width, height }); await page.goto('http://127.0.0.1:4173');
    await page.evaluate(() => localStorage.clear()); await page.reload(); await page.locator('#demo').click();
    await page.waitForFunction(() => document.querySelector('#channel-count').textContent === '7');
    assert((await page.locator('.channel[data-id="32"]').innerText()).includes('FLOAT32'), 'production FLOAT32 discovery');
    for (const [id, value, payload] of [[32, '0.25', '20 05 00 00 80 3E'], [16, '0.25', '10 03 00 40 00 00']]) {
      await page.locator(`.channel[data-id="${id}"] button`).click(); await page.locator('#channel-form input[name="writable"]').check();
      await page.locator('#channel-form select[name="axis"]').selectOption('right'); await page.locator('#channel-form button[type="submit"]').click();
      const input = page.locator(`.parameter[data-id="${id}"] input[type="number"]`); await input.fill(value); await input.press('Enter');
      await page.waitForFunction(id => document.querySelector(`.parameter[data-id="${id}"] .sync`)?.textContent.includes('SYNCED'), id);
      await page.waitForFunction(payload => [...document.querySelectorAll('.log-entry.TX .log-hex')].some(el => el.textContent.includes(payload)), payload);
    }
    await page.waitForTimeout(350); const image1 = await page.locator('#chart canvas').screenshot(); await page.waitForTimeout(350);
    assert(!image1.equals(await page.locator('#chart canvas').screenshot()), 'production LIVE draws new samples');
    await page.locator('#pause').click(); await page.waitForTimeout(200); const end = await page.locator('#chart').getAttribute('data-end');
    const frozen = await page.locator('#chart canvas').screenshot(), seq = Number(await page.locator('#seq').innerText());
    await page.waitForTimeout(350);
    assert(frozen.equals(await page.locator('#chart canvas').screenshot()) && Number(await page.locator('#seq').innerText()) > seq, 'production PAUSE freezes canvas while receiving');
    const combinations = [];
    for (let mask = 0; mask < 8; mask++) {
      for (const [side, bit] of [['left', 1], ['right', 2], ['log', 4]]) {
        const button = page.locator(`#toggle-${side}-panel`);
        if ((await button.getAttribute('aria-expanded') === 'false') !== !!(mask & bit)) await button.click();
      }
      await page.waitForTimeout(240); const dimensions = await size();
      assert(!dimensions.overflow && dimensions.canvas[0] === dimensions.width && dimensions.canvas[1] === dimensions.height, `${width} mask ${mask}: production layout and canvas`);
      assert(await page.locator('#chart').getAttribute('data-end') === end, 'production panel resize retains frozen data');
      combinations.push({ mask, width: dimensions.width, height: dimensions.height });
    }
    await page.reload(); await page.waitForTimeout(200);
    for (const side of ['left', 'right', 'log']) assert(await page.locator(`#toggle-${side}-panel`).getAttribute('aria-expanded') === 'false', 'production persistence');
    await page.locator('#demo').click(); await page.waitForTimeout(300);
    for (const side of ['left', 'right', 'log']) await page.locator(`#toggle-${side}-panel`).click();
    await page.waitForTimeout(250);
    assert(await page.locator('.hex-separator').count() > 0, 'production grouped log');
    await page.locator('#grouped-hex').uncheck(); await page.waitForTimeout(240); assert(await page.locator('.hex-separator').count() === 0, 'production raw log');
    await page.locator('#grouped-hex').check(); await page.locator('.channel[data-id="32"]').scrollIntoViewIfNeeded();
    assert(await page.locator('#toggle-left-panel').isVisible(), 'sidebar heading remains visible after scroll');
    await page.screenshot({ path: `D:/github/FPGA2026/FPGA2026/Claude_Temp/fpga-browser-output/monitor-production-${width}.png` });
    await page.locator('#disconnect').click(); results.push({ viewport: `${width}x${height}`, combinations });
  }
  assert(errors.length === 0, `Production errors: ${errors.join('; ')}`);
  return { result: 'PASS', externalRequestsBlocked: true, results, errors };
}
