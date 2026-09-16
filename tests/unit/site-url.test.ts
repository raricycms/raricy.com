// site-url.ts —— 站点对外地址的唯一解析处。
//
// 这份实现原先内联在 oauth.ts 的 siteOrigin() 里，画报要用同一套回退链就搬了出来。
// 它现在有两条下游：OAuth userinfo 的绝对 avatar_url，以及**画报里二维码的前缀**。
//
// 后者是这里值得重点测的原因：二维码前缀拼错的症状是「图能生成、看上去一切正常，
// 但扫出来打不开」—— 站内没有任何地方会报错。而返回空串时画报路由必须拒绝出图
// （宁可 503，也不给用户一张废码），这条约束就靠下面的用例钉住。

import { describe, it, expect, afterEach, vi } from 'vitest';
import { absoluteUrl, siteOrigin } from '@/lib/site-url';

const SAVED = {
  site: process.env.SITE_URL,
  allowed: process.env.ALLOWED_ORIGINS,
};

function setEnv(site: string | undefined, allowed: string | undefined) {
  if (site === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = site;
  if (allowed === undefined) delete process.env.ALLOWED_ORIGINS;
  else process.env.ALLOWED_ORIGINS = allowed;
}

afterEach(() => {
  setEnv(SAVED.site, SAVED.allowed);
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
