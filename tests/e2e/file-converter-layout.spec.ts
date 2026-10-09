// 格式转换器（/tool/convert）：**布局**端到端（真浏览器 + 真视口）
//
// 【为什么走 e2e】标签栏八颗胶囊在 360px 视口下折不折行、拖放区点不点得到、
// 任务操作按钮在窄屏挤不挤 —— 全是字体度量与真排版才能回答的问题，单测与
// 截图都证明不了（判据一律取渲染后几何，与 favorite-layout 同手法）。
//
// 【本文件在 RESPONSIVE_SPECS 里】desktop 验「八颗标签同一行 / 控件不溢出」，
// mobile 验「折行但不横向溢出、触控目标够大」。页面无需登录（工具页全公开）。

import { test, expect } from '@playwright/test';

test('八个能力区标签在桌面同行、在窄屏折行但页面不横向溢出', async ({ page }, testInfo) => {
  const isMobile = testInfo.project.name === 'mobile';
  await page.goto('/tool/convert');

  const tabs = page.locator('.fc-tabs');
  await expect(tabs.locator('[role="tab"]')).toHaveCount(8);

  // 任何视口下：页面不许出现横向滚动条（body 横向溢出是移动端的头号静坏）
  const overflowX = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflowX, `页面横向溢出 ${overflowX}px`).toBeLessThanOrEqual(2);

  const rows = await tabs.evaluate((el) => {
    const tops = new Set(
      [...el.querySelectorAll('[role="tab"]')].map((t) => Math.round(t.getBoundingClientRect().top))
    );
    return tops.size;
  });
  if (isMobile) {
    // 窄屏八颗胶囊必然折行 —— 折行是对的行为，不许挤成横向滚动
    expect(rows).toBeGreaterThan(1);
  } else {
    expect(rows).toBe(1);
  }
});

test('拖放区与主按钮在任何视口都完整可见、可点', async ({ page }) => {
  await page.goto('/tool/convert');
  const dropzone = page.locator('.fc-dropzone');
  await expect(dropzone).toBeVisible();
  const box = (await dropzone.boundingBox())!;
  // 拖放区不被裁切（在视口内，左右不越界）
  expect(box.x).toBeGreaterThanOrEqual(0);
  const vw = await page.evaluate(() => document.documentElement.clientWidth);
  expect(box.x + box.width).toBeLessThanOrEqual(vw + 2);

  const cta = page.getByRole('button', { name: '选择文件' });
  const btnBox = (await cta.boundingBox())!;
  // 触控目标下限 44px（全站按钮纪律同）
  expect(btnBox.height).toBeGreaterThanOrEqual(44);
});

test('上传后待转换清单与操作区在窄屏不横向溢出', async ({ page }) => {
  // 走一遍最小转换流程的**前半段**（上传 + 出现目标选择），只为把真实内容撑出来排版
  await page.goto('/tool/convert');
  const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  await page.locator('.fc-dropzone input[type=file]').setInputFiles({
    name: '窄屏排版测试图.png',
    mimeType: 'image/png',
    buffer: PNG_1PX,
  });
  await expect(page.locator('#fc-target')).toBeVisible({ timeout: 15_000 });
  const overflowX = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflowX, `待转换区横向溢出 ${overflowX}px`).toBeLessThanOrEqual(2);
});
