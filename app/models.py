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
            'authenticated': self.authenticated
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


class Blog(db.Model):
    """
    博客元信息。

    正文内容仍保存在 `instance/blogs/<id>/content.md`，
    本模型只负责管理用于列表/详情展示与排序的元数据，替代原先的 `info.json`。
    """
    __tablename__ = 'blogs'

    # 使用 UUID 字符串作为主键，保持与目录名一致，便于通过 id 直接定位 content.md
    id = db.Column(db.String(36), primary_key=True, index=True)

    # 标题与描述
    title = db.Column(db.String(100), nullable=False, index=True)
    description = db.Column(db.String(200), nullable=False, default='')

    # 作者与创建时间
    author_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=datetime.now, index=True)

    # 是否在列表中忽略显示（替代原 info.json 的 ignore 字段）
    ignore = db.Column(db.Boolean, default=False, index=True)

    # 反范式的点赞计数，便于列表页排序/展示（如后续实现点赞功能，可在事务内增减）
    likes_count = db.Column(db.Integer, default=0)

    # ORM 关系：便于通过 blog.author.username 取作者名
    author = db.relationship('User', backref=db.backref('blogs', lazy=True))

    def __init__(self, **kwargs):
        """
        默认使用 UUID 生成主键，允许显式传入 id 以覆盖（导入历史数据时会用到）。
        """
        super(Blog, self).__init__(**kwargs)
        if not getattr(self, 'id', None):
            self.id = str(uuid.uuid4())

    def __repr__(self) -> str:
        return f'<Blog {self.id} {self.title}>'

    def to_dict(self) -> dict:
        """
        便于序列化/模板渲染的字典表示。
        """
        return {
            'id': self.id,
            'title': self.title,
            'description': self.description,
            'author_id': self.author_id,
            'author': self.author.username if self.author else None,
            'date': self.created_at.strftime('%Y-%m-%d %H:%M:%S') if self.created_at else None,
            'ignore': self.ignore,
            'likes_count': self.likes_count,
        }


class BlogLike(db.Model):
    """
    博客点赞记录。

    用唯一约束保证同一用户对同一篇博客只能点赞一次，
    真正的计数可以通过聚合或维护到 Blog.likes_count。
    """
    __tablename__ = 'blog_likes'

    id = db.Column(db.Integer, primary_key=True)
    blog_id = db.Column(db.String(36), db.ForeignKey('blogs.id'), nullable=False, index=True)
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=datetime.now)

    __table_args__ = (
        db.UniqueConstraint('blog_id', 'user_id', name='uq_blog_like_blog_user'),
    )

    blog = db.relationship('Blog', backref=db.backref('likes', lazy=True, cascade='all, delete-orphan'))
    user = db.relationship('User', backref=db.backref('blog_likes', lazy=True, cascade='all, delete-orphan'))

    def __repr__(self) -> str:
        return f'<BlogLike blog={self.blog_id} user={self.user_id}>'


class BlogContent(db.Model):
    """
    博客正文内容。

    将大字段与 `Blog` 元信息分表存储，避免列表查询被大字段影响性能，
    同时保证正文与元信息可以在数据库事务中原子更新。
    """
    __tablename__ = 'blog_contents'

    # 与 Blog 一对一：使用相同的主键（blog_id）
    blog_id = db.Column(db.String(36), db.ForeignKey('blogs.id'), primary_key=True)

    # 正文内容，20 万字符体量在 SQLite/PostgreSQL 完全没问题。
    # 如后续使用 MySQL 并维持此上限，建议改为 MEDIUMTEXT。
    content = db.Column(db.Text, nullable=False)

    updated_at = db.Column(db.DateTime, default=datetime.now, onupdate=datetime.now)

    blog = db.relationship(
        'Blog',
        backref=db.backref('content_obj', uselist=False, cascade='all, delete-orphan')
    )

    def __repr__(self) -> str:
        return f'<BlogContent blog={self.blog_id} len={len(self.content) if self.content else 0}>'