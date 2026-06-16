"""
点赞业务逻辑服务
"""
import time
from flask_login import current_user
from app.extensions import db
from app.models import Blog, BlogLike
from app.service.notifications import send_notification

# 点赞频率限制（内存追踪，同评论保持一致策略）
_like_timestamps = {}  # user_id -> [timestamp, ...]
_LIKE_HOURLY_MAX = 100
_LIKE_HOURLY_WINDOW = 3600
_LIKE_DAILY_MAX = 500
_LIKE_DAILY_WINDOW = 86400


def _check_like_rate(user_id):
    """
    检查用户点赞频率：
    - 每小时最多 100 条
    - 每天最多 500 条
    返回 (allowed: bool, error_message: str | None)
    """
    now = time.time()
    timestamps = _like_timestamps.get(user_id, [])

    # 清理过期记录（保留一天以内的）
    timestamps = [t for t in timestamps if now - t < _LIKE_DAILY_WINDOW]

    # 日限额检查
    if len(timestamps) >= _LIKE_DAILY_MAX:
        _like_timestamps[user_id] = timestamps
        return False, "今日点赞已达上限（500条），请明日再试"

    # 时限额检查
    hourly_count = sum(1 for t in timestamps if now - t < _LIKE_HOURLY_WINDOW)
    if hourly_count >= _LIKE_HOURLY_MAX:
        _like_timestamps[user_id] = timestamps
        return False, "点赞过于频繁，1小时内最多点赞100条，请稍后再试"

    timestamps.append(now)
    _like_timestamps[user_id] = timestamps
    return True, None


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
                # 重新点赞：需要检查频率限制
                allowed, err_msg = _check_like_rate(current_user.id)
                if not allowed:
                    return False, err_msg, False, blog.likes_count or 0
                like.deleted = False
                blog.likes_count = (blog.likes_count or 0) + 1
                liked = True
            else:
                blog.likes_count = max(0, (blog.likes_count or 0) - 1)
                liked = False
                like.deleted = True
        else:
            # 首次点赞：需要检查频率限制
            allowed, err_msg = _check_like_rate(current_user.id)
            if not allowed:
                return False, err_msg, False, blog.likes_count or 0
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
        
        q = BlogLike.query.filter_by(blog_id=blog_id, deleted=False).order_by(BlogLike.created_at.desc())
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
