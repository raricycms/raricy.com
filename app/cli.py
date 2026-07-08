import sys
import time
import uuid

import click
from app.models import User
from app.extensions import db
from app.service.fish import add_fish, deduct_fish

def register_commands(app):
    @app.cli.command('promote-admin')
    @click.argument('username')
    def promote_admin(username):
        ''' 
        安全提升用户权限（仅限服务器执行） 
        Usage: flask promote-admin <username>
        '''
        user = User.query.filter_by(username=username).first()
        if not user:
            click.echo(f'[31m错误：用户 {username} 不存在[0m')
            return
        
        if getattr(user, 'role', 'user') in ('admin', 'owner'):
            click.echo(f'[33m提示：{username} 已是管理员[0m')
            return
            
        # 设为管理员（非站长）
        if getattr(user, 'role', 'user') != 'owner':
            user.role = 'admin'
        db.session.commit()
        click.echo(f'[32m成功：已授予 {username} 管理员权限[0m')

    @app.cli.command('demote-admin')
    @click.argument('username')
    def demote_admin(username):
        '''
        安全移除用户管理员权限（仅限服务器执行）
        Usage: flask demote-admin <username>
        '''
        user = User.query.filter_by(username=username).first()
        if not user:
            click.echo(f'\x1b[31m错误：用户 {username} 不存在\x1b[0m')
            return

        # 站长不可通过该命令降为非管理员
        if getattr(user, 'role', 'user') == 'owner':
            click.echo(f'\x1b[31m错误：{username} 是站长，请先使用 demote-owner\x1b[0m')
            return

        if getattr(user, 'role', 'user') != 'admin':
            click.echo(f'\x1b[33m提示：{username} 不是管理员\x1b[0m')
            return

        # 降级为核心用户
        user.role = 'core'
        db.session.commit()
        click.echo(f'\x1b[32m成功：已移除 {username} 的管理员权限（降级为核心用户）\x1b[0m')

    @app.cli.command('promote-core')
    @click.argument('username')
    def promote_core(username):
        '''
        提升用户为核心用户（仅限服务器执行）
        Usage: flask promote-core <username>
        '''
        user = User.query.filter_by(username=username).first()
        if not user:
            click.echo(f'\x1b[31m错误：用户 {username} 不存在\x1b[0m')
            return

        role = getattr(user, 'role', 'user')
        if role in ('core', 'admin', 'owner'):
            click.echo(f'\x1b[33m提示：{username} 已是核心用户（或更高角色）\x1b[0m')
            return

        user.role = 'core'
        db.session.commit()
        click.echo(f'\x1b[32m成功：已授予 {username} 核心用户权限\x1b[0m')

    @app.cli.command('demote-core')
    @click.argument('username')
    def demote_core(username):
        '''
        取消用户核心用户权限（仅限服务器执行）
        Usage: flask demote-core <username>
        '''
        user = User.query.filter_by(username=username).first()
        if not user:
            click.echo(f'\x1b[31m错误：用户 {username} 不存在\x1b[0m')
            return

        if getattr(user, 'role', 'user') != 'core':
            click.echo(f'\x1b[33m提示：{username} 不是核心用户（或已超出该角色范围）\x1b[0m')
            return

        user.role = 'user'
        db.session.commit()
        click.echo(f'\x1b[32m成功：已移除 {username} 的核心用户权限\x1b[0m')

    @app.cli.command('promote-owner')
    @click.argument('username')
    def promote_owner(username):
        '''
        授予站长权限（仅限服务器执行）
        Usage: flask promote-owner <username>
        '''
        user = User.query.filter_by(username=username).first()
        if not user:
            click.echo(f'\x1b[31m错误：用户 {username} 不存在\x1b[0m')
            return

        if getattr(user, 'is_owner', False):
            click.echo(f'\x1b[33m提示：{username} 已是站长\x1b[0m')
            return

        user.role = 'owner'
        db.session.commit()
        click.echo(f'\x1b[32m成功：已授予 {username} 站长权限\x1b[0m')

    @app.cli.command('demote-owner')
    @click.argument('username')
    def demote_owner(username):
        '''
        取消站长权限（仅限服务器执行）
        Usage: flask demote-owner <username>
        '''
        user = User.query.filter_by(username=username).first()
        if not user:
            click.echo(f'\x1b[31m错误：用户 {username} 不存在\x1b[0m')
            return

        if getattr(user, 'role', 'user') != 'owner':
            click.echo(f'\x1b[33m提示：{username} 不是站长\x1b[0m')
            return

        # 降级为管理员（而非直接 user），更安全
        user.role = 'admin'
        db.session.commit()
        click.echo(f'\x1b[32m成功：已移除 {username} 的站长权限（保留管理员）\x1b[0m')

    @app.cli.group('fish')
    def fish_group():
        """小鱼干管理命令组"""
        pass

    @fish_group.command('grant')
    @click.argument('username')
    @click.argument('amount', type=int)
    @click.option('--description', '-d', default=None, help='操作说明')
    def fish_grant(username, amount, description):
        """
        给用户增加小鱼干（fail-closed）。

        Usage: flask fish grant <username> <amount> [--description "..."]

        写路径 fail-closed：本地 add_fish 不 commit，先同步远端账户服务，
        远端成功才 commit 本地；远端失败则 rollback 整个本地事务，
        本地余额不变，返回非零退出码。
        """
        if amount <= 0:
            click.echo('\x1b[31m错误：amount 必须为正整数\x1b[0m')
            sys.exit(1)

        user = User.query.filter_by(username=username).first()
        if not user:
            click.echo(f'\x1b[31m错误：用户 {username} 不存在\x1b[0m')
            sys.exit(1)

        desc = description or f'管理员手动赠送'
        # auto_commit=False：本变更先留在 session，等远端成功后再 commit
        balance = add_fish(user.id, amount, 'admin_grant', desc, auto_commit=False)

        from flask import current_app
        from app.clients.account_client import AccountClientError
        from app.clients import AccountClient
        try:
            current_app.account_client.transfer(
                from_user_id=AccountClient.SYSTEM_USER_ID,
                to_user_id=user.id,
                amount=float(amount),
                entry_type='admin_grant',
                description=desc,
                idempotency_key=f"cli-grant-{user.id}-{int(time.time())}-{amount}",
            )
        except AccountClientError as e:
            db.session.rollback()
            click.echo(f'\x1b[31m失败：账户服务同步失败，本地事务已回滚\x1b[0m', err=True)
            click.echo(f'  原因: {e}', err=True)
            click.echo(f'  本地余额未变更（{user.dried_fish}），请稍后重试。', err=True)
            sys.exit(2)
        except Exception as e:
            db.session.rollback()
            click.echo(f'\x1b[31m失败：账户服务同步异常，本地事务已回滚\x1b[0m', err=True)
            click.echo(f'  原因: {e}', err=True)
            sys.exit(2)

        # 远端成功 → commit 本地
        db.session.commit()
        click.echo(f'\x1b[32m成功：已赠送 {amount} 小鱼干给 {username}\x1b[0m')
        click.echo(f'  当前余额：{balance}')
        click.echo(f'  已同步至账户服务')

    @fish_group.command('deduct')
    @click.argument('username')
    @click.argument('amount', type=int)
    @click.option('--description', '-d', default=None, help='操作说明')
    def fish_deduct(username, amount, description):
        """
        扣减用户小鱼干（fail-closed）。

        Usage: flask fish deduct <username> <amount> [--description "..."]

        写路径 fail-closed：本地 deduct_fish 不 commit，先同步远端账户服务，
        远端成功才 commit 本地；远端失败则 rollback 整个本地事务，
        本地余额不变，返回非零退出码。
        """
        if amount <= 0:
            click.echo('\x1b[31m错误：amount 必须为正整数\x1b[0m')
            sys.exit(1)

        user = User.query.filter_by(username=username).first()
        if not user:
            click.echo(f'\x1b[31m错误：用户 {username} 不存在\x1b[0m')
            sys.exit(1)

        desc = description or f'管理员手动扣减'
        try:
            # auto_commit=False：本变更先留在 session，等远端成功后再 commit
            balance = deduct_fish(user.id, amount, 'admin_deduct', desc, auto_commit=False)
        except ValueError as e:
            click.echo(f'\x1b[31m错误：{e}\x1b[0m')
            sys.exit(1)

        from flask import current_app
        from app.clients.account_client import AccountClientError
        from app.clients import AccountClient
        try:
            current_app.account_client.transfer(
                from_user_id=user.id,
                to_user_id=AccountClient.SYSTEM_USER_ID,
                amount=float(amount),
                entry_type='admin_deduct',
                description=desc,
                idempotency_key=f"cli-deduct-{user.id}-{int(time.time())}-{amount}",
            )
        except AccountClientError as e:
            db.session.rollback()
            click.echo(f'\x1b[31m失败：账户服务同步失败，本地事务已回滚\x1b[0m', err=True)
            click.echo(f'  原因: {e}', err=True)
            click.echo(f'  本地余额未变更（{user.dried_fish}），请稍后重试。', err=True)
            sys.exit(2)
        except Exception as e:
            db.session.rollback()
            click.echo(f'\x1b[31m失败：账户服务同步异常，本地事务已回滚\x1b[0m', err=True)
            click.echo(f'  原因: {e}', err=True)
            sys.exit(2)

        # 远端成功 → commit 本地
        db.session.commit()
        click.echo(f'\x1b[32m成功：已扣减 {amount} 小鱼干从 {username}\x1b[0m')
        click.echo(f'  当前余额：{balance}')
        click.echo(f'  已同步至账户服务')

    @fish_group.command('compensate')
    @click.argument('amount', type=int)
    @click.option('--description', '-d', default=None, help='操作说明，会写入每条 FishTransaction')
    @click.option('--yes', '-y', is_flag=True, help='跳过确认提示')
    @click.option('--dry-run', is_flag=True, help='只显示计划，不实际执行')
    def fish_compensate(amount, description, yes, dry_run):
        """
        系统补偿：给所有用户发放指定数量的小鱼干（fail-closed）。

        Usage: flask fish compensate <amount> [-d "..."] [--yes] [--dry-run]

        写路径 fail-closed：先在本地为每个用户 add_fish（不 commit），
        再逐个 transfer 同步到远端账户服务；任一用户同步失败则 rollback
        整个本地事务，所有用户余额不变，返回非零退出码。

        幂等键格式：cli-compensate-{batch_id}-{user_id}-{amount}
        batch_id 为本批次的 UUID 短串，重复执行同一命令会生成不同批次，
        不会触发远端去重。同一批次内重跑会被远端去重保护。
        """
        if amount <= 0:
            click.echo('\x1b[31m错误：amount 必须为正整数\x1b[0m')
            sys.exit(1)

        # 列出所有用户（包括被禁言的；补偿是系统行为，与个人状态无关）
        users = User.query.order_by(User.created_at.asc()).all()
        user_count = len(users)
        if user_count == 0:
            click.echo('\x1b[33m提示：数据库中没有用户，无需补偿\x1b[0m')
            return

        desc = description or '系统补偿'
        total_fish = amount * user_count
        batch_id = uuid.uuid4().hex[:12]

        click.echo('\x1b[36m=== 补偿计划 ===\x1b[0m')
        click.echo(f'  批次 ID：{batch_id}')
        click.echo(f'  类型：{desc}')
        click.echo(f'  单用户发放：{amount} 小鱼干')
        click.echo(f'  目标用户数：{user_count}')
        click.echo(f'  合计发放：{total_fish} 小鱼干')
        click.echo('  流程：先本地累加 → 全部远端同步成功 → commit 本地；任一失败则整体回滚')

        if dry_run:
            click.echo('\x1b[33m--dry-run 模式：未实际执行\x1b[0m')
            return

        if not yes:
            click.confirm(
                f'\x1b[33m确认向所有 {user_count} 位用户每人发放 {amount} 小鱼干（合计 {total_fish}）？\x1b[0m',
                abort=True,
            )

        # 第一阶段：本地累加（auto_commit=False，全部留在 session 中）
        click.echo(f'\x1b[36m[1/2] 本地累加 {user_count} 位用户余额...\x1b[0m')
        for user in users:
            add_fish(user.id, amount, 'system_compensate', desc, auto_commit=False)

        # 第二阶段：逐个同步远端（任一失败 → 整体 rollback）
        from flask import current_app
        from app.clients.account_client import AccountClientError
        from app.clients import AccountClient

        click.echo(f'\x1b[36m[2/2] 同步远端账户服务...\x1b[0m')
        success_count = 0
        try:
            for user in users:
                current_app.account_client.transfer(
                    from_user_id=AccountClient.SYSTEM_USER_ID,
                    to_user_id=user.id,
                    amount=float(amount),
                    entry_type='system_compensate',
                    description=desc,
                    idempotency_key=f"cli-compensate-{batch_id}-{user.id}-{amount}",
                )
                success_count += 1
        except AccountClientError as e:
            db.session.rollback()
            click.echo(
                f'\x1b[31m失败：账户服务同步失败（已成功 {success_count}/{user_count}），'
                f'本地事务已回滚\x1b[0m',
                err=True,
            )
            click.echo(f'  原因: {e}', err=True)
            click.echo(f'  全部 {user_count} 位用户余额未变更，请稍后重试。', err=True)
            sys.exit(2)
        except Exception as e:
            db.session.rollback()
            click.echo(
                f'\x1b[31m失败：账户服务同步异常（已成功 {success_count}/{user_count}），'
                f'本地事务已回滚\x1b[0m',
                err=True,
            )
            click.echo(f'  原因: {e}', err=True)
            sys.exit(2)

        # 远端全部成功 → commit 本地
        db.session.commit()
        click.echo(
            f'\x1b[32m成功：已向 {success_count} 位用户每人发放 {amount} 小鱼干'
            f'（合计 {total_fish}）\x1b[0m'
        )
        click.echo(f'  已同步至账户服务')

    @fish_group.command('balance')
    @click.argument('username')
    def fish_balance(username):
        """
        查看用户小鱼干余额。

        Usage: flask fish balance <username>
        """
        user = User.query.filter_by(username=username).first()
        if not user:
            click.echo(f'\x1b[31m错误：用户 {username} 不存在\x1b[0m')
            return

        # 优先从账户服务查询
        try:
            from flask import current_app
            balance = current_app.account_client.get_balance(user.id)
            click.echo(f'{username} 当前小鱼干余额（账户服务）：{balance}')
        except Exception:
            click.echo(f'{username} 当前小鱼干余额（本地）：{user.dried_fish}')