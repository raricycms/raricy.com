from datetime import datetime, timedelta
from typing import List, Optional, Tuple, Dict

from flask_login import current_user
from markupsafe import escape

from app.extensions import db
from app.models.message import Message, MessageLike
from app.service.notifications import send_notification


class MessageService:

    @staticmethod
    def _serialize_message(message: Message, current_user_id: Optional[str] = None) -> Dict:
        if message.is_deleted:
            display_name = None
            content_html = '[该留言已删除]'
            is_admin = False
        elif message.is_anonymous:
            display_name = '某位同学'
            content_html = message.content_html or ''
            is_admin = False
        else:
            display_name = message.author.username if message.author else '未知用户'
            content_html = message.content_html or ''
            is_admin = getattr(message.author, 'has_admin_rights', False) if message.author else False

        liked = False
        if current_user_id:
            liked = MessageLike.query.filter_by(
                message_id=message.id, user_id=current_user_id
            ).first() is not None

        return {
            'id': message.id,
            'author': {
                'id': message.author_id if not (message.is_deleted or message.is_anonymous) else None,
                'display_name': display_name,
                'is_admin': is_admin,
            },
            'parent_id': message.parent_id,
            'root_id': message.root_id,
            'content_html': content_html,
            'is_anonymous': message.is_anonymous,
            'is_deleted': message.is_deleted,
            'likes_count': message.likes_count,
            'liked': liked,
            'created_at': message.created_at.isoformat() if message.created_at else None,
            'updated_at': message.updated_at.isoformat() if message.updated_at else None,
            'children': [],
        }

    @staticmethod
    def _build_thread_tree(messages: List[Dict]) -> List[Dict]:
        id_to_node: Dict[str, Dict] = {}
        roots: List[Dict] = []

        for m in messages:
            id_to_node[m['id']] = m

        for m in messages:
            node = id_to_node[m['id']]
            if m['parent_id'] and m['parent_id'] in id_to_node:
                parent_node = id_to_node[m['parent_id']]
                parent_node['children'].append(node)
            else:
                roots.append(node)

        def sort_children(n: Dict):
            n['children'].sort(key=lambda x: x['created_at'] or '')
            for ch in n['children']:
                sort_children(ch)

        for r in roots:
            sort_children(r)

        roots.sort(key=lambda x: x['created_at'] or '', reverse=True)
        return roots

    @staticmethod
    def list_messages(current_user_id: Optional[str] = None) -> List[Dict]:
        messages = Message.query.filter_by(
            is_deleted=False
        ).order_by(Message.created_at.asc()).all()

        if not messages:
            return []

        serialized = [MessageService._serialize_message(m, current_user_id) for m in messages]
        return MessageService._build_thread_tree(serialized)

    @staticmethod
    def create_message(content: str, is_anonymous: bool = False, parent_id: Optional[str] = None) -> Tuple[bool, str, Optional[Dict]]:
        if not getattr(current_user, 'is_core_user', False):
            return False, '只有核心用户或管理员可以发言', None

        if not getattr(current_user, 'has_admin_rights', False) and current_user.is_currently_banned():
            return False, '您已被禁言，无法发言', None

        recent = Message.query.filter(
            Message.author_id == current_user.id,
            Message.created_at >= datetime.now() - timedelta(seconds=15),
            Message.is_deleted == False
        ).first()
        if recent:
            return False, '发言过于频繁，请稍后再试', None

        content = content.strip()
        if not content:
            return False, '留言内容不能为空', None
        if len(content) > 500:
            return False, '留言内容不能超过500字', None

        parent = None
        root_id: Optional[str] = None
        if parent_id:
            parent = Message.query.get(parent_id)
            if not parent or parent.is_deleted:
                return False, '父留言不存在或已删除', None
            root_id = parent.root_id or parent.id

        escaped = escape(content)
        content_html = str(escaped).replace('\n', '<br>')

        message = Message(
            author_id=current_user.id,
            parent_id=parent.id if parent else None,
            root_id=root_id,
            content=content,
            content_html=content_html,
            is_anonymous=is_anonymous,
        )
        db.session.add(message)
        db.session.commit()

        try:
            if parent and parent.author_id != current_user.id:
                send_notification(
                    recipient_id=parent.author_id,
                    action='留言回复',
                    actor_id=current_user.id,
                    object_type='message_board',
                    object_id=message.id,
                    detail='你的留言收到了回复'
                )
        except Exception:
            pass

        return True, '留言成功', MessageService._serialize_message(message, current_user.id)

    @staticmethod
    def delete_message(message_id: str, reason: Optional[str] = None) -> Tuple[bool, str]:
        message = Message.query.get(message_id)
        if not message or message.is_deleted:
            return False, '留言不存在或已删除'

        is_admin = getattr(current_user, 'has_admin_rights', False)
        is_owner = (message.author_id == current_user.id)

        if not (is_admin or is_owner):
            return False, '无权删除该留言'

        admin_deleting_others = is_admin and not is_owner
        if admin_deleting_others:
            reason = (reason or '').strip()
            if not reason:
                return False, '请提供删除原因'
            if len(reason) > 500:
                return False, '删除原因过长（最多500字）'

        message.is_deleted = True
        db.session.commit()

        if admin_deleting_others:
            try:
                from app.service.audit_log import log_admin_action
                log_admin_action(
                    action='delete_message',
                    admin_id=current_user.id,
                    target_user_id=message.author_id,
                    object_type='message_board',
                    object_id=message.id,
                    reason=reason or '违反规则',
                )
            except Exception:
                pass

        return True, '删除成功'

    @staticmethod
    def toggle_like(message_id: str) -> Tuple[bool, str, bool, int]:
        message = Message.query.get(message_id)
        if not message or message.is_deleted:
            return False, '留言不存在', False, 0

        existing = MessageLike.query.filter_by(
            message_id=message_id,
            user_id=current_user.id
        ).first()

        if existing:
            db.session.delete(existing)
            message.likes_count = max(0, (message.likes_count or 1) - 1)
            liked = False
        else:
            like = MessageLike(message_id=message_id, user_id=current_user.id)
            db.session.add(like)
            message.likes_count = (message.likes_count or 0) + 1
            liked = True

        db.session.commit()

        if liked and message.author_id != current_user.id:
            try:
                send_notification(
                    recipient_id=message.author_id,
                    action='留言点赞',
                    actor_id=current_user.id,
                    object_type='message_board',
                    object_id=message_id,
                    detail='你的留言收到了点赞'
                )
            except Exception:
                pass

        return True, '操作成功', liked, message.likes_count
