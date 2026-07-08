#!/usr/bin/env python
"""历史数据迁移脚本 — 为现有用户创建远程账户，一次性迁移全部历史鱼干余额。

设计原则（2026-07-08 更新）：
    签到记录（DailyCheckIn）和鱼干流水（账户服务 ledger）是两个独立维度：
    - 签到由博客业务负责，存储在 daily_check_ins 表
    - 鱼干账本由账户服务负责，存储在账户服务 ledger
    两者不应当耦合。

    因此历史迁移只做一件事：把每个用户当前的 `User.dried_fish` 全量转账到
    远端账户（一条 `migration_init` 流水）。本地历史 FishTransaction（包括
    历年签到、admin_grant、feed 等）不再逐条回放——它们的净效果已经体现在
    `User.dried_fish` 里，全量转账等于"历史交易 + 初始余额"的总和。

    之后每次签到 / 投喂 / 管理发放都按正常流程产生一条新的 ledger 条目，
    `created_at` 是真实业务时间，不再有"所有历史记录挤在迁移日"的问题。

Usage:
    # 仅为所有用户创建远程账户（幂等，安全重复运行）
    python scripts/migrate_fish_data.py --create-accounts

    # 全量迁移历史鱼干余额：每个用户 SYSTEM → user 一次性转账
    python scripts/migrate_fish_data.py --sync-balances

    # 完整迁移（开户 + 全量余额迁移）
    python scripts/migrate_fish_data.py --all

    # 修复 Phase 1 best-effort 双写阶段残留的余额差异（谨慎使用）
    python scripts/migrate_fish_data.py --fix-discrepancies

    # 仅检查状态（dry-run）
    python scripts/migrate_fish_data.py --dry-run

需先配置 .env 中的 ACCOUNT_SERVICE_URL、ACCOUNT_SYSTEM_KEY、ACCOUNT_SERVICE_INTERNAL_TOKEN。

限频说明：
    账户服务各端点有速率限制（create 20/秒、transfer 10/秒），本脚本通过
    throttled_call() 主动节流（limit+5% 余量）避开限速，并在收到 429 时
    指数退避重试最多 3 次（0.5s → 1s → 2s）。
"""

import sys
import os
import argparse
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import create_app
from app.models.user import User
from app.models.fish import FishTransaction
from app.clients import AccountClient
from app.clients.account_client import AccountClientError


# ── 限频策略 ──────────────────────────────────────────────
# 账户服务各端点的限速（见 account-service/app/api/v1/）：
#   POST /api/v1/accounts               — 20/秒
#   POST /api/v1/transfers              — 10/秒
#   POST /api/v1/accounts/balances/batch — 20/秒
#   GET  /api/v1/accounts/{id}/balance  — 100/秒
# 主动节流按"limit + 5% 余量"取倒数，确保不撞限速；遇到 429 再退避重试。
THROTTLE_SECONDS_CREATE_ACCOUNT = 1.05 / 20  # ~52ms
THROTTLE_SECONDS_TRANSFER = 1.05 / 10        # ~105ms

# 429 重试配置：最多 3 次，指数退避 0.5s → 1s → 2s
MAX_429_RETRIES = 3
RETRY_BACKOFF_BASE = 0.5


def throttled_call(fn, throttle_seconds, *args, **kwargs):
    """以固定速率调用 fn；遇到 429 时指数退避重试。

    Args:
        fn: 要调用的 AccountClient 方法（如 client.create_account）。
        throttle_seconds: 每次调用前 sleep 的秒数（主动节流，避免撞限速）。
        *args, **kwargs: 透传给 fn 的位置参数和关键字参数。

    Returns:
        fn 的返回值。

    Raises:
        AccountClientError: 非 429 错误立即抛出；429 重试耗尽后抛出最后一次的错误。
    """
    last_error = None
    for attempt in range(MAX_429_RETRIES + 1):
        time.sleep(throttle_seconds)
        try:
            return fn(*args, **kwargs)
        except AccountClientError as e:
            if e.code != 429:
                raise
            last_error = e
            if attempt < MAX_429_RETRIES:
                backoff = RETRY_BACKOFF_BASE * (2 ** attempt)
                print(
                    f"  [RATE] {fn.__name__} 触发 429，"
                    f"{backoff:.1f}s 后重试 ({attempt + 1}/{MAX_429_RETRIES})..."
                )
                time.sleep(backoff)
    assert last_error is not None
    raise last_error


def create_accounts(app):
    """为所有用户创建远程账户（幂等）。"""
    client = app.account_client
    users = User.query.all()
    created = 0
    skipped = 0
    errors = 0

    for user in users:
        try:
            result = throttled_call(
                client.create_account, THROTTLE_SECONDS_CREATE_ACCOUNT, user.id,
            )
            if result.get('api_key'):
                created += 1
                print(f"  [NEW] {user.username} — 账户已创建")
            else:
                skipped += 1
        except Exception as e:
            errors += 1
            print(f"  [ERR] {user.username} — {e}")

    print(f"\n创建账户完成: 新建 {created}, 已存在 {skipped}, 失败 {errors}")
    return errors == 0


