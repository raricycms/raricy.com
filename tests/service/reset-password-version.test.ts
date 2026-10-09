import { beforeEach, expect, it, vi } from 'vitest';
import { resetDb, makeUser, prisma } from '../helpers/db';
import { resetUserPassword } from '@/lib/admin-user-service';
import { hashPassword } from '@/lib/password';
vi.mock('@/lib/password', async (original) => ({
  ...await original<typeof import('@/lib/password')>(), hashPassword: vi.fn(),
}));
beforeEach(async () => { await resetDb(); vi.mocked(hashPassword).mockReset(); });

it('管理员重置在计算密码期间发生其他撤权，版本只能继续递增', async () => {
  const owner = await makeUser({ role: 'owner' });
  const user = await makeUser({ sessionVersion: 0 });
  let release!: (hash: string) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  vi.mocked(hashPassword).mockImplementationOnce(() => {
    entered();
    return new Promise<string>((resolve) => { release = resolve; });
  });
  const resetting = resetUserPassword({ actor: owner, targetId: user.id,
    newPassword: 'replacement-password', reason: 'security test' });
  await started;
  await prisma.user.update({ where: { id: user.id }, data: { sessionVersion: { increment: 3 } } });
  release('replacement-hash');
  const result = await resetting;
  expect(result).toMatchObject({ ok: true, sessionVersion: 4 });
  expect(await prisma.user.findUnique({ where: { id: user.id }, select: { sessionVersion: true } }))
    .toEqual({ sessionVersion: 4 });
});
