#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────────────────────
// smoke.mjs —— 切换后的线上冒烟：把手册 §3.9 那 11 条手工清单跑成一条命令
//
// 【为什么要有】切完 nginx 是凌晨，手册让你挨个点 11 样东西：首页、文章列表、详情、
// 点赞、签到、投喂、图床上传、管理面板…… 人在那个点上最容易漏掉一两条，
// 而漏掉的那条往往就是坏的那条。
//
// 【★ 只读 ★】它打的是**生产站**，所以默认不产生任何数据：
//   · 不签到（会消耗用户当天的签到）
//   · 不点赞、不投喂、不发文
//   · 图床那条用「2MB 但内容非法」的文件探 —— 穿过 nginx 后会被应用以
//     400「内容与格式不匹配」拒掉（校验在写盘之前，也不消耗配额），
//     一个字节都不会存。既验了 nginx 的 client_max_body_size，又不留垃圾。
//   唯一的副作用是 users.last_login 会被更新（登录本来就该更新它）。
//
// 用法：
//   npm run smoke -- --url https://raricy.com
//   npm run smoke -- --url https://raricy.com --user <核心用户名> --pass <密码>
//
//   不给 --user 就只跑匿名能验的部分（HTTPS / CSRF / 门控 / 静态资源）。
//   给了才能验「登录态是否粘住」「文章列表有没有内容」这些最要命的。
//
// 退出码：0 全过；1 有失败。
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};

const base = (arg('--url') ?? '').replace(/\/$/, '');
const user = arg('--user');
const pass = arg('--pass');

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

if (!base) {
  console.error('用法：npm run smoke -- --url https://你的域名 [--user <核心用户名> --pass <密码>]');
  process.exit(2);
}

let fail = 0;
let skip = 0;
const ok = (m, d = '') => console.log(`  ${green('✓')} ${m}${d ? '  ' + d : ''}`);
const bad = (m, fix) => {
  fail++;
  console.log(`  ${red('✗')} ${m}`);
  if (fix) console.log(`     ${yellow('→ ' + fix)}`);
};
const skipped = (m, why) => {
  skip++;
  console.log(`  ${yellow('-')} ${m}  ${yellow('（跳过：' + why + '）')}`);
};

// 自己攒 cookie：Node 的 fetch 没有 cookie jar，手动传更可控。
//
// ★ 必须照浏览器的规矩丢掉不该收的 cookie ★
// Node 的 fetch 不管 Secure 属性，我们要是照单全收，就会在**这个脚本最该抓的那个
// bug** 上给假绿：站点是 http、服务端却下发了 Secure cookie —— 真浏览器直接丢掉，
// 表现为「登录接口回 200，但刷新还是未登录」（线上真实发生过）。
// 脚本自己留着那个 cookie，就会一路绿到底，然后告诉你一切正常。
// 实测：不做这个丢弃，COOKIE_SECURE=true + http 站点，冒烟照样报「登录态粘住了」。
let cookie = '';
const droppedSecure = [];
const isHttps = base.startsWith('https://');
const rememberCookies = (res) => {
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const attrs = c.split(';').map((s) => s.trim().toLowerCase());
    const kv = c.split(';')[0];
    const name = kv.split('=')[0];
    if (!isHttps && attrs.includes('secure')) {
      droppedSecure.push(name);
      continue; // 浏览器会丢，我们也丢
    }
    // 同名覆盖，别让旧值残留（登出时服务端会下发空值来清）
    const rest = cookie.split('; ').filter((x) => x && x.split('=')[0] !== name);
    cookie = [...rest, kv].join('; ');
  }
};
const get = (p, init = {}) =>
  fetch(`${base}${p}`, { redirect: 'manual', headers: { cookie, ...(init.headers ?? {}) }, ...init });

console.log(bold(`\n═══ 线上冒烟：${base} ═══\n`));

