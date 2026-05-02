import uuid
from datetime import datetime
from app.extensions import db


class PhotoWallItem(db.Model):
    __tablename__ = 'photo_wall_items'

    id = db.Column(db.String(36), primary_key=True, index=True)
    image_id = db.Column(db.String(10), db.ForeignKey('image_hosting.id'), nullable=False, index=True)
    x = db.Column(db.Float, default=0.0, nullable=False)
    y = db.Column(db.Float, default=0.0, nullable=False)
    rotation = db.Column(db.Float, default=0.0, nullable=False)
    z_index = db.Column(db.Integer, default=0, nullable=False)
    scale = db.Column(db.Float, default=1.0, nullable=False)
    author_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=datetime.now, index=True)
    updated_at = db.Column(db.DateTime, default=datetime.now, onupdate=datetime.now)
    ignore = db.Column(db.Boolean, default=False, index=True)

    image = db.relationship('ImageHosting', backref=db.backref('wall_items', lazy='dynamic'))
    author = db.relationship('User', backref=db.backref('wall_items', lazy='dynamic'))

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.id = str(uuid.uuid4())

    def to_dict(self):
        return {
            'id': self.id,
            'image_id': self.image_id,
            'x': self.x,
            'y': self.y,
            'rotation': self.rotation,
            'z_index': self.z_index,
            'scale': self.scale,
            'author_id': self.author_id,
            'author_name': self.author.username if self.author else None,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
        }

    def __repr__(self):
        return f'<PhotoWallItem {self.id} image={self.image_id}>'
