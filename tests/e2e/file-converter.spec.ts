// ─────────────────────────────────────────────────────────────────────────────
// file-converter.spec.ts —— 格式转换器（/tool/convert）的真实转换链路
//
// 【为什么必须有真转换的用例】契约层的单测全是构造字节；引擎（Canvas /
// FFmpeg.wasm）只有在真浏览器里才会跑。这里的每一条都走完「上传 → 识别 →
// 选目标 → 转换 → 下载 → 嗅探输出字节」全链路 —— 输出一律按**字节魔数**断言，
// 不是「有下载按钮就算过」（转换出一条空文件 / 错格式，按钮照样能点）。
//
// 【样本自举】不往仓库里放二进制样本：PNG 是内嵌的 1×1 合法文件，WAV 是
// 测试里现算的 PCM 正弦波。音频用 WAV→FLAC→WAV 闭环 —— FLAC 编解码都是
// FFmpeg 自带（不依赖 libmp3lame 这类外部库是否编进 wasm 核心），
// 所以这条链路在任何 @ffmpeg/core 构建下都成立。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';

/** 1×1 红色 PNG（合法完整文件）。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** 现算一段 16 位单声道 PCM WAV（正弦波）。 */
function makeWav(seconds = 0.5, freq = 440, sampleRate = 8000): Buffer {
  const n = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 32767 * 0.5), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** 上传文件并选中目标边，点「开始转换」，等任务成功后返回下载的字节。 */
async function convertAndDownload(
  page: import('@playwright/test').Page,
  file: { name: string; mimeType: string; buffer: Buffer },
  edgeId: string,
  downloadNamePart: string
): Promise<Buffer> {
  await page.locator('.fc-dropzone input[type=file]').setInputFiles({
    name: file.name,
    mimeType: file.mimeType,
    buffer: file.buffer,
  });
  // 识别完成后目标选择器出现
  const target = page.locator('#fc-target');
  await expect(target).toBeVisible({ timeout: 15_000 });
  await target.selectOption(edgeId);
  await page.getByRole('button', { name: /开始转换/ }).click();

  const task = page.locator(`li.fc-task[data-edge="${edgeId}"]`).first();
  // 成功才出现结果区；失败则出现错误区 —— 两个都等，谁先到算谁
  const result = task.locator('.fc-result');
  const failure = task.locator('.fc-task__error');
  await expect(result.or(failure)).toBeVisible({ timeout: 240_000 });
  if (await failure.isVisible()) {
    throw new Error(`转换失败：${await failure.innerText()}`);
  }

  const downloadBtn = task.locator('.fc-result__actions button', { hasText: downloadNamePart });
  const [download] = await Promise.all([page.waitForEvent('download'), downloadBtn.click()]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

test('工具箱「文件处理」区有格式转换器入口，点进去就是转换页', async ({ page }) => {
  await page.goto('/tool');
  const entry = page.locator('a.tool-new-card[href="/tool/convert"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await page.waitForURL(/\/tool\/convert$/, { timeout: 15_000 });
  await expect(page.locator('.fc-dropzone')).toBeVisible();
  // 八个能力区标签都在
  await expect(page.locator('.fc-tabs [role="tab"]')).toHaveCount(8);
});

test('图片：PNG → JPG 真实转换，输出按字节验明正身，并如实列出损失说明', async ({ page }) => {
  await page.goto('/tool/convert');
  const out = await convertAndDownload(
    page,
    { name: '测试图.png', mimeType: 'image/png', buffer: PNG_1PX },
    'image:to-jpg',
    '.jpg'
  );
  expect(out.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  // §15 诚实说明：有损重编码必须出现在结果区
  await expect(page.locator('li.fc-task[data-edge="image:to-jpg"] .fc-notices li').first()).toBeVisible();
  // §2 六种转换方式之一：PNG→JPG 是「重新编码」，结果页必须照实标出来
  // （「换封装」与「重新编码」对用户是完全不同的两件事，不能只写「转换完成」）
  await expect(page.locator('li.fc-task[data-edge="image:to-jpg"] .fc-result__method')).toContainText(
    '重新编码'
  );
  // 结果区跨分类保留，转换方式也必须保留，不能随着当前分类的登记表消失。
  await page.getByRole('tab', { name: '音频', exact: true }).click();
  await expect(page.locator('li.fc-task[data-edge="image:to-jpg"] .fc-result__method')).toContainText('重新编码');
});

test('用途预设在选文件前后都可用，保留文件并正确应用参数', async ({ page }) => {
  await page.goto('/tool/convert');
  const start = page.getByRole('button', { name: /开始转换/ });
  await expect(start).toBeDisabled();
  await page.getByRole('button', { name: '手机照片发给别人', exact: true }).click();
  await expect(page.locator('#fc-param-quality')).toHaveValue('90');
  await expect(start).toBeDisabled();
  await page.locator('.fc-dropzone input[type=file]').setInputFiles({ name: '保留的图片.png', mimeType: 'image/png', buffer: PNG_1PX });
  await expect(page.locator('#fc-target')).toHaveValue('image:to-jpg');
  await expect(start).toBeEnabled();
  await page.getByRole('button', { name: '高级选项' }).click();
  await expect(page.locator('#fc-param-maxWidth')).toHaveValue('2560');

  await page.getByRole('button', { name: '图片放网页', exact: true }).click();
  await expect(page.locator('.fc-file__name')).toHaveText('保留的图片.png');
  await expect(page.locator('#fc-target')).toHaveValue('image:to-webp');
  await expect(page.locator('#fc-param-quality')).toHaveValue('82');
  await page.getByRole('button', { name: '高级选项' }).click();
  await expect(page.locator('#fc-param-maxWidth')).toHaveValue('1280');
  await expect(start).toBeEnabled();

  // 再点击当前分类不会清空文件；自定义参数后不再宣称仍应用了完整用途预设。
  await page.getByRole('tab', { name: '图片', exact: true }).click();
  await expect(page.locator('.fc-file__name')).toHaveText('保留的图片.png');
  await page.locator('#fc-param-quality').press('ArrowLeft');
  await expect(page.getByRole('button', { name: '图片放网页', exact: true })).toHaveAttribute('aria-pressed', 'false');
});

test('预设只显示当前分类，分类标签支持方向键切换', async ({ page }) => {
  await page.goto('/tool/convert');
  await expect(page.getByRole('button', { name: '手机照片发给别人', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '语音给旧播放器', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: '图片', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: '音频', exact: true })).toBeFocused();
  await expect(page.getByRole('tab', { name: '音频', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: '手机照片发给别人', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '语音给旧播放器', exact: true })).toBeVisible();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: '压缩包', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: '图片', exact: true })).toBeFocused();
});

test('音频：WAV→FLAC→WAV 引擎闭环（自举样本，全程不出站）', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/tool/convert');

  // 音频是第二个标签页
  await page.locator('.fc-tabs [role="tab"]').nth(1).click();

  const wav = makeWav();
  const flac = await convertAndDownload(
    page,
    { name: '测试音.wav', mimeType: 'audio/wav', buffer: wav },
    'audio:to-flac',
    '.flac'
  );
  expect(flac.subarray(0, 4).toString('ascii')).toBe('fLaC');

  // 把上一段的输出再喂回去 —— 验证解码链与编码链都是真的
  const wav2 = await convertAndDownload(
    page,
    { name: '回环.flac', mimeType: 'audio/flac', buffer: flac },
    'audio:to-wav',
    '.wav'
  );
  expect(wav2.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(wav2.subarray(8, 12).toString('ascii')).toBe('WAVE');
});
