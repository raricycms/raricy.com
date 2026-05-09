from app.extensions import db
from datetime import datetime


class Vote(db.Model):
    __tablename__ = 'votes'

    id = db.Column(db.String(9), primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    author_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    is_locked = db.Column(db.Boolean, default=False)
    ignore = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.now)

    author = db.relationship('User', backref='votes')
    options = db.relationship('VoteOption', backref='vote', lazy='dynamic',
                              cascade='all, delete-orphan', order_by='VoteOption.sort_order')

    def to_dict(self):
        return {
            'id': self.id,
            'title': self.title,
            'author_id': self.author_id,
            'author_name': self.author.username if self.author else None,
            'is_locked': self.is_locked,
            'created_at': self.created_at.isoformat() if self.created_at else None,
        }


class VoteOption(db.Model):
    __tablename__ = 'vote_options'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    vote_id = db.Column(db.String(9), db.ForeignKey('votes.id'), nullable=False, index=True)
    label = db.Column(db.String(200), nullable=False)
    sort_order = db.Column(db.Integer, default=0)
    vote_count = db.Column(db.Integer, default=0)

    def to_dict(self):
        return {
            'id': self.id,
            'label': self.label,
            'count': self.vote_count,
        }


class VoteRecord(db.Model):
    __tablename__ = 'vote_records'

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    vote_id = db.Column(db.String(9), db.ForeignKey('votes.id'), nullable=False, index=True)
    option_id = db.Column(db.Integer, db.ForeignKey('vote_options.id'), nullable=False)
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.now)

    option = db.relationship('VoteOption', backref='records')
    user = db.relationship('User', backref='vote_records')

    __table_args__ = (
        db.UniqueConstraint('vote_id', 'user_id', name='uq_vote_user'),
    )
