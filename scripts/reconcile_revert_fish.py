#!/usr/bin/env python
"""小鱼干差额修复 — 撤销 compensate 失败导致的多发。

场景：compensate 命令跑了一半因 429/网络异常 fail-closed 失败，
本地 db.session.rollback() 已生效（本地余额未动），但远端前 N 笔
transfer 已经发生、不可回滚。结果是这 N 个用户远端比本地多 fish。

本脚本对每个用户：
  - 远端：transfer (user → system, amount=N, type=compensate_reverse)
  - 本地：写一条 FishTransaction(amount=-N, type=compensate_reverse)
    **不**修改 User.dried_fish（它本来就对，远端才是多的）

不动本地余额的原因：补偿失败时本地已 rollback，本来就没收到那 N；
扣回是"撤销远端误发"，本地不该二次扣款，但需要流水留痕。

Usage:
    python scripts/reconcile_revert_fish.py [--dry-run] [--yes]
    python scripts/reconcile_revert_fish.py --usernames alice,bob --amount 10
    python scripts/reconcile_revert_fish.py --rate 2.0   # 限频 2 req/s

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
from app.models.user import User
from app.models.fish import FishTransaction
from app.extensions import db
from app.clients import AccountClient, AccountClientError


# 2026-07-08 compensate 失败事故：10 个用户远端多 20 鱼干
DEFAULT_USERNAMES = [
    'cms', 'fyz', '123', 'AzureSeeker', 'yaozi', 'wisedragon',
    'Morgendämmerung', 'hsz', 'sxy', 'wny',
]
DEFAULT_AMOUNT = 20
DEFAULT_DESCRIPTION = '撤销 2026-07 compensate 失败多发'
RATE_DEFAULT = 5.0


def parse_args():
    p = argparse.ArgumentParser(
        description='撤销 compensate 失败导致的多发鱼干',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        '--usernames', default=','.join(DEFAULT_USERNAMES),
        help=f'逗号分隔的用户名列表（默认 {len(DEFAULT_USERNAMES)} 个历史事故用户）',
    )
    p.add_argument(
        '--amount', type=int, default=DEFAULT_AMOUNT,
        help=f'每个用户扣回的鱼干数（默认 {DEFAULT_AMOUNT}）',
    )
    p.add_argument(
        '--description', '-d', default=DEFAULT_DESCRIPTION,
        help='写入 FishTransaction 的描述',
    )
    p.add_argument(
        '--rate', type=float, default=RATE_DEFAULT,
        help=f'远端同步每秒请求数（默认 {RATE_DEFAULT}；遇 429 调小）',
    )
    p.add_argument(
        '--dry-run', action='store_true', help='只显示计划，不实际执行',
    )
    p.add_argument(
        '--yes', '-y', action='store_true', help='跳过确认提示',
    )
    return p.parse_args()


def main():
    args = parse_args()
    usernames = [u.strip() for u in args.usernames.split(',') if u.strip()]
    if not usernames:
        print('错误：用户名列表为空')
        return 1
    if args.amount <= 0:
        print('错误：amount 必须为正整数')
        return 1

    app = create_app()
    with app.app_context():
        client: AccountClient = app.account_client
        interval = 1.0 / args.rate
        batch_id = uuid.uuid4().hex[:12]

        # 查用户
        users = User.query.filter(User.username.in_(usernames)).all()
        found = {u.username: u for u in users}
        missing = [name for name in usernames if name not in found]
        if missing:
            print(f'错误：以下用户不存在：{", ".join(missing)}')
            return 1

        print('=' * 60)
        print('  小鱼干差额修复 — 撤销 compensate 失败多发')
        print('=' * 60)
        print(f'  批次 ID: {batch_id}')
        print(f'  类型: {args.description}')
        print(f'  单用户扣回: {args.amount}')
        print(f'  目标用户: {len(users)}')
        print(
            f'  限频: {args.rate} req/s '
            f'(间隔 {interval:.3f}s, 预计耗时 {len(users) * interval:.1f}s)'
        )
        print('  远端: 从用户 -N → system +N (transfer)')
        print('  本地: 写 FishTransaction(amount=-N) 但不改 User.dried_fish')
        print()

        # 预检：每个用户远端差额是否真的 ≥ amount
        pre_check_diffs = []
        print('  预检：对账检查每个用户远端余额...')
        for u in users:
            try:
                remote = client.get_balance(u.id)
            except Exception as e:
                print(f'    预检失败 {u.username}: {e}', file=sys.stderr)
                return 1
            local = u.dried_fish or 0.0
            diff = remote - local  # 远端比本地多的部分
            if diff >= args.amount - 0.01:
                pre_check_diffs.append((u, remote, local, diff))
            else:
                print(f'    跳过 {u.username}: 远端仅多 {diff:.1f}，不足 {args.amount}')

        if not pre_check_diffs:
            print('\n  无需修复：所有目标用户远端差额均不足 amount。')
            return 0

        print(f'\n  将对 {len(pre_check_diffs)} 位用户执行扣回:')
        for u, remote, local, diff in pre_check_diffs:
            print(f'    {u.username}: 本地={local:.1f}, 远程={remote:.1f}, 差额={diff:+.1f}')

        if args.dry_run:
            print('\n  --dry-run 模式：未实际执行')
            return 0

        if not args.yes:
            ans = input(
                f'\n确认从 {len(pre_check_diffs)} 位用户各扣回 {args.amount} 鱼干？[y/N]: '
            )
            if ans.strip().lower() != 'y':
                print('已取消')
                return 0

        # 执行：远端 transfer + 本地写流水（不动 dried_fish）
        # 每笔单独 commit：远端成功即落账，失败则 rollback 当前 session 的本地流水
        # 之前已 commit 的 N-1 笔保留（因为它们对应的远端 transfer 已实际发生）
        success = 0
        last_user = None
        try:
            for i, (u, _remote, _local, _diff) in enumerate(pre_check_diffs):
                if i > 0:
                    time.sleep(interval)
                last_user = u

                # 远端：从用户扣 N 给 system
                idem_key = f"revert-{batch_id}-{u.id}-{args.amount}"
                client.transfer(
                    from_user_id=u.id,
                    to_user_id=AccountClient.SYSTEM_USER_ID,
                    amount=float(args.amount),
                    entry_type='compensate_reverse',
                    description=args.description,
                    idempotency_key=idem_key,
                )

                # 本地：写留痕流水（不改 dried_fish）
                tx = FishTransaction(
                    user_id=u.id,
                    amount=-float(args.amount),
                    type='compensate_reverse',
                    description=args.description,
                )
                db.session.add(tx)
                db.session.commit()
                success += 1
                if success % 5 == 0 or success == len(pre_check_diffs):
                    print(f'  进度: {success}/{len(pre_check_diffs)}')
        except AccountClientError as e:
            db.session.rollback()
            print(
                f'\n错误：远端 transfer 失败（已成功 {success}/{len(pre_check_diffs)}）',
                file=sys.stderr,
            )
            if last_user is not None:
                print(
                    f'  失败用户: {last_user.username} ({last_user.id})',
                    file=sys.stderr,
                )
            print(f'  原因: {e}', file=sys.stderr)
            print(f'  HTTP code: {getattr(e, "code", "N/A")}', file=sys.stderr)
            if getattr(e, 'code', None) == 429:
                print('  提示：429 限频！可降低 --rate 重试', file=sys.stderr)
            return 2
        except Exception as e:
            db.session.rollback()
            print(
                f'\n错误：未预期异常（已成功 {success}/{len(pre_check_diffs)}）',
                file=sys.stderr,
            )
            if last_user is not None:
                print(
                    f'  失败用户: {last_user.username} ({last_user.id})',
                    file=sys.stderr,
                )
            print(f'  原因: {e}', file=sys.stderr)
            return 2

        print(
            f'\n成功：从 {success} 位用户各扣回 {args.amount} 鱼干，'
            f'远端已对齐本地（本地余额未变，仅写补偿流水）'
        )
        return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
