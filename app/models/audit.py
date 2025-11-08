from app.extensions import db
from datetime import datetime


class AdminActionLog(db.Model):
    __tablename__ = 'admin_action_logs'

    id = db.Column(db.Integer, primary_key=True)
    created_at = db.Column(db.DateTime, default=datetime.now, index=True)

    # 动作类型：ban_user / unban_user / delete_blog / delete_comment
    action = db.Column(db.String(32), nullable=False, index=True)

    admin_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    target_user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=True, index=True)

    object_type = db.Column(db.String(32), nullable=True)  # user/blog/comment
    object_id = db.Column(db.String(36), nullable=True, index=True)

    reason = db.Column(db.String(255), nullable=True)
    extra = db.Column(db.JSON, nullable=True)
    visibility = db.Column(db.String(16), default='public', nullable=False, index=True)  # public/private

    admin = db.relationship('User', foreign_keys=[admin_id])
    target_user = db.relationship('User', foreign_keys=[target_user_id])

    def to_dict(self):
        return {
            'id': self.id,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'action': self.action,
            'admin': {
                'id': self.admin.id if self.admin else self.admin_id,
                'username': self.admin.username if self.admin else None
            },
            'target_user': {
                'id': self.target_user.id if self.target_user else self.target_user_id,
                'username': self.target_user.username if self.target_user else None
            } if self.target_user_id else None,
            'object': {
                'type': self.object_type,
                'id': self.object_id
            } if self.object_type or self.object_id else None,
            'reason': self.reason,
            'extra': self.extra or {},
            'visibility': self.visibility
        }


class AdminActionAppeal(db.Model):
    __tablename__ = 'admin_action_appeals'

    id = db.Column(db.Integer, primary_key=True)
    created_at = db.Column(db.DateTime, default=datetime.now, index=True)
    updated_at = db.Column(db.DateTime, default=datetime.now, onupdate=datetime.now)

    log_id = db.Column(db.Integer, db.ForeignKey('admin_action_logs.id'), nullable=False, index=True)
    appellant_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)

    content = db.Column(db.Text, nullable=False)
    status = db.Column(db.String(16), default='pending', nullable=False, index=True)  # pending/accepted/rejected
    decision = db.Column(db.Text, nullable=True)
    decided_by = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=True)
    decided_at = db.Column(db.DateTime, nullable=True)

    log = db.relationship('AdminActionLog', backref=db.backref('appeals', lazy='dynamic', cascade='all, delete-orphan'))
    appellant = db.relationship('User', foreign_keys=[appellant_id])
    decider = db.relationship('User', foreign_keys=[decided_by])

    def to_dict(self):
        return {
            'id': self.id,
            'log_id': self.log_id,
            'appellant': {
                'id': self.appellant.id if self.appellant else self.appellant_id,
                'username': self.appellant.username if self.appellant else None
            },
            'content': self.content,
            'status': self.status,
            'decision': self.decision,
            'decided_by': self.decider.username if self.decider else None,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            'decided_at': self.decided_at.isoformat() if self.decided_at else None
        }


