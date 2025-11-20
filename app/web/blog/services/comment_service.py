from datetime import datetime, timedelta
from typing import List, Optional, Tuple, Dict

from flask_login import current_user
from markupsafe import escape

from app.extensions import db
from app.models import Blog, BlogComment
from app.service.notifications import send_notification


class CommentService:
    """评论业务逻辑服务"""

    @staticmethod
    def _serialize_comment(comment: BlogComment) -> Dict:
        if comment.is_deleted:
            content_html = "[该评论已删除]"
        else:
            content_html = comment.content_html or ''
        return {
            'id': comment.id,
            'blog_id': comment.blog_id,
            'author': {
                'id': comment.author.id if comment.author else None,
                'username': comment.author.username if comment.author else None,
                'is_admin': getattr(comment.author, 'has_admin_rights', False) if comment.author else False,
            },
            'parent_id': comment.parent_id,
            'root_id': comment.root_id,
            'content_html': content_html,
            'status': comment.status,
            'is_deleted': comment.is_deleted,
            'likes_count': comment.likes_count,
            'created_at': comment.created_at.isoformat() if comment.created_at else None,
            'updated_at': comment.updated_at.isoformat() if comment.updated_at else None,
            'children': []  # 由构建树方法填充
        }

    @staticmethod
    def _build_comment_tree(comments: List[BlogComment]) -> List[Dict]:
        """将评论列表构建为嵌套树结构。"""
        id_to_node: Dict[str, Dict] = {}
        roots: List[Dict] = []

        # 初始化节点
        for c in comments:
            id_to_node[c.id] = CommentService._serialize_comment(c)

        # 建树
        for c in comments:
            node = id_to_node[c.id]
            if c.parent_id and c.parent_id in id_to_node:
                parent_node = id_to_node[c.parent_id]
                parent_node['children'].append(node)
            else:
                roots.append(node)

        # 递归对每个 children 按时间排序
        def sort_children(n: Dict):
            n['children'].sort(key=lambda x: x['created_at'] or '')
            for ch in n['children']:
                sort_children(ch)

        for r in roots:
            sort_children(r)

        # 顶层按时间排序
        roots.sort(key=lambda x: x['created_at'] or '')
        return roots

    @staticmethod
    def list_comments(blog_id: str) -> List[Dict]:
        """获取某篇文章的所有评论（已批准且未删除），返回树结构。"""
        comments = BlogComment.query.filter_by(
            blog_id=blog_id,
            status='approved'
            #is_deleted=False
        ).order_by(BlogComment.created_at.asc()).all()

        if not comments:
            return []

        return CommentService._build_comment_tree(comments)

    @staticmethod
    def create_comment(blog_id: str, content: str, parent_id: Optional[str] = None) -> Tuple[bool, str, Optional[Dict]]:
        """
        创建评论。

        规则：
        - 仅核心用户或管理员可发评论
        - 禁言用户禁止发言（管理员不受限）
        - 频率限制：30 秒 1 条
        - 内容长度：1..2000
        - 不支持 Markdown：保存时进行 HTML 转义，并将换行转 <br>
        - 楼中楼：parent_id 可选；root_id 指向最顶层评论
        """
        # 权限校验
        if not getattr(current_user, 'is_core_user', False):
            return False, '只有核心用户或管理员可以发表评论', None

        # 禁言检查（管理员除外）
        if not getattr(current_user, 'has_admin_rights', False) and current_user.is_currently_banned():
            return False, '您已被禁言，无法发表评论', None

        # 频率限制：最近 30 秒内是否已有评论
        one_minute_ago = datetime.now() - timedelta(seconds=30)
        recent_exists = BlogComment.query.filter(
            BlogComment.author_id == current_user.id,
            BlogComment.created_at >= one_minute_ago,
            BlogComment.is_deleted == False
        ).first()
        if recent_exists:
            return False, '发言过于频繁，请稍后再试', None

        # 验证文章存在
        blog = Blog.query.get(blog_id)
        if not blog or blog.ignore:
            return False, '文章不存在', None

        # 验证内容
        if content is None:
            return False, '评论内容不能为空', None
        content = content.strip()
        if not content:
            return False, '评论内容不能为空', None
        if len(content) > 2000:
            return False, '评论内容不能超过2000字', None

        # 处理父评论与 root_id
        parent = None
        root_id: Optional[str] = None
        if parent_id:
            parent = BlogComment.query.get(parent_id)
            if not parent or parent.blog_id != blog_id or parent.is_deleted:
                return False, '父评论不存在或已删除', None
            root_id = parent.root_id or parent.id

        # 构建 content_html：仅转义 + 换行转 <br>
        escaped = escape(content)
        content_html = str(escaped).replace('\n', '<br>')

        # 创建记录
        comment = BlogComment(
            blog_id=blog_id,
            author_id=current_user.id,
            parent_id=parent.id if parent else None,
            root_id=root_id,
            content=content,
            content_html=content_html,
            status='approved',
            is_deleted=False,
            created_at=datetime.now(),
        )
        db.session.add(comment)

        # 维护博客冗余字段
        blog.comments_count = (blog.comments_count or 0) + 1
        blog.last_comment_at = datetime.now()

        db.session.commit()

        # 发送通知：回复则通知被回复者；否则通知文章作者（排除自己）
        try:
            if parent and parent.author_id != current_user.id:
                send_notification(
                    recipient_id=parent.author_id,
                    action='评论回复',
                    actor_id=current_user.id,
                    object_type='blog',
                    object_id=blog_id,
                    detail=f'你的评论在《{blog.title}》下收到了回复'
                )
            elif not parent and blog.author_id != current_user.id:
                send_notification(
                    recipient_id=blog.author_id,
                    action='文章评论',
                    actor_id=current_user.id,
                    object_type='blog',
                    object_id=blog_id,
                    detail=f'你的文章《{blog.title}》收到了新评论'
                )
        except Exception:
            # 通知失败不影响主流程
            pass

        return True, '评论成功', CommentService._serialize_comment(comment)

    @staticmethod
    def delete_comment(comment_id: str, reason: Optional[str] = None) -> Tuple[bool, str]:
        """删除（软删）评论：作者本人或管理员可删除。
        - 管理员删除他人评论时必须给出删除原因（1..500）。
        """
        comment = BlogComment.query.get(comment_id)
        if not comment or comment.is_deleted:
            return False, '评论不存在或已删除'

        is_admin = getattr(current_user, 'has_admin_rights', False)
        is_owner = (comment.author_id == current_user.id)

        if not (is_admin or is_owner):
            return False, '无权删除该评论'

        admin_deleting_others = is_admin and not is_owner
        if admin_deleting_others:
            reason = (reason or '').strip()
            if not reason:
                return False, '请提供删除原因'
            if len(reason) > 500:
                return False, '删除原因过长（最多500字）'

        comment.is_deleted = True
        # 可选：清空展示内容，保留审计
        # comment.content = ''
        # comment.content_html = ''

        # 维护计数
        blog = Blog.query.get(comment.blog_id)
        if blog and (blog.comments_count or 0) > 0:
            blog.comments_count = (blog.comments_count or 0) - 1

        was_admin_delete = admin_deleting_others
        db.session.commit()

        # 记录管理员操作日志（管理员删除他人评论）
        if was_admin_delete:
            try:
                from app.service.audit_log import log_admin_action
                log_admin_action(
                    action='delete_comment',
                    admin_id=current_user.id,
                    target_user_id=comment.author_id,
                    object_type='comment',
                    object_id=comment.id,
                    reason=reason or '违反规则',
                    metadata={'blog_id': comment.blog_id}
                )
            except Exception:
                pass
        return True, '删除成功'


