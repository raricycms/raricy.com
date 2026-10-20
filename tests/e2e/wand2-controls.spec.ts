import { test, expect } from '@playwright/test';
import { registerFreshUser } from './helpers';
import { decodeInput, INPUT } from '../../shared/wand2/protocol';

// 双指拖动使用 Chromium 的 CDP；wand2.spec.ts 的移动端用例继续覆盖 WebKit。
test.use({ browserName: 'chromium' });

test('Wand 2 摇杆：死区、斜向、双指长按、拖出边界与取消后停止', async ({ page, context, isMobile }) => {
  await registerFreshUser(page);
  const state = { buttons: 0 };
  page.on('websocket', socket => {
    if (!socket.url().endsWith('/realtime/wand2')) return;
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') { const input = decodeInput(payload); if (input) state.buttons = input.buttons; }
    });
  });
  await page.goto('/game/wand2'); await page.getByRole('button', { name: '开始联机' }).click();
  await expect(page.locator('.wand2-status')).toContainText('已连接');
  const joystick = page.getByRole('button', { name: '移动摇杆' }), attack = page.getByRole('button', { name: '挥剑', exact: true });
  await page.locator('.wand2-inputs').scrollIntoViewIfNeeded();
  const box = (await joystick.boundingBox())!, attackBox = (await attack.boundingBox())!;
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const diagonal = { x: center.x + 30, y: center.y - 30 };
  await expect(joystick).toHaveCSS('touch-action', 'none');
  await expect(joystick).toHaveCSS('user-select', 'none');
  await expect(attack).toHaveCSS('user-select', 'none');
  const menuCanceled = await attack.evaluate(el => !el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  expect(menuCanceled).toBe(true);

  if (isMobile) {
    // 通过浏览器输入通道发送双指触摸，覆盖手势判定与指针捕获。
    const cdp = await context.newCDPSession(page);
    const finger = (id: number, point: { x: number; y: number }) => ({ id, ...point });
    const sword = finger(2, { x: attackBox.x + attackBox.width / 2, y: attackBox.y + attackBox.height / 2 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger(1, center)] });
    await expect(joystick).toHaveAttribute('data-active', 'true');
    await expect.poll(() => state.buttons).toBe(0);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [finger(1, { x: center.x + 2, y: center.y + 2 })] });
    await expect.poll(() => state.buttons).toBe(0);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [finger(1, diagonal)] });
    await expect.poll(() => state.buttons).toBe(INPUT.up | INPUT.right);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger(1, diagonal), sword] });
    await expect.poll(() => state.buttons).toBe(INPUT.up | INPUT.right | INPUT.attack);
    const scrollY = await page.evaluate(() => window.scrollY);
    await page.waitForTimeout(900);
    expect(state.buttons).toBe(INPUT.up | INPUT.right | INPUT.attack);
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [finger(1, diagonal)] });
    await expect(joystick).toHaveAttribute('data-active', 'false');
    await expect.poll(() => state.buttons).toBe(INPUT.attack);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => state.buttons).toBe(0);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [finger(1, center)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [finger(1, { x: box.x - 30, y: center.y })] });
    await expect.poll(() => state.buttons).toBe(INPUT.left);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await cdp.detach();
  } else {
    await page.mouse.move(center.x, center.y); await page.mouse.down();
    await expect.poll(() => state.buttons).toBe(0);
    await page.mouse.move(diagonal.x, diagonal.y);
    await expect.poll(() => state.buttons).toBe(INPUT.up | INPUT.right);
    await page.mouse.move(box.x - 30, center.y);
    await expect.poll(() => state.buttons).toBe(INPUT.left);
    await page.mouse.up();
  }
  await expect.poll(() => state.buttons).toBe(0);
  await expect(joystick).toHaveAttribute('data-active', 'false');
  await expect(page.locator('.wand2-joystick-knob')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  // 后台切换和断线也必须清掉方向，旧手指移动不能重新激活输入。
  await page.mouse.move(diagonal.x, diagonal.y); await page.mouse.down();
  await expect.poll(() => state.buttons).toBe(INPUT.up | INPUT.right);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect.poll(() => state.buttons).toBe(0);
  await page.mouse.move(center.x + 25, center.y); await page.mouse.up();
  await expect.poll(() => state.buttons).toBe(0);
  await page.mouse.move(diagonal.x, diagonal.y); await page.mouse.down();
  await expect.poll(() => state.buttons).toBe(INPUT.up | INPUT.right);
  await page.getByRole('button', { name: '离开草地' }).evaluate((el: HTMLButtonElement) => el.click());
  await page.mouse.up();
  await expect(joystick).toBeDisabled(); await expect(joystick).toHaveAttribute('data-active', 'false');
  await page.getByRole('button', { name: '开始联机' }).click();
  await expect(page.locator('.wand2-status')).toContainText('已连接');
  await expect.poll(() => state.buttons).toBe(0);
});
