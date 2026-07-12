#!/usr/bin/env python
"""小鱼干同步 — 对账并修复本地/远程余额差异。

Usage:
    # 仅对账（dry-run，默认）
    python scripts/sync_fish.py
    # 实际修复
    python scripts/sync_fish.py --apply
    # 只针对指定用户
    python scripts/sync_fish.py --apply --usernames raricy,Yaozi

差异处理（修复方向）：
- local > remote：SYSTEM → user transfer（补齐远端）
- local < remote：user → SYSTEM transfer（回收远端多余）

不动 User.dried_fish（local 是历史账本事实源）；写 FishTransaction(type=sync_adjust)
作为审计留痕（amount = diff，正数表示用户应得，负数表示用户应退）。

需要 .env 中配置 ACCOUNT_SERVICE_URL / ACCOUNT_SYSTEM_KEY / ACCOUNT_SERVICE_INTERNAL_TOKEN。
"""
import sys
import os
import time
import uuid
import argparse

# 确保可以 import app
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import create_app
from app.extensions import db
from app.models.user import User
from app.models.fish import FishTransaction
from app.clients import AccountClient
from app.clients.account_client import AccountClientError


def parse_args():
    p = argparse.ArgumentParser(
        description='小鱼干同步 — 对账并修复本地/远程余额差异',
    )
    p.add_argument(
        '--apply', action='store_true',
        help='实际执行 transfer（默认 dry-run，仅报告）',
    )
    p.add_argument(
        '--usernames',
        help='逗号分隔的用户名列表；只处理这些用户，默认全部',
    )
    p.add_argument(
        '--tolerance', type=float, default=0.01,
        help='浮点容差（默认 0.01）',
    )
    p.add_argument(
        '--rate', type=float, default=5.0,
        help='远端 transfer 限频 req/s（默认 5；遇 429 调小）',
    )
    p.add_argument(
        '--yes', '-y', action='store_true', help='跳过确认提示',
    )
    return p.parse_args()


def fetch_remote_balances(client, user_ids):
    """批量获取远端余额（按 100/批切片），整批失败时回退到逐个查询。"""
    result = {}
    for i in range(0, len(user_ids), 100):
        batch = user_ids[i:i + 100]
        try:
            result.update(client.get_balances(batch))
            continue
        except Exception as e:
            print(f'  [WARN] 批量查询失败（offset={i}）: {e}', file=sys.stderr)
        # 回退：逐个查（不抛错的部分仍能继续）
        for uid in batch:
            try:
                result[uid] = client.get_balance(uid)
            except Exception as e:
                print(f'  [WARN] {uid} 单点查询失败: {e}', file=sys.stderr)
                result[uid] = None
    return result


