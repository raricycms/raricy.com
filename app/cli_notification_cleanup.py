#!/usr/bin/env python3
"""
通知系统清理工具
用于定期清理旧通知，避免数据库过度膨胀
"""

import click
from datetime import datetime
from app import create_app
from app.service.notifications import cleanup_old_notifications

app = create_app()

@click.group()
def cli():
    """通知管理命令行工具"""
    pass

@cli.command()
@click.option('--days', '-d', default=30, help='删除多少天前的已读通知（默认30天）')
@click.option('--dry-run', is_flag=True, help='仅显示将要删除的通知数量，不实际删除')
def cleanup(days, dry_run):
    """清理旧的已读通知"""
    
    with app.app_context():
        if dry_run:
            click.echo(f"[DRY RUN] 检查 {days} 天前的已读通知...")
            # 这里可以添加预览逻辑，显示将要删除的通知数量
            from app.models import Notification
            from datetime import timedelta
            from sqlalchemy import and_
            
            threshold_date = datetime.now() - timedelta(days=days)
            count = Notification.query.filter(
                and_(
                    Notification.read == True,
                    Notification.timestamp < threshold_date
                )
            ).count()
            
            click.echo(f"[DRY RUN] 将删除 {count} 个通知")
            if count > 0:
                click.echo("运行 'python cli_notification_cleanup.py cleanup' 来实际删除这些通知")
        else:
            click.echo(f"开始清理 {days} 天前的已读通知...")
            deleted_count = cleanup_old_notifications(days)
            click.echo(f"✅ 成功清理 {deleted_count} 个旧通知")

@cli.command()
def stats():
    """显示通知系统统计信息"""
    
    with app.app_context():
        from app.models import Notification, User
        from sqlalchemy import func
        
        # 总通知数
        total_notifications = Notification.query.count()
        
        # 未读通知数
        unread_notifications = Notification.query.filter_by(read=False).count()
        
        # 已读通知数
        read_notifications = Notification.query.filter_by(read=True).count()
        
        # 按动作类型统计
        action_stats = Notification.query.with_entities(
            Notification.action,
            func.count(Notification.id).label('count')
        ).group_by(Notification.action).all()
        
        # 按用户统计未读通知
        user_unread_stats = Notification.query.join(User).filter(
            Notification.read == False
        ).with_entities(
            User.username,
            func.count(Notification.id).label('unread_count')
        ).group_by(User.username).order_by(
            func.count(Notification.id).desc()
        ).limit(10).all()
        
        click.echo("=== 通知系统统计 ===")
        click.echo(f"总通知数: {total_notifications}")
        click.echo(f"未读通知: {unread_notifications}")
        click.echo(f"已读通知: {read_notifications}")
        click.echo()
        
        click.echo("=== 按动作类型统计 ===")
        for action, count in action_stats:
            click.echo(f"{action}: {count}")
        click.echo()
        
        click.echo("=== 用户未读通知排行 (Top 10) ===")
        for username, unread_count in user_unread_stats:
            click.echo(f"{username}: {unread_count}")

if __name__ == '__main__':
    cli()
