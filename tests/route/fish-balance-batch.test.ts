// POST /api/fish/balance/batch —— 公开批量余额读口。
//
// 【为什么单独打 route】它**免登录**、接受任意 JSON 数组，是 Prisma `in` 之前唯一的
// 信任边界：元素不是字符串时若原样透传，Prisma 客户端校验抛错 → 500（公开接口的
// 畸形请求应是 400）。另一个坑是 >500 个 id 被**静默截断** —— 调用方无法区分
// 「这个 id 没被查」与「余额为 0」，对账会漏账，所以响应必须带可观察标记。
//
// 【DB】真实 SQLite（tests/.tmp/test-*），route 直接打库，没有可 mock 的替身。

import { describe, it, expect, beforeEach } from 'vitest';
import { POST } from '@/app/api/fish/balance/batch/route';
import { BALANCE_BATCH_MAX } from '@/lib/fish-service';
import { resetDb, makeUser } from '../helpers/db';

function batchReq(body: unknown) {
  return new Request('http://localhost/api/fish/balance/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDb();
});

describe('POST /api/fish/balance/batch', () => {
  it('正常返回 balances 映射，truncated=false', async () => {
    const a = await makeUser({ driedFish: 10 });
    const b = await makeUser({ driedFish: 3.5 });

    const res = await POST(batchReq({ user_ids: [a.id, b.id] }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.balances).toEqual({ [a.id]: 10, [b.id]: 3.5 });
    expect(json.truncated).toBe(false);
  });

  it('★ 元素不是字符串 / 缺字段 / 非数组 → 400（而不是 Prisma 校验抛错变成 500）', async () => {
    for (const bad of [[1], [null], [{ a: 1 }], ['ok', 2]]) {
      const res = await POST(batchReq({ user_ids: bad }));
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect((await res.json()).message).toContain('字符串');
    }
    for (const body of [{}, { user_ids: 'abc' }, { user_ids: { 0: 'a' } }]) {
      expect((await POST(batchReq(body))).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('★ 截断必须可观察：501 个 → truncated:true 且只查前 500；恰好 500 个 → false', async () => {
    const over = await POST(
      batchReq({ user_ids: Array.from({ length: BALANCE_BATCH_MAX + 1 }, (_, i) => `id-${i}`) })
    );
    expect(over.status, '截断保持 200（向后兼容）').toBe(200);
    const json = await over.json();
    expect(json.truncated, '截断必须可观察，否则对账分不清「没查」与「余额 0」').toBe(true);
    expect(Object.keys(json.balances)).toHaveLength(BALANCE_BATCH_MAX);
    expect(json.balances['id-499']).toBe(0);
    expect(json.balances['id-500'], '第 501 个应当没被查').toBeUndefined();

    const exact = await (
      await POST(batchReq({ user_ids: Array.from({ length: BALANCE_BATCH_MAX }, (_, i) => `id-${i}`) }))
    ).json();
    expect(exact.truncated, '边界不误报').toBe(false);

    const empty = await POST(batchReq({ user_ids: [] }));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ balances: {}, truncated: false });
  });
});
