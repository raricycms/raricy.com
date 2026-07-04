import sys
import time

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