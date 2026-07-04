#!/usr/bin/env python
"""历史数据迁移脚本 — 为现有用户创建远程账户，可选回放历史流水。

Usage:
    # 仅为所有用户创建远程账户（幂等，安全重复运行）
    python scripts/migrate_fish_data.py --create-accounts

    # 回放历史 FishTransaction 到远程账户服务
    python scripts/migrate_fish_data.py --replay-transactions

    # 补齐远程余额（处理无流水记录的初始余额，如运势值折算）
    python scripts/migrate_fish_data.py --sync-balances

    # 完整迁移（上述三步一并执行）
    python scripts/migrate_fish_data.py --all

    # 仅检查状态（dry-run）
    python scripts/migrate_fish_data.py --dry-run

需先配置 .env 中的 ACCOUNT_SERVICE_URL、ACCOUNT_SYSTEM_KEY、ACCOUNT_SERVICE_INTERNAL_TOKEN。
"""

import sys
import os
import argparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import create_app
from app.models.user import User
from app.models.fish import FishTransaction
from app.clients import AccountClient


def create_accounts(app):
    """为所有用户创建远程账户（幂等）。"""
    client = app.account_client
    users = User.query.all()
    created = 0
    skipped = 0
    errors = 0

    for user in users:
        try:
            result = client.create_account(user.id)
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


def replay_transactions(app):
    """将历史 FishTransaction 回放到远程账户服务。

    每条旧记录对应一笔远程转账：
    - 正数 amount（用户获得）→ SYSTEM → user
    - 负数 amount（用户支出）→ user → SYSTEM

    注意：feed / feed_receive 类型跳过不处理。
    旧系统的 feed 是单式记账（一笔扣款 + 一笔入账），
    新系统是复式记账（用户→作者 + 用户→系统消耗）。
    两笔旧记录的配对还原复杂且容易出错，历史投喂数据
    不影响当前余额——新投喂会通过双写正确同步。
    """
    # feed 相关类型跳过（见上方注释）
    SKIP_TYPES = {'feed', 'feed_receive'}

    client = app.account_client
    system = AccountClient.SYSTEM_USER_ID

    transactions = (
        FishTransaction.query
        .order_by(FishTransaction.created_at.asc())
        .all()
    )

    total = len(transactions)
    replayed = 0
    skipped = 0
    errors = 0

    for tx in transactions:
        idempotency_key = f"migrate-{tx.id}"

        # 跳过 feed 相关类型
        if tx.type in SKIP_TYPES:
            skipped += 1
            continue

        try:
            if tx.amount > 0:
                # 用户获得鱼干
                from_id = system
                to_id = tx.user_id
                amount = float(tx.amount)
            else:
                # 用户支出鱼干
                from_id = tx.user_id
                to_id = system
                amount = float(abs(tx.amount))

            client.transfer(
                from_user_id=from_id,
                to_user_id=to_id,
                amount=amount,
                entry_type=tx.type,
                description=tx.description or '',
                metadata={
                    'migrated': True,
                    'original_tx_id': tx.id,
                    'original_created_at': tx.created_at.isoformat() if tx.created_at else None,
                },
                idempotency_key=idempotency_key,
            )
            replayed += 1

            if replayed % 50 == 0:
                print(f"  进度: {replayed}/{total}")

        except Exception as e:
            errors += 1
            print(f"  [ERR] tx#{tx.id} ({tx.type}) — {e}")

    print(f"\n回放完成: 成功 {replayed}, 失败 {errors}, 总计 {total}")
    return errors == 0


