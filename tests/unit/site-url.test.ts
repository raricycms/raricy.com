// site-url.ts —— 站点对外地址的唯一解析处。
//
// 这份实现原先内联在 oauth.ts 的 siteOrigin() 里，画报要用同一套回退链就搬了出来。
// 它现在有两条下游：OAuth userinfo 的绝对 avatar_url，以及**画报里二维码的前缀**。
//
// 后者是这里值得重点测的原因：二维码前缀拼错的症状是「图能生成、看上去一切正常，
// 但扫出来打不开」—— 站内没有任何地方会报错。而返回空串时画报路由必须拒绝出图
// （宁可 503，也不给用户一张废码），这条约束就靠下面的用例钉住。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { absoluteUrl, siteBaseUrl, siteOrigin } from '@/lib/site-url';

const SAVED = {
  site: process.env.SITE_URL,
  allowed: process.env.ALLOWED_ORIGINS,
  legacy: process.env.NEXT_PUBLIC_SITE_URL,
};

function setEnv(site: string | undefined, allowed: string | undefined, legacy?: string) {
  if (site === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = site;
  if (allowed === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = allowed;
  if (legacy === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
  else process.env.NEXT_PUBLIC_SITE_URL = legacy;
}

afterEach(() => {
  setEnv(SAVED.site, SAVED.allowed, SAVED.legacy);
  vi.restoreAllMocks();
});

/** 回退链上每一步都会 console.warn —— 用例里静音，免得刷屏 */
function muteWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

describe('siteOrigin', () => {
  it('优先 SITE_URL，并规范化为 origin（丢掉路径与尾斜杠）', () => {
    muteWarn();
    setEnv('https://raricy.com/', 'https://other.example');
    expect(siteOrigin()).toBe('https://raricy.com');

    setEnv('https://raricy.com/some/path', undefined);
    expect(siteOrigin()).toBe('https://raricy.com');
  });

  it('SITE_URL 不是合法 URL → 回退 ALLOWED_ORIGINS 第一项', () => {
    muteWarn();
    setEnv('这不是一个 URL', 'https://a.example,https://b.example');
    expect(siteOrigin()).toBe('https://a.example');
  });

  it('ALLOWED_ORIGINS 里没写协议时补 https', () => {
    muteWarn();
    setEnv(undefined, 'raricy.com');
    expect(siteOrigin()).toBe('https://raricy.com');
  });

  it('两个都没配 → 空串', () => {
    muteWarn();
    setEnv(undefined, undefined);
    expect(siteOrigin()).toBe('');
  });
});

describe('absoluteUrl', () => {
  it('拼出绝对 URL（画报二维码里的就是它）', () => {
    muteWarn();
    setEnv('https://raricy.com', undefined);
    expect(absoluteUrl('/u/u_abc')).toBe('https://raricy.com/u/u_abc');
    expect(absoluteUrl('u/u_abc')).toBe('https://raricy.com/u/u_abc');
  });

  it('origin 未知时退化为相对路径 —— 画报路由必须据此拒绝出图', () => {
    muteWarn();
    setEnv(undefined, undefined);
    // 相对路径的二维码是废码：扫码的人拿不到任何站点信息。
    // 所以 /api/poster/* 在 siteOrigin() 为空时一律 503，绝不用这个返回值去出图。
    expect(absoluteUrl('/u/u_abc')).toBe('/u/u_abc');
    expect(siteOrigin()).toBe('');
  });
});

// siteBaseUrl 是**失败方向相反**的那一个：它永远给得出绝对地址。
//
// 为什么不能合并成一个函数：
//   · siteOrigin() 空串 → 画报拒绝出图（对的：宁可不给，也不给一张扫不开的码）
//   · siteBaseUrl() 空串 → metadataBase 拿 localhost 当基准、sitemap 吐相对路径（错的）
// 所以它兜底到正式域名。下面这几条把这个「永不返回空」钉死。
describe('siteBaseUrl', () => {
  it('优先级：SITE_URL → ALLOWED_ORIGINS → NEXT_PUBLIC_SITE_URL', () => {
    setEnv('https://a.example', 'https://b.example', 'https://c.example');
    expect(siteBaseUrl()).toBe('https://a.example');

    setEnv(undefined, 'https://b.example', 'https://c.example');
    expect(siteBaseUrl()).toBe('https://b.example');

    // 历史变量排在最后 —— 它只是「让 sitemap/robots 的既有输出不变」的兼容项
    setEnv(undefined, undefined, 'https://c.example');
    expect(siteBaseUrl()).toBe('https://c.example');
  });

  it('★ 全空时返回正式域名，**绝不是空串**', () => {
    setEnv(undefined, undefined);
    expect(siteBaseUrl()).toBe('https://raricy.com');
  });

  it('配置是垃圾时也回退兜底，且**永不抛**', () => {
    muteWarn();
    // layout.tsx 在模块作用域对它跑 new URL() —— 抛一次就是全站 500。
    //
    // ⚠️ 这里的「垃圾」要挑**真的解析不了**的：`new URL('https://这也不是')` 是成功的
    // （WHATWG 按 IDN 转成 punycode 的 `xn--ihqqhk19d581b`），所以拿中文当反例会
    // 得到一条看似合理、其实不是兜底域名的结果。`http://[` 才会抛。
    setEnv('http://[', 'http://[', 'http://[');
    expect(() => new URL(siteBaseUrl())).not.toThrow();
    expect(siteBaseUrl()).toBe('https://raricy.com');
  });

  it('规范化：丢掉路径与尾斜杠', () => {
    setEnv('https://raricy.com/some/path', undefined);
    expect(siteBaseUrl()).toBe('https://raricy.com');
  });

  it('与 siteOrigin() 相反：配置全空时它给得出地址，而 siteOrigin 给空串', () => {
    muteWarn();
    setEnv(undefined, undefined);
    expect(siteOrigin()).toBe('');
    expect(siteBaseUrl()).not.toBe('');
  });
});
