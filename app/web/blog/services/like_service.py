"""
点赞业务逻辑服务
"""
from flask_login import current_user
from app.extensions import db
from app.models import Blog, BlogLike
from app.service.notifications import send_notification


class LikeService:
    """点赞业务逻辑服务"""
    
    @staticmethod
    def toggle_like(blog_id):
        """
        切换点赞状态
        
        Args:
            blog_id: 博客ID
            
        Returns:
            tuple: (success, message, liked, likes_count)
        """
        blog = Blog.query.get(blog_id)
        if not blog or blog.ignore:
            return False, "未找到文章", False, 0
        
        like = BlogLike.query.filter_by(blog_id=blog_id, user_id=current_user.id).first()
        if like:
            if like.deleted:
                like.deleted = False
                blog.likes_count = (blog.likes_count or 0) + 1
                liked = True
            else:
            # 取消点赞
                blog.likes_count = max(0, (blog.likes_count or 0) - 1)
                liked = False
                like.deleted = True
        else:
            # 点赞
            like = BlogLike(blog_id=blog_id, user_id=current_user.id, notification_sent=False)
            db.session.add(like)
            blog.likes_count = (blog.likes_count or 0) + 1
            liked = True
            
            # 发送点赞通知给文章作者（但不给自己发，且只发送一次）
            if blog.author_id != current_user.id and not like.notification_sent:
                try:
                    send_notification(
                        recipient_id=blog.author_id,
                        action="文章点赞",
                        actor_id=current_user.id,
                        object_type="blog",
                        object_id=blog_id,
                        detail=f"你的文章《{blog.title}》收到了一个新的点赞！"
                    )
                    # 标记通知已发送
                    like.notification_sent = True
                except Exception as e:
                    # 通知发送失败不影响点赞功能
                    from flask import current_app
                    current_app.logger.warning(f"Failed to send like notification: {e}")
        
        db.session.commit()
        return True, "操作成功", liked, blog.likes_count
    
    @staticmethod
    def get_likers(blog_id, offset=0, limit=50):
        """
        获取点赞者列表
        
        Args:
            blog_id: 博客ID
            offset: 偏移量
            limit: 限制数量
            
        Returns:
            tuple: (success, message, data)
        """
        blog = Blog.query.get(blog_id)
        if not blog:
            return False, "未找到文章", None
        
        # 限制参数范围
        limit = max(1, min(limit, 200))
        offset = max(0, offset)
        
        q = BlogLike.query.filter_by(blog_id=blog_id).order_by(BlogLike.created_at.desc())
        total = q.count()
        likes = q.offset(offset).limit(limit).all()
        
        users = []
        for like in likes:
            user = like.user
            users.append({
                'id': user.id if user else like.user_id,
                'username': user.username if user else None,
                'avatar_url': f"/auth/avatar/{user.id if user else like.user_id}",
                'liked_at': like.created_at.strftime('%Y-%m-%d %H:%M:%S') if like.created_at else None,
            })
        
        data = {
            'total': total,
            'offset': offset,
            'limit': limit,
            'users': users
        }
        
        return True, "获取成功", data
