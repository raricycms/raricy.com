from app.extensions import db
from datetime import datetime
from werkzeug.security import generate_password_hash, check_password_hash
from flask_login import UserMixin
import uuid

class User(UserMixin, db.Model):
    __tablename__ = 'users'
    
    id = db.Column(db.String(36), primary_key=True, index=True)
    username: str = db.Column(db.String(80), unique=True, nullable=False, index=True)
    email: str = db.Column(db.String(120), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.now)
    last_login = db.Column(db.DateTime, default=datetime.now)
    authenticated = db.Column(db.Boolean, default=False)
    is_admin = db.Column(db.Boolean, default=False)
    avatar_path = db.Column(db.String(255))
    
    def set_password(self, password):
        """设置密码"""
        self.password_hash = generate_password_hash(password)
    
    def check_password(self, password):
        """验证密码"""
        return check_password_hash(self.password_hash, password)
    
    def to_dict(self):
        """
        将用户对象转换为字典格式，用于序列化。
        """
        return {
            'id': self.id,
            'username': self.username,
            'email': self.email,
            'avatar_path': self.avatar_path,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'last_login': self.last_login.isoformat() if self.last_login else None,
            'is_admin': self.is_admin,
            'authenticated': self.authenticated,
            'password_hash': self.password_hash
        }
    
    def __repr__(self):
        """
        返回用户对象的字符串表示，用于调试。
        """
        return f'<User {self.username}>'
    
    def __init__(self, **kwargs):
        super(User, self).__init__(**kwargs)
        self.id = str(uuid.uuid4())
    
    

class InviteCode(db.Model):
    """
    邀请码模型类，用于存储和管理邀请码。
    """
    __tablename__ = 'invite_codes'
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(12), unique=True, nullable=False)
    is_used = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.now)
    used_by = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=True)