def sync_balances(app):
    """补齐远程余额 — 处理没有流水记录的初始余额。

    场景：签到/运势系统先于鱼干系统存在，鱼干系统上线时将
    历史运势值直接写入了 dried_fish 字段，但没有生成
    FishTransaction 流水记录。这些余额无法通过 --replay-transactions
    同步（没有流水可回放），需要单独补齐。

    策略：对每个用户计算 本地余额 - 可回放流水总额 = 初始余额。
    若初始余额 > 0，创建 SYSTEM → 用户转账补齐差额。
    幂等键基于 user_id，可安全重复执行。

    注意：feed / feed_receive 类型的流水不会参与计算（与
    --replay-transactions 一致），因此投喂相关的差额不会补齐。
    """
    SKIP_TYPES = {'feed', 'feed_receive'}
    client = app.account_client
    system = AccountClient.SYSTEM_USER_ID

    users = User.query.all()
    synced = 0
    skipped = 0
    errors = 0

    for user in users:
        local = user.dried_fish or 0.0

        # 计算可回放流水的总额
        txs = FishTransaction.query.filter_by(user_id=user.id).all()
        replay_sum = sum(
            float(tx.amount) for tx in txs if tx.type not in SKIP_TYPES
        )

        initial_gap = round(local - replay_sum, 1)

        if initial_gap <= 0.01:
            skipped += 1
            continue

        try:
            client.transfer(
                from_user_id=system,
                to_user_id=user.id,
                amount=initial_gap,
                entry_type='migration_init',
                description='历史余额同步（无流水记录的初始鱼干折算）',
                metadata={'reason': 'initial_balance_migration'},
                idempotency_key=f"migrate-init-{user.id}",
            )
            synced += 1
            print(f"  [SYNC] {user.username} — 补齐 +{initial_gap}（本地={local}, 流水={replay_sum:+.1f}）")
        except Exception as e:
            errors += 1
            print(f"  [ERR] {user.username} — {e}")

    print(f"\n余额补齐完成: 同步 {synced}, 无需处理 {skipped}, 失败 {errors}")
    return errors == 0


def fix_discrepancies(app, tolerance: float = 0.01):
    """修复本地/远程余额差异。

    场景：Phase 1 best-effort 双写被吞的历史失败流水（如投喂本地扣款但远端没同步、
    签到本地加款但远端没同步）。在修 422 + fail-closed 之后不会再产生新差异，
    但存量差异需手动修复。

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
    from app.clients.account_client import AccountClientError

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
            remote = float(client.get_balance(user.id))
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
                client.transfer(
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
                client.transfer(
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
        except Exception:
            unreachable += 1

    print(f"\n状态总览:")
    print(f"  用户总数: {len(users)}")
    print(f"  已有 API Key: {has_key}")
    print(f"  缺少 API Key: {no_key}")
    print(f"  余额一致: {balance_ok}")
    print(f"  余额差异: {balance_diff}")
    print(f"  服务不可达: {unreachable}")

    transactions = FishTransaction.query.count()
    print(f"\n历史流水记录: {transactions} 条")


def main():
    parser = argparse.ArgumentParser(description='小鱼干历史数据迁移')
    parser.add_argument('--create-accounts', action='store_true', help='为用户创建远程账户')
    parser.add_argument('--replay-transactions', action='store_true', help='回放历史流水')
    parser.add_argument('--sync-balances', action='store_true', help='补齐远程余额（处理无流水记录的初始余额）')
    parser.add_argument('--fix-discrepancies', action='store_true', help='修复本地/远程余额差异（Phase 1 best-effort 残留）')
    parser.add_argument('--all', action='store_true', help='执行全部迁移步骤（不含 fix-discrepancies）')
    parser.add_argument('--dry-run', action='store_true', help='仅检查状态，不执行操作')

    args = parser.parse_args()

    if not any([args.create_accounts, args.replay_transactions, args.sync_balances,
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
                if args.all or args.replay_transactions:
                    print("  跳过流水回放（账户不完整的情况下回放可能不准确）。")
                    return 1

        if args.all or args.replay_transactions:
            print("── 回放历史流水 ──")
            replay_transactions(app)
            print()

        if args.all or args.sync_balances:
            print("── 补齐远程余额 ──")
            sync_balances(app)
            print()

        if args.fix_discrepancies:
            print("── 修复余额差异 ──")
            print("[WARN] 此操作直接修改远端账本，请先确认差异来源再执行。")
            fix_discrepancies(app)
            print()

        print("迁移完成。建议运行 scripts/reconcile_fish.py 进行对账。")


if __name__ == '__main__':
    sys.exit(main())
