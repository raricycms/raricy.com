#!/usr/bin/env python3
"""
博客通知功能使用示例

演示了新增的文章相关通知功能，包括：
- 文章被点赞通知
- 文章被管理员编辑通知
- 文章被管理员删除通知
- 用户通知偏好设置
"""

from app import create_app
from app.models import User, Blog, BlogLike, BlogContent
from app.service.notifications import send_notification, get_unread_notification_count
from app.extensions import db

def demo_like_notification():
    """演示文章点赞通知功能"""
    print("=== 文章点赞通知演示 ===")
    
    with create_app().app_context():
        # 获取一个作者和一个点赞者
        author = User.query.filter(User.role == 'user').first()
        liker = User.query.filter(User.id != author.id, User.role == 'user').first()
        
        if not author or not liker:
            print("需要至少两个非管理员用户来演示此功能")
            return
        
        # 获取作者的一篇文章
        blog = Blog.query.filter_by(author_id=author.id, ignore=False).first()
        if not blog:
            print(f"用户 {author.username} 没有文章可以点赞")
            return
        
        print(f"用户 {liker.username} 为 {author.username} 的文章《{blog.title}》点赞")
        
        # 模拟点赞操作（这通常在 web 路由中发生）
        existing_like = BlogLike.query.filter_by(blog_id=blog.id, user_id=liker.id).first()
        if not existing_like:
            # 创建点赞记录
            like = BlogLike(blog_id=blog.id, user_id=liker.id)
            db.session.add(like)
            blog.likes_count = (blog.likes_count or 0) + 1
            
            # 发送通知（只有在作者设置允许且不是自己点赞时）
            if author.notify_like and author.id != liker.id:
                send_notification(
                    recipient_id=author.id,
                    action="文章点赞",
                    actor_id=liker.id,
                    object_type="blog",
                    object_id=blog.id,
                    detail=f"你的文章《{blog.title}》收到了一个新的点赞！"
                )
                print(f"✅ 点赞通知已发送给 {author.username}")
            else:
                print(f"❌ 未发送通知（用户设置不允许或自己点赞）")
            
            db.session.commit()
        else:
            print("该用户已经点赞过这篇文章")

def demo_edit_notification():
    """演示文章编辑通知功能"""
    print("\n=== 文章编辑通知演示 ===")
    
    with create_app().app_context():
        # 获取管理员和一篇文章作者
        admin = User.query.filter(User.role.in_(['admin', 'owner'])).first()
        author = User.query.filter(User.role == 'user').first()
        
        if not admin:
            print("需要管理员用户来演示此功能")
            return
        
        if not author:
            print("需要非管理员用户来演示此功能")
            return
        
        # 获取作者的文章
        blog = Blog.query.filter_by(author_id=author.id, ignore=False).first()
        if not blog:
            print(f"用户 {author.username} 没有文章可以编辑")
            return
        
        print(f"管理员 {admin.username} 编辑了 {author.username} 的文章《{blog.title}》")
        
        # 模拟编辑操作
        old_title = blog.title
        new_title = blog.title + " [已编辑]"
        
        # 检查是否有修改
        has_changes = old_title != new_title
        changes_detail = [f"标题从《{old_title}》改为《{new_title}》"]
        
        # 更新文章
        blog.title = new_title
        
        # 发送编辑通知（管理员编辑且不是作者本人且用户允许接收）
        if has_changes and admin.is_admin and blog.author_id != admin.id and author.notify_edit:
            changes_text = "、".join(changes_detail)
            send_notification(
                recipient_id=author.id,
                action="文章编辑",
                actor_id=admin.id,
                object_type="blog",
                object_id=blog.id,
                detail=f"你的文章《{new_title}》已被管理员编辑。修改内容：{changes_text}"
            )
            print(f"✅ 编辑通知已发送给 {author.username}")
        else:
            print(f"❌ 未发送通知（无修改或用户设置不允许）")
        
        db.session.commit()