def sync_balances(app):
    """全量迁移历史鱼干余额。

    设计：每个用户的 `User.dried_fish` 是所有历史交易（签到、admin_grant、
    feed、purchase、transfer 等）加减之后的净结果。把这个净余额一次性
    转账到远端，等于"完整还原历史账目"。

    - 入口类型：entry_type = 'migration_init'
    - 幂等键：`migrate-init-{user_id}`，已迁移过的用户重跑不会双倍转账
      （账户服务的 IdempotencyKey 会返回首次的缓存结果）
    - 用户后续签到 / 投喂 / 管理发放走各自的 entry_type，与本次迁移独立

    适用场景：
    - 首次迁移：所有用户都还没远端余额，跑一次即可
    - 重跑：幂等键 + 后续业务交易各自记账，安全
    """
    client = app.account_client
    system = AccountClient.SYSTEM_USER_ID

    users = User.query.all()
    migrated = 0
    skipped_zero = 0
    skipped_idempotent = 0
    errors = 0

    for user in users:
        local = float(user.dried_fish or 0.0)

        if local <= 0.01:
            skipped_zero += 1
            continue

        idempotency_key = f"migrate-init-{user.id}"
        try:
            throttled_call(
                client.transfer, THROTTLE_SECONDS_TRANSFER,
                from_user_id=system,
                to_user_id=user.id,
                amount=local,
                entry_type='migration_init',
                description=f'历史鱼干余额全量迁移（{user.username}）',
                metadata={
                    'reason': 'full_balance_migration',
                    'local_balance_before': local,
                },
                idempotency_key=idempotency_key,
            )
            migrated += 1
            print(f"  [MIG]  {user.username} — 迁移 +{local:.2f}")
        except AccountClientError as e:
            # 幂等命中（同一 key 之前已成功）— 账户服务会返回与首次相同的结果，
            # 但有些实现可能抛 409/422。这里按"已迁移过"处理，避免重复转账。
            if e.code in (409, 422) and 'idempot' in str(e).lower():
                skipped_idempotent += 1
                print(f"  [IDEM] {user.username} — 已迁移过（{idempotency_key}）")
            else:
                errors += 1
                print(f"  [ERR]  {user.username} — {e}")
        except Exception as e:
            errors += 1
            print(f"  [ERR]  {user.username} — {e}")

    print(
        f"\n全量迁移完成: 迁移 {migrated}, 余额为0 跳过 {skipped_zero}, "
        f"已迁移过 跳过 {skipped_idempotent}, 失败 {errors}"
    )
    return errors == 0


def fix_discrepancies(app, tolerance: float = 0.01):
    """修复本地/远程余额差异。

    场景：Phase 1 best-effort 双写被吞的历史失败流水（如投喂本地扣款但远端没同步、
    签到本地加款但远端没同步）。在修 422 + fail-closed 之后不会再产生新差异，
    但存量差异需手动修复。

    注意：`--sync-balances` 走幂等键不会重复转账；本函数走 `migration_adjust`
    类型的 entry_type，是另一条独立账目，专门用于"发现本地和远端不一致时补齐"。

    策略：
    - 遍历用户，对比本地 `dried_fish` 与远程余额
    - 若 |差异| > tolerance：调用 transfer 补齐差额
      - local > remote：SYSTEM → user（增发本地多出的部分）
      - local < remote：user → SYSTEM（回收本地少的部分）
    - entry_type = 'migration_adjust'
    - 幂等键 = `migrate-adjust-{user_id}-{round(diff, 2)}`：相同 diff 重复执行不会双倍调整

    注意：
    - 此操作直接改远端账本，请在排查差异来源后执行
    - 若用户无 API Key（create-accounts 未执行），跳过并在日志中提示
    """
    # get_balance 限速 100/秒；此处只调用一次/用户，远高于实际限速，故不主动节流，
    # 但 429 重试仍由 throttled_call 负责。
    GET_BALANCE_THROTTLE = 1.05 / 100  # ~10ms — 主动节流作为兜底

    client = app.account_client
    system = AccountClient.SYSTEM_USER_ID

    users = User.query.order_by(User.username).all()

    fixed = 0
    skipped = 0
    errors = 0

    for user in users:
        if not user.fish_api_key_encrypted:
            print(f"  [SKIP] {user.username} — 无 API Key，先跑 --create-accounts")
            skipped += 1
            continue

        try:
            remote = float(throttled_call(
                client.get_balance, GET_BALANCE_THROTTLE, user.id,
            ))
        except Exception as e:
            print(f"  [ERR]  {user.username} — 远程余额查询失败: {e}")
            errors += 1
            continue

        local = float(user.dried_fish or 0.0)
        diff = round(local - remote, 2)

        if abs(diff) <= tolerance:
            continue

        # 幂等键只允许 [a-zA-Z0-9_-]，把金额小数点去掉、用整数 cents
        amount_cents = int(round(abs(diff) * 100))
        direction = '补齐' if diff > 0 else '回收'
        try:
            if diff > 0:
                # 本地多 → 系统向用户增发
                throttled_call(
                    client.transfer, THROTTLE_SECONDS_TRANSFER,
                    from_user_id=system,
                    to_user_id=user.id,
                    amount=abs(diff),
                    entry_type='migration_adjust',
                    description=f'历史双写差异修复（本地多 {diff:+.2f}）',
                    metadata={
                        'reason': 'balance_discrepancy_fix',
                        'direction': 'grant',
                        'local_before': local,
                        'remote_before': remote,
                    },
                    idempotency_key=f"migrate-adjust-{user.id}-p{amount_cents}",
                )
            else:
                # 本地少 → 用户向系统退回
                throttled_call(
                    client.transfer, THROTTLE_SECONDS_TRANSFER,
                    from_user_id=user.id,
                    to_user_id=system,
                    amount=abs(diff),
                    entry_type='migration_adjust',
                    description=f'历史双写差异修复（本地少 {diff:+.2f}）',
                    metadata={
                        'reason': 'balance_discrepancy_fix',
                        'direction': 'deduct',
                        'local_before': local,
                        'remote_before': remote,
                    },
                    idempotency_key=f"migrate-adjust-{user.id}-m{amount_cents}",
                )
            print(f"  [FIX]  {user.username} — {direction} {abs(diff):.2f}（本地={local:.2f}, 远程={remote:.2f}）")
            fixed += 1
        except AccountClientError as e:
            print(f"  [ERR]  {user.username} — transfer 失败: {e}")
            errors += 1

    print(f"\n差异修复完成: 修复 {fixed}, 跳过 {skipped}, 失败 {errors}")
    return errors == 0


