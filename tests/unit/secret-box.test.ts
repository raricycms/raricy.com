// secret-box.ts —— 落盘密钥的对称加解密。
//
// 【这个文件里最重要的是金标准那条】派生方式（sha256 → base64url → Fernet）是**冻结**的：
// 改了它，库里所有 User.fishApiKeyEncrypted 一次性变成解不开的乱码 —— 表现为
// 全站鱼干写路径 503，而错误信息只会说「解密失败」。所以这里钉一个**由重构之前的
// 实现产出的密文**：只要它还能解开，派生方式就没被动过。
//
// ⚠️ 「两份实现互通」那种测法在这里是**不够的**：如果有人把 account-client 与
// secret-box 一起改（比如一起换掉哈希或编码），互通测试照样绿，而存量密文已经废了。
// 只有硬编码的历史密文能挡住这种改法 —— 它没有「另一份实现」可以一起改。

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  sealSecret,
  openSecret,
  generateSecret,
  SecretBoxError,
} from '@/lib/secret-box';
import { encryptApiKey, decryptApiKey } from '@/lib/account-client';

const KEY = 'golden-key-source';

/**
 * 金标准：由**重构前**的 account-client.encryptApiKey 产出
 * （FISH_ENCRYPTION_KEY=golden-key-source，明文 'raricy-golden-fixture'）。
 *
 * ⚠️ 这个字面量**不许重新生成**。它一变，就说明派生方式变了 —— 那不是「更新用例」，
 *    那是一次会让所有存量密文失效的破坏性变更，必须先有迁移方案。
 */
const GOLDEN_CIPHER =
  'gAAAAABqrmVr6fwQct2cz2IMsL518rqDRvPI3mtrAnVrrAlWjy0Fgl1A5CjsASdV2k1lcEfwieudFTyXNanBvw5rO9whl_Xm8Wc2s8yviQ7-GHsDKRzYurs=';
const GOLDEN_PLAIN = 'raricy-golden-fixture';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('★ 派生方式冻结（金标准）', () => {
  it('能解开重构前产出的密文 —— 派生方式没被动过', () => {
    expect(openSecret(GOLDEN_CIPHER, KEY)).toBe(GOLDEN_PLAIN);
  });

  it('account-client 的 decryptApiKey 也能解开它（同一套派生）', () => {
    expect(decryptApiKey(GOLDEN_CIPHER, { encryptionKeySource: KEY } as never)).toBe(GOLDEN_PLAIN);
  });
});

describe('往返与错误路径', () => {
  it('seal → open 还原明文', () => {
    const c = sealSecret('hello', KEY);
    expect(c).not.toContain('hello');
    expect(openSecret(c, KEY)).toBe('hello');
  });

  it('Fernet 是随机 IV：同一明文两次加密得到不同密文，但都能解开', () => {
    const a = sealSecret('same', KEY);
    const b = sealSecret('same', KEY);
    expect(a).not.toBe(b);
    expect(openSecret(a, KEY)).toBe('same');
    expect(openSecret(b, KEY)).toBe('same');
  });

  it('换一个密钥来源 → 解不开（抛 SecretBoxError）', () => {
    const c = sealSecret('secret', KEY);
    expect(() => openSecret(c, 'another-key')).toThrow(SecretBoxError);
  });

  it('密文损坏 → 抛 SecretBoxError', () => {
    expect(() => openSecret('not-a-fernet-token', KEY)).toThrow(SecretBoxError);
  });

  it('空密钥来源 → 抛（静默用空串当密钥等于把密文变成明文）', () => {
    expect(() => sealSecret('x', '')).toThrow(SecretBoxError);
    expect(() => openSecret(GOLDEN_CIPHER, '')).toThrow(SecretBoxError);
  });

  it('空密文 → 抛，而不是返回空串', () => {
    expect(() => openSecret('', KEY)).toThrow(SecretBoxError);
  });

  it('Unicode 明文往返（回调 payload 里有中文）', () => {
    const s = '收到「张三」的转账：订单 42 ✓';
    expect(openSecret(sealSecret(s, KEY), KEY)).toBe(s);
  });
});

describe('account-client 的错误语义没被改掉（fail-closed 契约）', () => {
  // 这两个 503 是 fish-sync 判定「这笔没成交、要补偿」的依据。
  // 抽 secret-box 时最容易顺手把它们改成普通 Error —— 那会让补偿逻辑认不出来。
  it('decryptApiKey 失败抛的是 AccountServiceError(503)，不是 SecretBoxError', () => {
    expect(() =>
      decryptApiKey('not-a-token', { encryptionKeySource: KEY } as never)
    ).toThrowError(
      expect.objectContaining({ name: 'AccountServiceError', status: 503 })
    );
  });

  it('缺少密钥来源时抛 AccountServiceError(503)', () => {
    expect(() => decryptApiKey(GOLDEN_CIPHER, { encryptionKeySource: '' } as never)).toThrowError(
      expect.objectContaining({ name: 'AccountServiceError', status: 503 })
    );
  });

  it('encryptApiKey / decryptApiKey 往返一致（重构没改行为）', () => {
    const c = encryptApiKey('user-key-abc', { encryptionKeySource: KEY } as never);
    expect(decryptApiKey(c, { encryptionKeySource: KEY } as never)).toBe('user-key-abc');
  });
});

describe('generateSecret', () => {
  it('产出 url-safe 的随机串，两次不同', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(a).not.toBe(b);
  });
});
