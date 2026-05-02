from app.extensions import db
from datetime import datetime
import secrets
import string


def generate_image_id(length=10):
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


class ImageHosting(db.Model):
    __tablename__ = 'image_hosting'

    id = db.Column(db.String(10), primary_key=True, index=True)
    filename = db.Column(db.String(255), nullable=False)
    file_size = db.Column(db.Integer, nullable=False)
    mime_type = db.Column(db.String(50), nullable=False)
    author_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=datetime.now, index=True)
    is_public = db.Column(db.Boolean, default=True)
    ignore = db.Column(db.Boolean, default=False, index=True)

    author = db.relationship('User', backref=db.backref('images', lazy='dynamic'))

    @property
    def ext(self):
        ext_map = {
            'image/png': '.png',
            'image/jpeg': '.jpg',
            'image/gif': '.gif',
            'image/webp': '.webp',
            'image/svg+xml': '.svg',
        }
        return ext_map.get(self.mime_type, '')

    @property
    def storage_path(self):
        import os
        from flask import current_app
        folder = current_app.config.get('IMAGE_UPLOAD_FOLDER')
        return os.path.join(folder, self.id + self.ext)

    def to_dict(self):
        return {
            'id': self.id,
            'filename': self.filename,
            'file_size': self.file_size,
            'mime_type': self.mime_type,
            'author_id': self.author_id,
            'author_name': self.author.username if self.author else None,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'is_public': self.is_public,
            'ext': self.ext,
        }
