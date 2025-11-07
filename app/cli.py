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

        if not user.is_admin:
            click.echo(f'\x1b[33m提示：{username} 不是管理员\x1b[0m')
            return

        user.is_admin = False
        db.session.commit()
        click.echo(f'\x1b[32m成功：已移除 {username} 的管理员权限\x1b[0m')