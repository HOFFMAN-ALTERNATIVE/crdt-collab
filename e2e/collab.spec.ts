import { expect, test, type Page } from '@playwright/test';

const editor = (page: Page, i: number) => page.locator('.peer textarea').nth(i);
const peer = (page: Page, i: number) => page.locator('.peer').nth(i);

async function typeAtEnd(page: Page, i: number, text: string) {
  await editor(page, i).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(text);
}

test('simulated peers merge offline edits and whiteboard moves', async ({ page }) => {
  await page.goto(`/?room=e2e-sim-${Date.now()}`);
  await expect(page.locator('.peer')).toHaveCount(2);
  await expect(editor(page, 1)).toHaveValue(/Welcome to CRDT/);

  await typeAtEnd(page, 0, 'live edit from Ada');
  await expect(editor(page, 1)).toHaveValue(/live edit from Ada/);

  await peer(page, 1).locator('.switch').click(); // Linus goes offline
  await editor(page, 1).click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('[Linus offline] ');
  await typeAtEnd(page, 0, ' + Ada meanwhile');

  const note = peer(page, 0).locator('[data-shape="seed-note"]');
  // The board replaces its SVG nodes on re-render, so a locator handle can
  // detach between "find" and "measure". Read the rect in one evaluate call
  // and poll until the note is laid out.
  const rect = () =>
    peer(page, 0).evaluate((el) => {
      const r = el.querySelector('[data-shape="seed-note"]')?.getBoundingClientRect();
      return r && r.width > 0 ? { x: r.x, y: r.y } : null;
    });
  await expect.poll(rect).not.toBeNull();
  const box = (await rect())!;
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 80, { steps: 6 });
  await page.mouse.up();

  await peer(page, 1).locator('.switch').click(); // back online
  await expect(page.locator('#status')).toContainText('CONVERGED', { timeout: 10_000 });
  const a = await editor(page, 0).inputValue();
  expect(await editor(page, 1).inputValue()).toBe(a);
  expect(a).toContain('[Linus offline] ');
  expect(a).toContain(' + Ada meanwhile');
  await expect(peer(page, 1).locator('[data-shape="seed-note"]')).toHaveAttribute('transform', (await note.getAttribute('transform'))!);
});

test('chaos monkey with jitter still converges', async ({ page }) => {
  await page.goto(`/?room=e2e-chaos-${Date.now()}`);
  await page.locator('#add').click();
  await expect(page.locator('.peer')).toHaveCount(3);
  await page.locator('#jitter').check();
  await page.locator('#chaos').check();
  await page.waitForTimeout(4000);
  await page.locator('#chaos').uncheck();
  await page.locator('#heal').click();
  await expect(page.locator('#status')).toContainText('CONVERGED', { timeout: 15_000 });
  const fps = await page.locator('.peer-stats .fp').allTextContents();
  expect(new Set(fps).size).toBe(1);
});

test('two browser tabs sync over BroadcastChannel', async ({ context }) => {
  const room = `e2e-tabs-${Date.now()}`;
  const t1 = await context.newPage();
  const t2 = await context.newPage();
  await t1.goto(`/?room=${room}`);
  await t2.goto(`/?room=${room}`);
  await expect(editor(t2, 0)).toHaveValue(/Welcome/);
  await typeAtEnd(t1, 0, 'cross-tab hello');
  await expect(editor(t2, 0)).toHaveValue(/cross-tab hello/, { timeout: 10_000 });
});

test('WebSocket mode syncs through the Node server with presence', async ({ page, baseURL }) => {
  const ws = baseURL!.replace('http', 'ws') + '/ws';
  await page.goto(`/?ws=${encodeURIComponent(ws)}&room=e2e-ws-${Date.now()}`);
  await expect(page.locator('#mode')).toContainText('WEBSOCKET');
  await expect(editor(page, 1)).toHaveValue(/Welcome/, { timeout: 10_000 });
  await typeAtEnd(page, 0, 'via websocket');
  await expect(editor(page, 1)).toHaveValue(/via websocket/);
  await expect(peer(page, 1).locator('.rcaret')).toHaveCount(1);

  await peer(page, 0).locator('.switch').click();
  await typeAtEnd(page, 0, ' (offline)');
  await typeAtEnd(page, 1, ' (online)');
  await peer(page, 0).locator('.switch').click();
  await expect(page.locator('#status')).toContainText('CONVERGED', { timeout: 10_000 });
  expect(await editor(page, 0).inputValue()).toBe(await editor(page, 1).inputValue());

  const rooms = await (await page.request.get('/api/rooms')).json();
  expect(rooms.length).toBeGreaterThan(0);
});
