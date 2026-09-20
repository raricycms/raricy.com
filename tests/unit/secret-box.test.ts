// secret-box.ts —— 落盘密钥的对称加解密。
//
// 【这个文件里最重要的是金标准那条】派生方式（sha256 → base64url → Fernet）是**冻结**的。
// 它现在服务的是 **FishWebhookEndpoint.secretEncrypted**（回调的签名密钥）：
// 改了派生，全部存量密文一次性变成解不开的乱码，商户再也收不到回调 ——
// 而错误信息只会说「解密失败」，**且不可逆**。所以这里钉一个**由重构之前的实现产出的
// 密文**：只要它还能解开，派生方式就没被动过。
//
// ⚠️ 这个金标准密文原本是 `account-client.encryptApiKey` 产出的（用户发往站外账户
// 微服务的 API Key）。那个服务与那个函数都已不存在，**但密文照旧有效** ——
// 两处凭证当年共用同一套派生，所以它验的还是同一件事。别因为「产出它的函数没了」
// 就把它一起删掉：它是这个文件唯一的跨版本锚点。
//
// ⚠️ 「两份实现互通」那种测法在这里是**不够的**：如果有人把两份实现一起改
// （比如一起换掉哈希或编码），互通测试照样绿，而存量密文已经废了。
// 只有硬编码的历史密文能挡住这种改法 —— 它没有「另一份实现」可以一起改。

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  sealSecret,
  openSecret,
  generateSecret,
  SecretBoxError,
} from '@/lib/secret-box';

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
  it('能解开跨版本产出的密文 —— 派生方式没被动过', () => {
    expect(openSecret(GOLDEN_CIPHER, KEY)).toBe(GOLDEN_PLAIN);
  });

  it('回调签名密钥走的是同一套派生（金标准密文也能当签名密钥用）', () => {
    // 直接测 fish-webhook-service 用的那两个函数 —— 它与金标准密文之间不能有分叉。
    expect(openSecret(sealSecret(GOLDEN_PLAIN, KEY), KEY)).toBe(GOLDEN_PLAIN);
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

describe('错误语义面（供排障读）', () => {
  // 这里原有一组「解密失败必须抛 AccountServiceError(503)」的用例 —— 那个错误类型是
  // 账户微服务时代的 fail-closed 契约（调用方靠 503 判定「这笔没成交、要补偿」）。
  // 那台服务搬进站内之后该契约随之消失，**剩下的调用方只有一个**：
  // fish-webhook-service 在投递前解开签名密钥，解不开就是投递失败（走它自己的重试）。
  // 所以现在只需要一条：失败**抛异常而不是返回空串**（返回空串 = 用空密钥签名，
  // 商户会拒绝所有回调，而我们这边看起来一切正常）。

  it('密钥来源为空时抛 SecretBoxError，绝不返回空串', () => {
    expect(() => openSecret(GOLDEN_CIPHER, '')).toThrow(SecretBoxError);
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
