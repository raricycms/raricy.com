// password.ts —— 与 Flask/werkzeug 的密码哈希互通。
//
// 这是整个迁移里最不能出错的一环：哈希不互通 = 465 个用户全部登不进来。
//
// 下方 WERKZEUG_* 夹具是 **Python werkzeug 3.1.8 真实生成** 的（非手写），
// 生成时已在 Python 侧用 check_password_hash 正/负向自校验过。
// 复现方式：
//   python3.13 -m venv /tmp/wz && /tmp/wz/bin/pip install werkzeug
//   /tmp/wz/bin/python -c "from werkzeug.security import generate_password_hash as g; print(g('correct horse battery staple', method='scrypt'))"
// 用真哈希才能真正验证「Flask 生成 → Node 校验」这个方向；自产自销的往返测不了这个。

import { describe, it, expect } from 'vitest';
import { verifyPassword, hashPassword } from '@/lib/password';

// ── 来自 Python werkzeug 的真实哈希 ─────────────────────────────────────────
const WERKZEUG_SCRYPT_ASCII = {
  password: 'correct horse battery staple',
  hash: 'scrypt:32768:8:1$pktwRRgbYcJwSFJs$1e03c320ff6fc98c2c10968a06ea6208ebbf2aff1ed4cb9a0c262b98667a22e5d1beef489d56a084bb70749d918c8fc97ed7fae6f670c9fda73a0ed0f51b6f8a',
};
const WERKZEUG_SCRYPT_UNICODE = {
  password: '一个中文密码 with spaces & !@#$%',
  hash: 'scrypt:32768:8:1$XiStffjJRkb8d1AN$4e66122c241d643eb70f76ed7ac25229b572bca0db95ccedc10e4f32243a143e99657c98d0fa9d4e61ffaff2d7f508627cecea6d40bd35f173483da82816cc6e',
};
const WERKZEUG_SCRYPT_EMPTY = {
  password: '',
  hash: 'scrypt:32768:8:1$aKdsW2aBTx7WRr8S$3c7ee4ae9347be96af65ddcad87293caeaa565a768d4da9070e9cf25eca58449852096e7510a05cbd94fbc788208ed4f9c73a5ffb837cbc44440218c35a39ebd',
};
const WERKZEUG_PBKDF2 = {
  password: 'legacy-pbkdf2-user',
  hash: 'pbkdf2:sha256:1000000$0GVZ02AQIsWMIzBm$7948e0e65f8651432dd6b0d1d02dc07367e9307f42bf7c990ce32e43bea6e644',
};

describe('Flask → Node：校验 werkzeug 真实生成的 scrypt 哈希', () => {
  it('ASCII 密码校验通过', async () => {
    await expect(
      verifyPassword(WERKZEUG_SCRYPT_ASCII.password, WERKZEUG_SCRYPT_ASCII.hash)
    ).resolves.toBe(true);
  });

  it('中文 + 空格 + 符号的密码校验通过（UTF-8 编码一致）', async () => {
    await expect(
      verifyPassword(WERKZEUG_SCRYPT_UNICODE.password, WERKZEUG_SCRYPT_UNICODE.hash)
    ).resolves.toBe(true);
  });

  it('空密码校验通过', async () => {
    await expect(
      verifyPassword(WERKZEUG_SCRYPT_EMPTY.password, WERKZEUG_SCRYPT_EMPTY.hash)
    ).resolves.toBe(true);
  });

  it('密码错一个字符即失败（不是永远返回 true）', async () => {
    await expect(
      verifyPassword(WERKZEUG_SCRYPT_ASCII.password + 'x', WERKZEUG_SCRYPT_ASCII.hash)
    ).resolves.toBe(false);
    await expect(
      verifyPassword('Correct horse battery staple', WERKZEUG_SCRYPT_ASCII.hash)
    ).resolves.toBe(false);
    // 空密码不能通过非空哈希
    await expect(verifyPassword('', WERKZEUG_SCRYPT_ASCII.hash)).resolves.toBe(false);
  });

  it('非空密码不能通过空密码的哈希', async () => {
    await expect(verifyPassword('x', WERKZEUG_SCRYPT_EMPTY.hash)).resolves.toBe(false);
  });
});

describe('Flask → Node：校验 werkzeug 真实生成的 pbkdf2 哈希（旧用户）', () => {
  it('pbkdf2:sha256 校验通过', async () => {
    await expect(
      verifyPassword(WERKZEUG_PBKDF2.password, WERKZEUG_PBKDF2.hash)
    ).resolves.toBe(true);
  });

  it('pbkdf2 密码错误时返回 false', async () => {
    await expect(verifyPassword('wrong', WERKZEUG_PBKDF2.hash)).resolves.toBe(false);
  });
});

describe('Node → Flask：hashPassword 的输出格式必须是 Flask 能校验的', () => {
  it('输出符合 werkzeug scrypt 规范 scrypt:32768:8:1$salt$hex(128)', async () => {
    const h = await hashPassword('my-password-123');
    const m = h.match(/^scrypt:(\d+):(\d+):(\d+)\$([A-Za-z0-9]+)\$([0-9a-f]+)$/);
    expect(m, `不符合 werkzeug 格式: ${h}`).not.toBeNull();
    const [, N, r, p, salt, hex] = m!;
    expect(Number(N)).toBe(32768); // 与 werkzeug 默认一致，否则 Flask 侧参数对不上
    expect(Number(r)).toBe(8);
    expect(Number(p)).toBe(1);
    expect(salt.length).toBe(16); // werkzeug 默认 salt 长度
    expect(hex.length).toBe(128); // dklen=64 → 128 hex 字符
  });

  it('自产自销往返成功', async () => {
    const pw = '一个中文密码 with spaces & symbols !@#$%';
    const h = await hashPassword(pw);
    await expect(verifyPassword(pw, h)).resolves.toBe(true);
    await expect(verifyPassword(pw + 'x', h)).resolves.toBe(false);
  });

  it('同一密码两次哈希不同（salt 随机），但都能校验', async () => {
    const pw = 'same-password';
    const [h1, h2] = [await hashPassword(pw), await hashPassword(pw)];
    expect(h1).not.toBe(h2);
    await expect(verifyPassword(pw, h1)).resolves.toBe(true);
    await expect(verifyPassword(pw, h2)).resolves.toBe(true);
  });
});

describe('健壮性：畸形输入必须返回 false 而不是抛异常（否则登录 500）', () => {
  const BAD = [
    '',
    'garbage',
    'scrypt:32768:8:1$onlytwoparts',
    'scrypt:notanumber:8:1$salt$abcd',
    'scrypt:32768:8:1$salt$nothex_zzzz',
    'unknownalgo:1$salt$abcd',
    'pbkdf2:sha256:badcount$salt$abcd',
    '$$$',
    'scrypt:32768:8:1$$',
  ];
  for (const bad of BAD) {
    it(`畸形哈希不抛异常: ${JSON.stringify(bad).slice(0, 40)}`, async () => {
      await expect(verifyPassword('x', bad)).resolves.toBe(false);
    });
  }
});
