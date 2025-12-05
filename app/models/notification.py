from app.extensions import db
from datetime import datetime
import uuid


class Notification(db.Model):
    __tablename__ = 'notifications'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    timestamp = db.Column(db.DateTime, default=datetime.now, index=True)
    
    # 通知种类
    action = db.Column(db.String(50), nullable=False)
    
    # 消息接收者
    recipient_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    recipient = db.relationship('User', foreign_keys=[recipient_id], backref=db.backref('notifications', lazy='dynamic', cascade='all, delete-orphan'))

    # 动作的发起者 (null代表系统通知)
    actor_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=True)
    actor = db.relationship('User', foreign_keys=[actor_id], backref=db.backref('sent_notifications', lazy='dynamic'))


    # 动作的关联对象（比如一篇博客文章）
    object_type = db.Column(db.String(50), nullable=True)
    object_id = db.Column(db.String(36), nullable=True)
    
    # 通知的详细信息
    detail = db.Column(db.Text, nullable=True)

    # 是否已读
    read = db.Column(db.Boolean, default=False, nullable=False)

    def __repr__(self):
        return f'<Notification {self.id} for user={self.recipient_id}, action={self.action}>'
    
    def to_dict(self):
        # 这个 to_dict 方法可以利用 relationship 变得更强大
        actor_info = {'id': None, 'username': 'system'}
        if self.actor:  # 如果 actor 关系存在
            actor_info = {'id': self.actor.id, 'username': self.actor.username}

        return {
            'id': self.id,
            'timestamp': self.timestamp.isoformat(),
            'action': self.action,
            'recipient_id': self.recipient_id,
            'actor': actor_info,  # 返回一个包含 actor 信息的对象
            'object': {
                'type': self.object_type,
                'id': self.object_id
            },
            'detail': self.detail,
            'read': self.read
        }

    def get_object(self):
        if self.object_type and self.object_id:
            if self.object_type == 'blog':
                # 延迟导入，避免循环依赖
                from app.models import Blog
                return Blog.query.get(self.object_id)
        return None


