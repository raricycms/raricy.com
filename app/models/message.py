from app.extensions import db
from datetime import datetime
import uuid


class Message(db.Model):
    __tablename__ = 'messages'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))

    author_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)

    parent_id = db.Column(db.String(36), db.ForeignKey('messages.id'), nullable=True, index=True)
    root_id = db.Column(db.String(36), db.ForeignKey('messages.id'), nullable=True, index=True)

    content = db.Column(db.Text, nullable=False)
    content_html = db.Column(db.Text, nullable=True)

    is_anonymous = db.Column(db.Boolean, default=False, nullable=False)
    is_deleted = db.Column(db.Boolean, default=False, index=True)

    likes_count = db.Column(db.Integer, default=0)

    created_at = db.Column(db.DateTime, default=datetime.now, index=True)
    updated_at = db.Column(db.DateTime, default=datetime.now, onupdate=datetime.now)

    author = db.relationship('User', backref=db.backref('messages', lazy='dynamic', cascade='all, delete-orphan'))

    parent = db.relationship(
        'Message',
        remote_side=[id],
        primaryjoin='Message.parent_id == Message.id',
        foreign_keys=[parent_id],
        backref=db.backref(
            'children',
            lazy='dynamic',
            primaryjoin='Message.parent_id == Message.id',
            foreign_keys='Message.parent_id',
        ),
    )
    root = db.relationship(
        'Message',
        remote_side=[id],
        primaryjoin='Message.root_id == Message.id',
        foreign_keys=[root_id],
        uselist=False,
    )

    def __repr__(self):
        return f'<Message {self.id} author={self.author_id}>'

    def to_dict(self):
        return {
            'id': self.id,
            'author_id': self.author_id,
            'parent_id': self.parent_id,
            'root_id': self.root_id,
            'content': self.content,
            'content_html': self.content_html,
            'is_anonymous': self.is_anonymous,
            'is_deleted': self.is_deleted,
            'likes_count': self.likes_count,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
        }


class MessageLike(db.Model):
    __tablename__ = 'message_likes'

    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.String(36), db.ForeignKey('messages.id'), nullable=False, index=True)
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=datetime.now)

    __table_args__ = (
        db.UniqueConstraint('message_id', 'user_id', name='uq_message_like_message_user'),
    )

    message = db.relationship('Message', backref=db.backref('likes', lazy='dynamic', cascade='all, delete-orphan'))
    user = db.relationship('User', backref=db.backref('message_likes', lazy='dynamic', cascade='all, delete-orphan'))

    def __repr__(self):
        return f'<MessageLike message={self.message_id} user={self.user_id}>'
