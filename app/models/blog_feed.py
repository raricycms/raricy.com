from app.extensions import db
from datetime import datetime


class BlogFeed(db.Model):
    """文章投喂记录 — 用户对文章投喂小鱼干的累计记录"""
    __tablename__ = 'blog_feeds'

    id = db.Column(db.Integer, primary_key=True)
    blog_id = db.Column(db.String(36), db.ForeignKey('blogs.id'), nullable=False, index=True)
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    amount = db.Column(db.Float, default=0.0, nullable=False)  # 累计投喂量，单用户每篇文章最多 5
    created_at = db.Column(db.DateTime, default=datetime.now)
    updated_at = db.Column(db.DateTime, default=datetime.now, onupdate=datetime.now)

    __table_args__ = (
        db.UniqueConstraint('blog_id', 'user_id', name='uq_blog_feed_user'),
    )

    blog = db.relationship('Blog', backref=db.backref('feeds', lazy='dynamic'))
    user = db.relationship('User', backref=db.backref('blog_feeds', lazy='dynamic'))

    def to_dict(self):
        return {
            'id': self.id,
            'blog_id': self.blog_id,
            'user_id': self.user_id,
            'amount': self.amount,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
        }