def demo_delete_notification():
    """演示文章删除通知功能"""
    print("\n=== 文章删除通知演示 ===")
    
    with create_app().app_context():
        # 获取管理员和一篇文章作者
        admin = User.query.filter(User.role.in_(['admin', 'owner'])).first()
        author = User.query.filter(User.role == 'user').first()
        
        if not admin or not author:
            print("需要管理员和普通用户来演示此功能")
            return
        
        # 获取作者的文章
        blog = Blog.query.filter_by(author_id=author.id, ignore=False).first()
        if not blog:
            print(f"用户 {author.username} 没有文章可以删除")
            return
        
        print(f"管理员 {admin.username} 删除了 {author.username} 的文章《{blog.title}》")
        
        # 保存文章信息用于通知
        blog_title = blog.title
        blog_author_id = blog.author_id
        
        # 发送删除通知（如果不是作者自己删除且用户允许接收）
        if blog_author_id != admin.id and author.notify_delete:
            send_notification(
                recipient_id=blog_author_id,
                action="文章删除",
                actor_id=admin.id,
                object_type="blog",
                object_id=blog.id,
                detail=f"你的文章《{blog_title}》已被管理员删除。如有疑问，请联系管理员。"
            )
            print(f"✅ 删除通知已发送给 {author.username}")
        else:
            print(f"❌ 未发送通知（用户设置不允许）")
        
        # 注意：这里不实际删除文章，只是演示通知发送
        print("（演示模式：文章未实际删除）")

def demo_notification_settings():
    """演示通知设置功能"""
    print("\n=== 通知设置演示 ===")
    
    with create_app().app_context():
        user = User.query.filter(User.role == 'user').first()
        if not user:
            print("需要普通用户来演示此功能")
            return
        
        print(f"用户 {user.username} 的当前通知设置：")
        print(f"  文章点赞通知: {'✅ 开启' if getattr(user, 'notify_like', True) else '❌ 关闭'}")
        print(f"  文章编辑通知: {'✅ 开启' if getattr(user, 'notify_edit', True) else '❌ 关闭'}")
        print(f"  文章删除通知: {'✅ 开启' if getattr(user, 'notify_delete', True) else '❌ 关闭'}")
        print(f"  管理员通知: {'✅ 开启' if getattr(user, 'notify_admin', True) else '❌ 关闭'}")
        
        # 演示修改设置
        print(f"\n关闭 {user.username} 的文章点赞通知...")
        user.notify_like = False
        db.session.commit()
        
        print("设置已更新！现在点赞通知将不会发送给这个用户。")
        
        # 恢复设置
        user.notify_like = True
        db.session.commit()
        print("已恢复点赞通知设置。")

def demo_notification_count():
    """演示获取未读通知数量"""
    print("\n=== 通知统计演示 ===")
    
    with create_app().app_context():
        users = User.query.limit(5).all()
        
        for user in users:
            unread_count = get_unread_notification_count(user.id)
            print(f"用户 {user.username}: {unread_count} 条未读通知")

if __name__ == '__main__':
    print("博客通知功能演示")
    print("=" * 50)
    
    # 运行所有演示（注释掉以避免在导入时执行）
    # demo_like_notification()
    # demo_edit_notification()
    # demo_delete_notification()
    # demo_notification_settings()
    # demo_notification_count()
    
    print("\n演示代码执行完成。要实际运行演示，请取消注释相应的函数调用。")
    print("\n新增功能说明：")
    print("1. 📝 文章点赞通知 - 当用户文章被点赞时自动通知")
    print("2. ✏️  文章编辑通知 - 当管理员编辑用户文章时通知并说明修改内容")
    print("3. 🗑️  文章删除通知 - 当管理员删除用户文章时通知")
    print("4. ⚙️  通知偏好设置 - 用户可以选择接收哪些类型的通知")
    print("5. 🎯 智能过滤 - 根据用户设置自动过滤通知，避免打扰")
