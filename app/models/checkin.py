from datetime import datetime
from app.extensions import db


class DailyCheckIn(db.Model):
    __tablename__ = 'daily_checkins'
    __table_args__ = (
        db.UniqueConstraint('user_id', 'checkin_date', name='uq_user_checkin_date'),
    )

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    checkin_date = db.Column(db.Date, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.now)

    # 运势系统
    fortune_value = db.Column(db.Integer, nullable=True)       # 1-5，用户选牌后赋值
    fortune_pool  = db.Column(db.String(50), nullable=True)    # 洗牌排列，如 "3,1,5,2,4"

    user = db.relationship('User', backref=db.backref('checkins', lazy='dynamic'))

    def to_dict(self):
        return {
            'id': self.id,
            'user_id': self.user_id,
            'checkin_date': self.checkin_date.isoformat() if self.checkin_date else None,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'fortune_value': self.fortune_value,
            'fortune_pool': self.fortune_pool,
        }
