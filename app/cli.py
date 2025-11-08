import click
from app.models import User
from app.extensions import db

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
        
        if user.is_admin:
            click.echo(f'[33m提示：{username} 已是管理员[0m')
            return
            
        user.is_admin = True
        # 同步角色：若不是站长，则明确设为 admin
        try:
            if getattr(user, 'role', 'user') != 'owner':
                user.role = 'admin'
        except Exception:
            pass
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
        if getattr(user, 'is_owner', False):
            click.echo(f'\x1b[31m错误：{username} 是站长，请先使用 demote-owner\x1b[0m')
            return

        if not user.is_admin:
            click.echo(f'\x1b[33m提示：{username} 不是管理员\x1b[0m')
            return

        user.is_admin = False
        # 同步角色：仅当角色为 admin 时降回 user，不影响 core
        try:
            if getattr(user, 'role', 'user') == 'admin':
                user.role = 'user'
        except Exception:
            pass
        db.session.commit()
        click.echo(f'\x1b[32m成功：已移除 {username} 的管理员权限\x1b[0m')

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

        # 站长默认也为管理员
        user.is_admin = True
        try:
            user.role = 'owner'
        except Exception:
            pass
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

        if not getattr(user, 'is_owner', False):
            click.echo(f'\x1b[33m提示：{username} 不是站长\x1b[0m')
            return

        # 降级为管理员（而非直接 user），更安全
        try:
            user.role = 'admin'
        except Exception:
            pass
        user.is_admin = True
        db.session.commit()
        click.echo(f'\x1b[32m成功：已移除 {username} 的站长权限（保留管理员）\x1b[0m')