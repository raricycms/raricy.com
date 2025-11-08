from app.extensions import db
from datetime import datetime
import uuid


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
    # 评论计数与最近评论时间（便于排序与展示）
    comments_count = db.Column(db.Integer, default=0)
    last_comment_at = db.Column(db.DateTime, nullable=True, index=True)

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
            'comments_count': self.comments_count,
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


class BlogContent(db.Model):
    """
    博客正文内容。

    将大字段与 `Blog` 元信息分表存储，避免列表查询被大字段影响性能，
    同时保证正文与元信息可以在数据库事务中原子更新。
    """
    __tablename__ = 'blog_contents'

    # 与 Blog 一对一：使用相同的主键（blog_id）
    blog_id = db.Column(db.String(36), db.ForeignKey('blogs.id'), primary_key=True)

    # 正文内容
    content = db.Column(db.Text, nullable=False)

    updated_at = db.Column(db.DateTime, default=datetime.now, onupdate=datetime.now)

    blog = db.relationship(
        'Blog',
        backref=db.backref('content_obj', uselist=False, cascade='all, delete-orphan')
    )

    def __repr__(self) -> str:
        return f'<BlogContent blog={self.blog_id} len={len(self.content) if self.content else 0}>'