// ── 1. 协议 ─────────────────────────────────────────────────────────────────
console.log(bold('1. 协议'));
if (base.startsWith('https://')) {
  ok('HTTPS');
} else {
  bad(
    '站点走的是 HTTP —— 生产模式下会话 cookie 带 Secure，浏览器会直接丢掉',
    '配好 TLS；或临时把 COOKIE_SECURE=false（仅内网调试用）'
  );
}

// ── 2. 公开页面 ─────────────────────────────────────────────────────────────
console.log(bold('\n2. 公开页面'));
for (const [p, name] of [['/', '首页'], ['/tool', '工具'], ['/game', '玩具'], ['/login', '登录页']]) {
  try {
    const r = await get(p);
    if (r.status === 200) ok(`${name} ${p}`);
    else bad(`${name} ${p} → HTTP ${r.status}`);
  } catch (e) {
    bad(`${name} ${p} 打不开：${String(e).split('\n')[0]}`, '站点在跑吗？域名解析、防火墙、nginx upstream');
  }
}

// ── 3. CSRF ─────────────────────────────────────────────────────────────────
console.log(bold('\n3. CSRF'));
try {
  const evil = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
    body: JSON.stringify({ username: 'x', password: 'y' }),
  });
  if (evil.status === 403) ok('外站 Origin 被拒（403）');
  else bad(`外站 Origin 没被拒，返回 ${evil.status} —— CSRF 防护没生效`);

  const same = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: '__smoke__', password: '__nope__' }),
  });
  if (same.status === 403) {
    bad(
      '同源请求也被当成 CSRF 拒了 —— 全站 POST 都会挂',
      'nginx 少了 proxy_set_header X-Forwarded-Host $http_host，或 ALLOWED_ORIGINS 没配/配错（见 §3.8）'
    );
  } else if (same.status === 500) {
    bad('登录接口 500', '多半是库没规整（Conversion failed）或 SECRET_KEY 不对，看 journalctl -u raricy-next');
  } else {
    ok(`同源请求放行（HTTP ${same.status}，401=进到密码校验了）`);
  }
} catch (e) {
  bad(`CSRF 检查失败：${String(e).split('\n')[0]}`);
}

