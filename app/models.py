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
    authenticated = db.Column(db.Boolean, default=False) # 是否为核心用户
    is_admin = db.Column(db.Boolean, default=False)
    avatar_path = db.Column(db.String(255))
    
    # 通知设置
    notify_like = db.Column(db.Boolean, default=True)  # 文章被点赞通知
    notify_edit = db.Column(db.Boolean, default=True)  # 文章被编辑通知  
    notify_delete = db.Column(db.Boolean, default=True)  # 文章被删除通知
    notify_admin = db.Column(db.Boolean, default=True)  # 管理员通知
    
    # 禁言相关
    is_banned = db.Column(db.Boolean, default=False)  # 是否被禁言
    ban_until = db.Column(db.DateTime, nullable=True)  # 禁言结束时间
    ban_reason = db.Column(db.String(255), nullable=True)  # 禁言原因
    
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
        from app.models import UserBan  # 避免循环导入
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
        from app.models import UserBan  # 避免循环导入
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

    # 所属栏目（可为空，表示未分类）
    category_id = db.Column(db.Integer, db.ForeignKey('categories.id'), nullable=True, index=True)

    # 是否为精选文章
    is_featured = db.Column(db.Boolean, default=False, index=True)

    # ORM 关系：便于通过 blog.author.username 取作者名
    author = db.relationship('User', backref=db.backref('blogs', lazy=True))
    
    # 栏目关系：便于通过 blog.category.name 取栏目名
    category = db.relationship('Category', backref=db.backref('blogs', lazy=True))

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
            'date': self.created_at.strftime('%Y-%m-%d') if self.created_at else None,
            'ignore': self.ignore,
            'likes_count': self.likes_count,
            'category_id': self.category_id,
            'category': self.category.name if self.category else None,
            'category_path': self.category.get_full_path() if self.category else None,
            'is_featured': self.is_featured,
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
    notification_sent = db.Column(db.Boolean, default=False, nullable=False)  # 是否已发送点赞通知

    __table_args__ = (
        db.UniqueConstraint('blog_id', 'user_id', name='uq_blog_like_blog_user'),
    )

    blog = db.relationship('Blog', backref=db.backref('likes', lazy=True, cascade='all, delete-orphan'))
    user = db.relationship('User', backref=db.backref('blog_likes', lazy=True, cascade='all, delete-orphan'))

    def __repr__(self) -> str:
        return f'<BlogLike blog={self.blog_id} user={self.user_id}>'


class Category(db.Model):
    """
    栏目/分类模型，支持层级结构。
    
    设计支持二级分类：
    - 一级分类：学术版、灌水区、生活版、站务版
    - 二级分类：心理学&哲学&社科、数学&自然科学等
    """
    __tablename__ = 'categories'

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(50), nullable=False, index=True)
    slug = db.Column(db.String(50), nullable=False, unique=True, index=True)  # URL友好的标识符
    description = db.Column(db.String(200), default='')
    
    # 层级关系：parent_id 为 NULL 表示一级分类
    parent_id = db.Column(db.Integer, db.ForeignKey('categories.id'), nullable=True, index=True)
    
    # 排序权重，用于控制显示顺序
    sort_order = db.Column(db.Integer, default=0, index=True)
    
    # 是否启用该分类
    is_active = db.Column(db.Boolean, default=True, index=True)
    
    # 分类图标（可选，用于前端显示）
    icon = db.Column(db.String(50), default='')

    # 是否从“全部文章”中排除该分类（及其子分类）
    exclude_from_all = db.Column(db.Boolean, default=False, index=True)
    
    # 仅管理员可发文
    admin_only_posting = db.Column(db.Boolean, default=False, index=True)
    
    # 当有用户在该栏目发文时，通知管理员
    notify_admin_on_post = db.Column(db.Boolean, default=False, index=True)
    
    created_at = db.Column(db.DateTime, default=datetime.now)

    # 自关联关系：父分类与子分类
    children = db.relationship(
        'Category',
        backref=db.backref('parent', remote_side=[id]),
        lazy='dynamic'
    )

    def __repr__(self) -> str:
        return f'<Category {self.name}>'

    def to_dict(self, include_children=False) -> dict:
        """转换为字典格式，便于序列化"""
        result = {
            'id': self.id,
            'name': self.name,
            'slug': self.slug,
            'description': self.description,
            'parent_id': self.parent_id,
            'sort_order': self.sort_order,
            'is_active': self.is_active,
            'icon': self.icon,
            'exclude_from_all': self.exclude_from_all,
            'admin_only_posting': self.admin_only_posting,
            'notify_admin_on_post': self.notify_admin_on_post,
            'level': 1 if self.parent_id is None else 2
        }
        
        if include_children and self.parent_id is None:
            # 只有一级分类才包含子分类
            result['children'] = [
                child.to_dict() for child in 
                self.children.filter_by(is_active=True).order_by(Category.sort_order).all()
            ]
        
        return result

    def get_full_path(self) -> str:
        """获取完整路径，如：学术版 > 计算机&工程与工业"""
        if self.parent_id is None:
            return self.name
        else:
            return f"{self.parent.name} > {self.name}"

    @classmethod
    def get_hierarchy(cls):
        """获取完整的分类层级结构"""
        root_categories = cls.query.filter_by(parent_id=None, is_active=True).order_by(cls.sort_order).all()
        return [cat.to_dict(include_children=True) for cat in root_categories]


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

    def __repr__(self) -> str:
        return f'<UserBan user={self.user_id} until={self.ban_until}>'

    def to_dict(self) -> dict:
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


class Notification(db.Model):
    __tablename__ = 'notifications'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    timestamp = db.Column(db.DateTime, default=datetime.now, index=True)
    
    # 通知种类
    action = db.Column(db.String(50), nullable=False)
    
    # 消息接收者
    recipient_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False)
    recipient = db.relationship('User', foreign_keys=[recipient_id], backref=db.backref('notifications', lazy='dynamic', cascade='all, delete-orphan'))

    # 动作的发起者 (null代表系统通知)
    actor_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=True)
    actor = db.relationship('User', foreign_keys=[actor_id], backref=db.backref('sent_notifications', lazy='dynamic'))


    # 动作的关联对象（比如一篇博客文章）
    object_type = db.Column(db.String(50), nullable=True)
    object_id = db.Column(db.String(36), nullable=True)
    
    # 通知的详细信息
    detail = db.Column(db.Text, nullable=True)

    # 是否已读
    read = db.Column(db.Boolean, default=False, nullable=False)

    def __repr__(self):
        return f'<Notification {self.id} for user={self.recipient_id}, action={self.action}>'
    
    def to_dict(self):
        # 这个 to_dict 方法可以利用 relationship 变得更强大
        actor_info = {'id': None, 'username': 'system'}
        if self.actor: # 如果 actor 关系存在
            actor_info = {'id': self.actor.id, 'username': self.actor.username}

        return {
            'id': self.id,
            'timestamp': self.timestamp.isoformat(),
            'action': self.action,
            'recipient_id': self.recipient_id,
            'actor': actor_info, # 返回一个包含 actor 信息的对象
            'object': {
                'type': self.object_type,
                'id': self.object_id
            },
            'detail': self.detail,
            'read': self.read
        }

    def get_object(self):
        if self.object_type and self.object_id:
            if self.object_type == 'blog':
                return Blog.query.get(self.object_id)
            