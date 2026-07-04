#!/usr/bin/env python
"""对账脚本 — 对比本地 dried_fish 与远程账户服务余额，报告差异。

Usage:
    python scripts/reconcile_fish.py

需先配置 .env 中的 ACCOUNT_SERVICE_URL、ACCOUNT_SYSTEM_KEY、ACCOUNT_SERVICE_INTERNAL_TOKEN。
"""

import sys
import os

# 确保可以 import app
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import create_app
from app.models.user import User


def main():
    app = create_app()
    with app.app_context():
        client = app.account_client
        print("=" * 60)
        print("  小鱼干账户对账")
        print("=" * 60)
        print(f"  账户服务: {app.config.get('ACCOUNT_SERVICE_URL', '未配置')}")
        print()

        users = User.query.all()
        total = len(users)
        discrepancies = 0
        errors = 0
        total_local = 0.0
        total_remote = 0.0

        for user in users:
            local = user.dried_fish or 0.0
            total_local += local

            try:
                remote = client.get_balance(user.id)
                total_remote += remote
            except Exception as e:
                print(f"  [ERR] {user.username}: 账户服务不可达 - {e}")
                errors += 1
                continue

            diff = abs(local - remote)
            if diff > 0.01:  # 允许浮点误差
                print(f"  [DIFF] {user.username}: 本地={local:.1f}, 远程={remote:.1f}, 差额={local - remote:+.1f}")
                discrepancies += 1

        print()
        print(f"  总用户数: {total}")
        print(f"  一致: {total - discrepancies - errors}")
        print(f"  差异: {discrepancies}")
        print(f"  错误: {errors}")
        print(f"  本地总额: {total_local:.1f}")
        print(f"  远程总额: {total_remote:.1f}")
        print()

        if discrepancies == 0 and errors == 0:
            print("  ✓ 所有用户余额一致！")
            return 0
        elif discrepancies > 0:
            print(f"  ⚠ 共有 {discrepancies} 个用户存在差异，请检查。")
            return 1
        else:
            print(f"  ⚠ 共有 {errors} 个用户查询失败，请确认账户服务运行正常。")
            return 2


if __name__ == '__main__':
    sys.exit(main())