def dry_run(app):
    """检查状态但不执行任何操作。"""
    client = app.account_client
    users = User.query.all()

    has_key = 0
    no_key = 0
    balance_ok = 0
    balance_diff = 0
    unreachable = 0
    pending_migration = 0  # 有本地余额但未迁移（无 migration_init 记录）

    print("检查远程账户状态...")
    for user in users:
        if user.fish_api_key_encrypted:
            has_key += 1
        else:
            no_key += 1

        try:
            remote = client.get_balance(user.id)
            local = user.dried_fish or 0.0
            if abs(local - remote) > 0.01:
                balance_diff += 1
            else:
                balance_ok += 1
            if local > 0.01 and abs(local - remote) > 0.01:
                pending_migration += 1
        except Exception:
            unreachable += 1

    print(f"\n状态总览:")
    print(f"  用户总数: {len(users)}")
    print(f"  已有 API Key: {has_key}")
    print(f"  缺少 API Key: {no_key}")
    print(f"  余额一致: {balance_ok}")
    print(f"  余额差异: {balance_diff}")
    print(f"  服务不可达: {unreachable}")
    print(f"  待迁移（本地 > 0 且与远程不一致）: {pending_migration}")

    transactions = FishTransaction.query.count()
    print(f"\n本地历史流水: {transactions} 条（仅审计/远端故障 fallback，迁移不依赖）")


def main():
    parser = argparse.ArgumentParser(description='小鱼干历史数据迁移')
    parser.add_argument('--create-accounts', action='store_true', help='为用户创建远程账户')
    parser.add_argument('--sync-balances', action='store_true', help='全量迁移历史鱼干余额到远端账户')
    parser.add_argument('--fix-discrepancies', action='store_true', help='修复本地/远程余额差异（Phase 1 best-effort 残留）')
    parser.add_argument('--all', action='store_true', help='执行迁移全流程：开户 + 全量余额迁移（不含 fix-discrepancies）')
    parser.add_argument('--dry-run', action='store_true', help='仅检查状态，不执行操作')

    args = parser.parse_args()

    if not any([args.create_accounts, args.sync_balances,
                args.fix_discrepancies, args.all, args.dry_run]):
        parser.print_help()
        return 1

    app = create_app()
    with app.app_context():
        print(f"账户服务: {app.config.get('ACCOUNT_SERVICE_URL', '未配置')}")
        print()

        if args.dry_run:
            dry_run(app)
            return 0

        if args.all or args.create_accounts:
            print("── 创建用户账户 ──")
            ok = create_accounts(app)
            print()
            if not ok:
                print("⚠ 部分账户创建失败，请先解决上述错误后再继续。")
                if args.sync_balances:
                    print("  跳过全量余额迁移（账户不完整）。")
                    return 1

        if args.all or args.sync_balances:
            print("── 全量迁移历史鱼干余额 ──")
            sync_balances(app)
            print()

        if args.fix_discrepancies:
            print("── 修复余额差异 ──")
            print("[WARN] 此操作直接修改远端账本，请先确认差异来源再执行。")
            fix_discrepancies(app)
            print()

        print("迁移完成。建议运行 scripts/reconcile_fish.py 进行对账。")

    return 0


if __name__ == '__main__':
    sys.exit(main())