def main():
    args = parse_args()

    app = create_app()
    with app.app_context():
        client: AccountClient = app.account_client
        system = AccountClient.SYSTEM_USER_ID

        # 选定用户
        if args.usernames:
            usernames = [s.strip() for s in args.usernames.split(',') if s.strip()]
            users = User.query.filter(User.username.in_(usernames)) \
                .order_by(User.username).all()
            found = {u.username for u in users}
            missing = [n for n in usernames if n not in found]
            if missing:
                print(f'错误：以下用户不存在：{", ".join(missing)}', file=sys.stderr)
                return 1
        else:
            users = User.query.order_by(User.username).all()

        if not users:
            print('错误：无匹配用户')
            return 1

        print('=' * 60)
        print('  小鱼干同步 — 对账并修复')
        print('=' * 60)
        print(f'  账户服务: {app.config.get("ACCOUNT_SERVICE_URL", "未配置")}')
        print(f'  用户数: {len(users)}')
        print(f'  容差: {args.tolerance}')
        print(f'  模式: {"apply" if args.apply else "dry-run"}')
        if args.apply:
            interval = 1.0 / args.rate
            print(f'  限频: {args.rate} req/s (间隔 {interval:.3f}s, '
                  f'预计耗时 {len(users) * interval:.1f}s)')
        print()

        # 批量拉取远端余额
        print('  正在查询远端余额...')
        remotes = fetch_remote_balances(client, [u.id for u in users])

        # 对账
        discrepancies = []  # [(user, local, remote, diff), ...]
        errors = 0
        total_local = 0.0
        total_remote = 0.0

        for u in users:
            local = float(u.dried_fish or 0.0)
            total_local += local

            remote = remotes.get(u.id)
            if remote is None:
                errors += 1
                continue
            total_remote += remote

            diff = local - remote  # 正=本地多, 负=本地少
            if abs(diff) > args.tolerance:
                discrepancies.append((u, local, remote, diff))
                print(f'  [DIFF] {u.username}: 本地={local:.1f}, 远程={remote:.1f}, 差额={diff:+.1f}')

        consistent = len(users) - len(discrepancies) - errors
        print()
        print(f'  总用户数: {len(users)}')
        print(f'  一致: {consistent}')
        print(f'  差异: {len(discrepancies)}')
        print(f'  错误: {errors}')
        print(f'  本地总额: {total_local:.1f}')
        print(f'  远程总额: {total_remote:.1f}')
        print()

        if errors > 0 and not discrepancies:
            print(f'  ⚠ 共有 {errors} 个用户余额查询失败，请确认账户服务运行正常。')
            return 2

        if not discrepancies:
            print('  ✓ 所有用户余额一致！')
            return 0

        if not args.apply:
            print(f'  ⚠ 共有 {len(discrepancies)} 个用户存在差异，使用 --apply 执行修复。')
            return 1

        if not args.yes:
            ans = input(
                f'\n确认修复 {len(discrepancies)} 个差异？[y/N]: '
            )
            if ans.strip().lower() != 'y':
                print('已取消')
                return 0

        # 修复：远端 transfer + 本地写留痕流水（不动 User.dried_fish）
        interval = 1.0 / args.rate
        batch_id = uuid.uuid4().hex[:12]
        success = 0
        last_user = None

        try:
            for i, (u, local, remote, diff) in enumerate(discrepancies):
                if i > 0:
                    time.sleep(interval)
                last_user = u

                amount = round(abs(diff), 2)
                amount_cents = int(round(amount * 100))
                if diff > 0:
                    # 本地多 → 系统向用户补齐
                    from_user, to_user = system, u.id
                else:
                    # 本地少 → 用户向系统退回
                    from_user, to_user = u.id, system

                idem_key = f"sync-adjust-{batch_id}-{u.id}-{amount_cents}"
                client.transfer(
                    from_user_id=from_user,
                    to_user_id=to_user,
                    amount=amount,
                    entry_type='sync_adjust',
                    description=f'对账修复 {u.username}（差额 {diff:+.2f}）',
                    metadata={
                        'reason': 'reconcile_sync',
                        'local_before': local,
                        'remote_before': remote,
                        'diff': diff,
                    },
                    idempotency_key=idem_key,
                )

                # 本地留痕流水（不改 User.dried_fish — 它本来就对）
                tx = FishTransaction(
                    user_id=u.id,
                    amount=diff,  # 正=用户应得, 负=用户应退
                    type='sync_adjust',
                    description=f'对账修复 {u.username}（差额 {diff:+.2f}）',
                )
                db.session.add(tx)
                db.session.commit()
                success += 1
                if success % 10 == 0 or success == len(discrepancies):
                    print(f'  进度: {success}/{len(discrepancies)}')

        except AccountClientError as e:
            db.session.rollback()
            print(
                f'\n错误：远端 transfer 失败（已成功 {success}/{len(discrepancies)}）',
                file=sys.stderr,
            )
            if last_user is not None:
                print(f'  失败用户: {last_user.username}', file=sys.stderr)
            print(f'  原因: {e}', file=sys.stderr)
            if getattr(e, 'code', None) == 429:
                print('  提示：429 限频！可降低 --rate 重试', file=sys.stderr)
            return 2
        except Exception as e:
            db.session.rollback()
            print(
                f'\n错误：未预期异常（已成功 {success}/{len(discrepancies)}）',
                file=sys.stderr,
            )
            if last_user is not None:
                print(f'  失败用户: {last_user.username}', file=sys.stderr)
            print(f'  原因: {e}', file=sys.stderr)
            return 2

        print(
            f'\n✓ 成功修复 {success} 个差异。\n'
            f'  远端已对齐本地（User.dried_fish 未变，仅写 sync_adjust 流水）'
        )
        return 0


if __name__ == '__main__':
    sys.exit(main())
