from app.extensions import db
from datetime import datetime


class FishTransaction(db.Model):
    """小鱼干交易流水 — 记录每一笔鱼的出入账"""
    __tablename__ = 'fish_transactions'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    amount = db.Column(db.Float, nullable=False)               # 正=获得, 负=消费
    type = db.Column(db.String(32), nullable=False, index=True)  # checkin / admin_grant / purchase / refund / transfer
    description = db.Column(db.String(255), nullable=True)
    reference_type = db.Column(db.String(32), nullable=True)     # 关联对象类型
    reference_id = db.Column(db.String(255), nullable=True)      # 关联对象ID
    related_user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=True, index=True)  # 对手方（转账/打赏等场景）
    created_at = db.Column(db.DateTime, default=datetime.now, index=True)

    user = db.relationship('User', foreign_keys=[user_id],
                           backref=db.backref('fish_transactions', lazy='dynamic'))
    related_user = db.relationship('User', foreign_keys=[related_user_id])

    def to_dict(self):
        return {
            'id': self.id,
            'user_id': self.user_id,
            'amount': self.amount,
            'type': self.type,
            'description': self.description,
            'reference_type': self.reference_type,
            'reference_id': self.reference_id,
            'related_user_id': self.related_user_id,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }
