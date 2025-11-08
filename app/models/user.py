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
    authenticated = db.Column(db.Boolean, default=False)  # 是否为核心用户
    is_admin = db.Column(db.Boolean, default=False)
    avatar_path = db.Column(db.String(255))
    session_version = db.Column(db.Integer, default=0, nullable=False)
    
    # 通知设置
    notify_like = db.Column(db.Boolean, default=True)   # 文章被点赞通知
    notify_edit = db.Column(db.Boolean, default=True)   # 文章被编辑通知
    notify_delete = db.Column(db.Boolean, default=True) # 文章被删除通知
    notify_admin = db.Column(db.Boolean, default=True)  # 管理员通知
    
    # 禁言相关
    is_banned = db.Column(db.Boolean, default=False)           # 是否被禁言
    ban_until = db.Column(db.DateTime, nullable=True)          # 禁言结束时间
    ban_reason = db.Column(db.String(255), nullable=True)      # 禁言原因
    
    # 角色字段（user/core/admin/owner）
    role = db.Column(db.String(20), default='user', nullable=False, index=True)
    
    def set_password(self, password):
        """设置密码"""
        self.password_hash = generate_password_hash(password)
    
    def check_password(self, password):
        """验证密码"""
        return check_password_hash(self.password_hash, password)
    
    def is_currently_banned(self):
        """
        检查用户当前是否被禁言。
        """
        if not self.is_banned:
            return False
        
        if self.ban_until and datetime.now() > self.ban_until:
            # 禁言时间已过，自动解除禁言
            self.is_banned = False
            self.ban_until = None
            self.ban_reason = None
            db.session.commit()
            return False
        
        return True
    
    def get_ban_info(self):
        """
        获取当前禁言信息。
        """
        if not self.is_currently_banned():
            return None
        
        return {
            'is_banned': True,
            'ban_until': self.ban_until.isoformat() if self.ban_until else None,
            'reason': self.ban_reason,
            'remaining_hours': (self.ban_until - datetime.now()).total_seconds() / 3600 if self.ban_until else None
        }
    
    @property
    def ban_info(self):
        """兼容模板访问方式"""
        return self.get_ban_info()
    
    @property
    def is_owner(self) -> bool:
        """站长角色"""
        return getattr(self, 'role', 'user') == 'owner'
    
    def ban_user(self, admin_id, ban_until, reason):
        """
        禁言用户。
        
        Args:
            admin_id: 执行禁言的管理员ID
            ban_until: 禁言结束时间
            reason: 禁言原因
        """
        # 更新用户状态
        self.is_banned = True
        self.ban_until = ban_until
        self.ban_reason = reason
        
        # 记录禁言历史
        ban_record = UserBan(
            user_id=self.id,
            admin_id=admin_id,
            ban_until=ban_until,
            reason=reason
        )
        db.session.add(ban_record)
        db.session.commit()
        
        return ban_record
    
    def lift_ban(self, admin_id=None):
        """
        解除禁言。
        
        Args:
            admin_id: 执行解除的管理员ID（可选）
        """
        if not self.is_banned:
            return False
        
        # 更新用户状态
        self.is_banned = False
        self.ban_until = None
        self.ban_reason = None
        
        # 更新最近的禁言记录
        latest_ban = UserBan.query.filter_by(
            user_id=self.id, 
            is_lifted=False
        ).order_by(UserBan.banned_at.desc()).first()
        
        if latest_ban:
            latest_ban.is_lifted = True
            latest_ban.lifted_at = datetime.now()
            if admin_id:
                latest_ban.lifted_by = admin_id
        
        db.session.commit()
        return True

    def to_dict(self):
        """
        将用户对象转换为字典格式，用于序列化。
        """
        ban_info = self.get_ban_info()
        
        return {
            'id': self.id,
            'username': self.username,
            'email': self.email,
            'avatar_path': self.avatar_path,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'last_login': self.last_login.isoformat() if self.last_login else None,
            'is_admin': self.is_admin,
            'authenticated': self.authenticated,
            'role': getattr(self, 'role', 'user'),
            'notify_like': getattr(self, 'notify_like', True),
            'notify_edit': getattr(self, 'notify_edit', True),
            'notify_delete': getattr(self, 'notify_delete', True),
            'notify_admin': getattr(self, 'notify_admin', True),
            'ban_info': ban_info
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


class UserBan(db.Model):
    """
    用户禁言记录表，记录禁言历史。
    """
    __tablename__ = 'user_bans'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    admin_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    
    # 禁言时间
    banned_at = db.Column(db.DateTime, default=datetime.now, nullable=False)
    ban_until = db.Column(db.DateTime, nullable=False)
    
    # 禁言原因
    reason = db.Column(db.String(255), nullable=False)
    
    # 是否已被解除（手动解除时设置为True）
    is_lifted = db.Column(db.Boolean, default=False)
    lifted_at = db.Column(db.DateTime, nullable=True)
    lifted_by = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=True)
    
    # 关系
    user = db.relationship('User', foreign_keys=[user_id], backref=db.backref('ban_history', lazy='dynamic'))
    admin = db.relationship('User', foreign_keys=[admin_id])
    lifter = db.relationship('User', foreign_keys=[lifted_by])

    def __repr__(self):
        return f'<UserBan user={self.user_id} until={self.ban_until}>'

    def to_dict(self):
        return {
            'id': self.id,
            'user_id': self.user_id,
            'admin_id': self.admin_id,
            'admin_username': self.admin.username if self.admin else None,
            'banned_at': self.banned_at.isoformat() if self.banned_at else None,
            'ban_until': self.ban_until.isoformat() if self.ban_until else None,
            'reason': self.reason,
            'is_lifted': self.is_lifted,
            'lifted_at': self.lifted_at.isoformat() if self.lifted_at else None,
            'lifted_by': self.lifter.username if self.lifter else None
        }


