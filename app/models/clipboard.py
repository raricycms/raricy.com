from app.extensions import db
from datetime import datetime
from app.utils.generate_stringid import generate_id 

class ClipBoard(db.Model):
    __tablename__ = 'clipboards'

    id = db.Column(db.String(8), primary_key=True, index=True)

    title = db.Column(db.String(100), nullable=False, index=True)
    author_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=datetime.now, index=True)

    ignore = db.Column(db.Boolean, default=False, index=True)
    
    publicity = db.Column(db.Boolean, default=True, index=True)

    def __init__(self, **kwargs):
        super(ClipBoard, self).__init__(**kwargs)
        if not getattr(self, 'id', None):
            self.id = str(generate_id())

    def __repr__(self) -> str:
        return f'<ClipBoard {self.id}>'

    def to_dict(self) -> dict:
        return {
                'id': self.id,
                'title': self.title,
                'author_id': self.author_id,
                'created_at': self.created_at,
                'ignore': self.ignore,
                'publicity': self.publicity
                }

class ClipText(db.Model):

    __tablename__ = 'clip_text'

    clip_id = db.Column(db.String(8), db.ForeignKey('clipboards.id'), primary_key=True)

    content = db.Column(db.Text, nullable=False)

    updated_at = db.Column(db.DateTime, default=datetime.now, onupdate=datetime.now)

    clipboard = db.relationship(
            'ClipBoard',
            backref = db.backref('content_obj', uselist=False, cascade='all, delete-orphan')
            )

    def __repr__(self) -> str:
        return f'<ClipText clip_id={self.clip_id} len={len(self.content) if self.content else 0}>'

