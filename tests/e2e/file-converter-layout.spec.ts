// 格式转换器（/tool/convert）：**可用性**端到端（真浏览器 + 真视口）
//
// 只留用户真会撞上的约束：页面不横向溢出、拖放区与主按钮看得见、加载出内容后操作区
// 仍在视口内。排版细节（八颗标签同不同行、按钮多高、两栏怎么对齐）属于样式实现，
// 按仓库纪律不在测试里固定 —— 由受影响页面与视口的实际检查负责。

import { test, expect, type Page } from '@playwright/test';

function overflowX(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test('页面不横向溢出，上传控件可用，内容加载后操作区不越界', async ({ page }) => {
  await page.goto('/tool/convert');
  expect(await overflowX(page), '首屏横向溢出').toBeLessThanOrEqual(2);

  // 拖放区与主按钮：任何视口都要真的在、真的点得到
  await expect(page.locator('.fc-dropzone')).toBeVisible();
  await expect(page.getByRole('button', { name: '选择文件' })).toBeVisible();

  // 走一遍最小转换流程的前半段，把真实内容撑出来（行为本身由 file-converter.spec.ts 覆盖）
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
  await page.locator('#fc-target').selectOption('image:to-jpg');
  await page.getByRole('button', { name: '高级选项' }).click();

  // 内容出现后，工作区里的控件不许被推出视口左右边界
  const vw = await page.evaluate(() => document.documentElement.clientWidth);
  for (const control of await page.locator('.fc-workspace .btn, .fc-workspace select, .fc-tab').all()) {
    if (!(await control.isVisible())) continue;
    const box = (await control.boundingBox())!;
    expect(box.x, '控件越出左边界').toBeGreaterThanOrEqual(-2);
    expect(box.x + box.width, '控件越出右边界').toBeLessThanOrEqual(vw + 2);
  }
  expect(await overflowX(page), '待转换区横向溢出').toBeLessThanOrEqual(2);
});
