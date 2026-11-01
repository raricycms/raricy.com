// ─────────────────────────────────────────────────────────────────────────────
// reactive-media-playback.spec.ts —— 恢复的历史 HTML 媒体**真的能播放**
//
// 只做 DOM 断言（controls/src）不足以证明“保留可播放”这条产品口径。这里用
// Playwright 的 route 拦一个受控外部 URL，回一段现场生成的最小 WAV（不装依赖、
// 不访问外网、不往仓库放二进制），点播放后断言 currentTime 真的前进。
// 视频的 source/track 结构仍由 reactive-media.spec.ts 的 DOM 检查覆盖。
// ─────────────────────────────────────────────────────────────────────────────

import { test, expect } from '@playwright/test';
import { SEED_PASSWORD, SEED_USERS } from './seed';
import { uniqueTag } from './helpers';

/** 0.4s、8kHz、16-bit 单声道正弦波 —— 浏览器原生可解码的最小合法 WAV。 */
function toneWav(): Buffer {
  const sampleRate = 8000;
  const seconds = 0.4;
  const samples = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000), i * 2);
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

test('历史 HTML audio 恢复后可 ready / play / currentTime 前进', async ({ page }) => {
  const login = await page.request.post('/api/auth/login', {
    data: { username: SEED_USERS.core.username, password: SEED_PASSWORD },
  });
  expect(login.status()).toBe(200);

  const wav = toneWav();
  await page.route('https://media.test/tone.wav', (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav' }, body: wav })
  );

  const created = await page.request.post('/api/blogs', {
    data: {
      title: `media-playback-${uniqueTag()}`,
      description: '受控音频播放',
      content: '<audio controls preload="none" src="https://media.test/tone.wav"></audio>\n\n正文。',
      visibility: 'public',
      format: 'markdown',
    },
  });
  expect(created.status(), `发文失败：${await created.text()}`).toBe(200);
  const { blog_id: blogId } = (await created.json()) as { blog_id: string };

  await page.goto(`/blog/${blogId}`);
  const audio = page.locator('#userContentContainer audio.site-embed--audio');
  await expect(audio).toHaveCount(1);

  const played = await audio.evaluate(async (el) => {
    const node = el as HTMLAudioElement;
    node.muted = true; // 允许无用户手势的自动播放路径
    const result = await node.play().then(() => 'ok' as const).catch((error: unknown) => String(error));
    return { result, readyState: node.readyState, duration: node.duration };
  });
  expect(played.result, `play() 失败：${played.result}`).toBe('ok');
  expect(played.readyState).toBeGreaterThanOrEqual(2);
  expect(played.duration).toBeGreaterThan(0.1);

  await expect
    .poll(async () => audio.evaluate((el) => (el as HTMLAudioElement).currentTime), {
      timeout: 5000,
    })
    .toBeGreaterThan(0.05);
});