// ── 4. 登录态是否粘住 ───────────────────────────────────────────────────────
console.log(bold('\n4. 登录态'));
if (!user || !pass) {
  skipped('登录 / 文章列表 / 图床', '没给 --user / --pass');
} else {
  let logged = false;
  try {
    const r = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: user, password: pass }),
    });
    rememberCookies(r);
    const body = await r.json().catch(() => ({}));
    if (r.status === 200 && body.code === 200) {
      ok('登录接口返回成功');
      // ★ 真正要验的是这一步 ★ 登录接口回 200 但 cookie 被浏览器丢掉，
      // 是线上真实发生过的事故（COOKIE_SECURE / X-Forwarded-Proto 配错）。
      // 只有再发一次带 cookie 的请求、让服务端认出人来，才算数。
      const me = await get('/');
      const html = await me.text();
      if (/name="user-authenticated"\s+content="true"/.test(html)) {
        ok('登录态粘住了（服务端在下一次请求里认出了这个人）');
        logged = true;
      } else if (droppedSecure.length) {
        // 病因已经确定，别让人再去猜
        bad(
          `登录成功但登录态没粘住 —— 服务端给 http 站点下发了 Secure cookie（${droppedSecure.join(', ')}），浏览器会直接丢掉`,
          '要么把站点配成 HTTPS（推荐），要么临时设 COOKIE_SECURE=false（仅内网调试）。' +
            '若已在 nginx 后跑 HTTPS，那是 proxy_set_header X-Forwarded-Proto $scheme 漏了 —— ' +
            'Next 靠它才知道对外是 https（见 §3.8）'
        );
      } else {
        bad(
          '登录成功但登录态没粘住 —— 服务端在下一次请求里认不出人',
          'cookie 下发了但没被认。看 journalctl -u raricy-next；也确认 SECRET_KEY 与建会话时用的是同一个'
        );
      }
    } else {
      bad(`登录失败：HTTP ${r.status} ${JSON.stringify(body).slice(0, 120)}`, '用户名密码对吗？该账号是核心用户吗？');
    }
  } catch (e) {
    bad(`登录出错：${String(e).split('\n')[0]}`);
  }

  // ── 5. 文章列表与详情 ─────────────────────────────────────────────────────
  console.log(bold('\n5. 内容'));
  if (!logged) {
    skipped('文章列表 / 详情', '登录没成功');
  } else {
    const list = await get('/blog');
    if (list.status !== 200) {
      bad(`/blog → HTTP ${list.status}`, list.status === 403 ? '该账号不是核心用户？' : undefined);
    } else {
      const html = await list.text();
      const ids = [...html.matchAll(/href="\/blog\/([a-f0-9-]{36})"/g)].map((m) => m[1]);
      if (ids.length) {
        ok(`文章列表有内容（本页 ${ids.length} 篇）`);
        const d = await get(`/blog/${ids[0]}`);
        if (d.status === 200) ok('文章详情页正常');
        else bad(`文章详情 → HTTP ${d.status}`);
      } else {
        bad('文章列表是空的 —— 库里有 6000+ 篇，这里一篇都没有就是不对', '库指对了吗？看 DATABASE_URL');
      }
    }
  }

  // ── 6. 图床上传体积（只读探针）────────────────────────────────────────────
  console.log(bold('\n6. 图床上传体积（nginx client_max_body_size）'));
  if (!logged) {
    skipped('图床探针', '登录没成功');
  } else {
    // 2MB 但内容不是 PNG：穿过 nginx 后必被应用以 400 拒掉（校验在写盘前，
    // 也不消耗配额），什么都不会存。413 则说明根本没穿过 nginx。
    const junk = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const fd = new FormData();
    fd.append('file', new Blob([junk], { type: 'image/png' }), 'smoke-probe.png');
    const r = await fetch(`${base}/api/images`, {
      method: 'POST',
      headers: { cookie, origin: base },
      body: fd,
    });
    if (r.status === 413) {
      bad(
        '2MB 上传被回 413 —— nginx 把请求挡在门外了，图床只能传 1MB 以下的图',
        'nginx 加 client_max_body_size 12m（见 §3.8 与 nginx.conf.example）'
      );
    } else if (r.status === 400) {
      ok('2MB 请求穿过了 nginx（应用以 400 拒掉非法内容，未存任何数据）');
    } else {
      const t = await r.text();
      bad(`图床探针返回意外的 ${r.status}：${t.slice(0, 120)}`);
    }
  }
}

// ── 7. 角色门控 ─────────────────────────────────────────────────────────────
console.log(bold('\n7. 门控'));
try {
  const anon = await fetch(`${base}/blog`, { redirect: 'manual' });
  if (anon.status === 403) ok('未登录访问 /blog → 403（对齐 Flask 的 abort(403)）');
  else if (anon.status === 200) bad('未登录也能看 /blog —— 核心用户门槛没生效');
  else ok(`未登录访问 /blog → HTTP ${anon.status}`);

  const admin = await fetch(`${base}/admin`, { redirect: 'manual' });
  if (admin.status === 307 || admin.status === 302) {
    const loc = admin.headers.get('location') ?? '';
    if (loc.includes('next=')) ok('未登录访问 /admin → 跳登录页且带回跳地址');
    else bad(`/admin 跳转但没带 ?next=：${loc}`);
  } else {
    bad(`未登录访问 /admin → HTTP ${admin.status}，预期跳转到登录页`);
  }
} catch (e) {
  bad(`门控检查失败：${String(e).split('\n')[0]}`);
}

console.log(bold('\n═══ 结论 ═══'));
if (fail) {
  console.log(red(`  ❌ ${fail} 项失败${skip ? `，${skip} 项跳过` : ''} —— 按上面的 → 处理\n`));
  process.exit(1);
}
console.log(green(`  ✅ 全部通过${skip ? `（${skip} 项跳过 —— 给上 --user/--pass 能覆盖更多）` : ''}\n`));
