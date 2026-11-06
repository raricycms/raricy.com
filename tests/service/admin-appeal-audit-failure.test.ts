// ─────────────────────────────────────────────────────────────────────────────
// admin-appeal-audit-failure.test.ts —— 审计写入失败不回滚裁决（R3-414）
//
// 【为什么单开一个文件】要模拟「logAdminAction 抛错」，最干净的做法是在模块层
// 打桩；而 admin-user-and-appeal.test.ts 通篇依赖真实的 logAdminAction（它自己的
// 断言就是「真的写了一行审计」）。为一条用例把整个文件的模块桩起来不划算，也容易
// 让其余 80 条用例从「真库」退化成「mock 库」。
//
// 【钉住的行为】裁决的状态迁移已提交之后，审计写入失败只该被吞掉：
//   · adjudicate 仍返回 ok（不能把已完成的状态改动报成 500 / exit 1）
//   · status 已落定
//   · 通知照发
//   · 只缺那一条 decide_appeal 审计行
// 这正是 R3-414 的「半写」面：旧实现里 logAdminAction 抛错会让路由 500。
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { logAdminActionMock } = vi.hoisted(() => ({
  logAdminActionMock: vi.fn(async () => {
    throw new Error('audit backend down');
  }),
}));

vi.mock('@/lib/admin-user-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin-user-service')>();
  return { ...actual, logAdminAction: logAdminActionMock };
});

import { resetDb, makeUser, prisma } from '../helpers/db';
import { nowForDb } from '@/lib/db-time';
import { adjudicate } from '@/lib/admin-appeal-service';
import type { SafeUser } from '@/lib/auth';

const asActor = (u: { id: string; role: string }) => u as unknown as SafeUser;

beforeEach(async () => {
  await resetDb();
  logAdminActionMock.mockClear();
});

describe('adjudicate：审计写入抛错', () => {
  it('仍返回 ok、状态已落定、通知照发，只缺 decide_appeal 审计行', async () => {
    const owner = await makeUser({ role: 'owner' });
    const target = await makeUser({ role: 'core' });

    const log = await prisma.adminActionLog.create({
      data: {
        action: 'other_action',
        adminId: owner.id,
        targetUserId: target.id,
        reason: 'r',
        visibility: 'public',
        createdAt: nowForDb(),
      },
      select: { id: true },
    });
    const appeal = await prisma.adminActionAppeal.create({
      data: {
        logId: log.id,
        appellantId: target.id,
        content: '我不服',
        status: 'pending',
        createdAt: nowForDb(),
        updatedAt: nowForDb(),
      },
      select: { id: true },
    });

    const r = await adjudicate({
      actor: asActor(owner),
      appealId: appeal.id,
      decision: 'accept',
    });
    expect(r.ok, '审计失败不能把已完成的裁决报成失败').toBe(true);
    expect(logAdminActionMock, '确实尝试写过审计').toHaveBeenCalledTimes(1);

    expect((await prisma.adminActionAppeal.findUnique({ where: { id: appeal.id } }))!.status).toBe(
      'accepted'
    );
    expect(
      await prisma.adminActionLog.count({
        where: { action: 'decide_appeal', objectId: String(appeal.id) },
      })
    ).toBe(0);
    // 通知不因审计失败而丢
    expect(await prisma.notification.count({ where: { action: '申诉结果' } })).toBe(1);
  });
});
