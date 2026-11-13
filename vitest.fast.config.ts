// `npm run test:fast` —— 日常门禁的精选快层：只跑风险面用例，目标 ≤90s。
//
// 【选面原则】钱/账本、鉴权/会话、可见性/匿名、迁移/数据变换、限频、时间语义、
// 净化（XSS/SSRF/路径）、对外契约（bot/CLI/OAuth/公开 API 形状）。
// 全量口径与取舍见 `docs/plan/test-suite-audit.md`；增删此清单时同步 §5 与 docs/testing.md。
//
// 【为什么不直接跑 tests/unit】unit 层 2,896 条用例的墙钟并不低（每文件隔离开销），
// 而且大部分与风险面无关；快层要的是「改一次代码 1 分钟内拿到可信信号」。
import { defineConfig } from 'vitest/config';
import { sharedTestOptions, sharedResolve, sharedEsbuild } from './vitest.shared';

export const FAST_SPECS = [
  // 钱 / 账本 / 幂等
  'tests/service/fish-service.test.ts',
  'tests/service/fish-compensate.test.ts',
  'tests/service/fish-admin.test.ts',
  'tests/service/fish-token-service.test.ts',
  'tests/service/fish-ledger-helper.test.ts',
  'tests/service/webhook-deadline.test.ts',
  'tests/route/fish-tokens.test.ts',
  'tests/route/fish-balance-batch.test.ts',
  'tests/unit/fish-amount.test.ts',
  'tests/unit/fish-credential-list-cli.test.ts',
  // 鉴权 / 会话 / 越权 / CSRF
  'tests/route/chat-auth.test.ts',
  'tests/route/read-auth.test.ts',
  'tests/route/spider-auth.test.ts',
  'tests/route/security-access.test.ts',
  'tests/route/vote-auth.test.ts',
  'tests/route/categories-auth.test.ts',
  'tests/route/oauth-revoke.test.ts',
  'tests/route/oauth-unbind-code.test.ts',
  'tests/route/stream-session.test.ts',
  'tests/unit/rate-limit.test.ts',
  'tests/unit/session.test.ts',
  'tests/unit/auth-roles.test.ts',
  'tests/unit/webhook-url.test.ts',
  // 可见性 / 匿名
  'tests/route/blog-visibility-write.test.ts',
  // 迁移 / 数据变换（只读 fixtures，不含空库全量 up）
  'tests/service/reactive-v07-migration.test.ts',
  'tests/unit/migrate-url.test.ts',
  'tests/unit/checkin-migrations.test.ts',
  'tests/unit/daily-quote-migrations.test.ts',
  'tests/unit/appeal-pending-migration.test.ts',
  'tests/unit/fish-migration-21.test.ts',
  'tests/unit/market-direction-migration.test.ts',
  // 对外契约 / 管理面
  'tests/unit/audit-actions.test.ts',
  'tests/unit/audit-log-cli.test.ts',
  'tests/unit/md-editor-reactive-authoring.test.ts',
];

export default defineConfig({
  test: {
    ...sharedTestOptions,
    include: FAST_SPECS,
    minWorkers: 1,
    maxWorkers: 4,
  },
  esbuild: sharedEsbuild,
  resolve: sharedResolve,
});
