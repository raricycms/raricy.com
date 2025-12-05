from app.extensions import db
from datetime import datetime
import uuid


class BlogComment(db.Model):
    """
    文章评论表。

    采用 parent_id / root_id 实现楼中楼：
    - parent_id 指向直接父评论（回复谁）
    - root_id 指向该评论串的顶层评论（便于分页加载整串）
    """
    __tablename__ = 'blog_comments'

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))

    blog_id = db.Column(db.String(36), db.ForeignKey('blogs.id'), nullable=False, index=True)
    author_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)

    parent_id = db.Column(db.String(36), db.ForeignKey('blog_comments.id'), nullable=True, index=True)
    root_id = db.Column(db.String(36), db.ForeignKey('blog_comments.id'), nullable=True, index=True)

    content = db.Column(db.Text, nullable=False)
    content_html = db.Column(db.Text, nullable=True)

    # 审核/可见性状态：pending/approved/hidden
    status = db.Column(db.String(20), default='approved', index=True)
    is_deleted = db.Column(db.Boolean, default=False, index=True)

    # 点赞冗余计数
    likes_count = db.Column(db.Integer, default=0)

    created_at = db.Column(db.DateTime, default=datetime.now, index=True)
    updated_at = db.Column(db.DateTime, default=datetime.now, onupdate=datetime.now)

    # 关系
    blog = db.relationship('Blog', backref=db.backref('comments', lazy='dynamic', cascade='all, delete-orphan'))
    author = db.relationship('User', backref=db.backref('comments', lazy='dynamic', cascade='all, delete-orphan'))

    # 自关联需要显式声明外键列与连接条件，避免歧义
    parent = db.relationship(
        'BlogComment',
        remote_side=[id],
        primaryjoin='BlogComment.parent_id == BlogComment.id',
        foreign_keys=[parent_id],
        backref=db.backref(
            'children',
            lazy='dynamic',
            primaryjoin='BlogComment.parent_id == BlogComment.id',
            foreign_keys='BlogComment.parent_id',
        ),
    )
    root = db.relationship(
        'BlogComment',
        remote_side=[id],
        primaryjoin='BlogComment.root_id == BlogComment.id',
        foreign_keys=[root_id],
        uselist=False,
    )

    def __repr__(self) -> str:
        return f'<BlogComment {self.id} blog={self.blog_id} author={self.author_id}>'

    def to_dict(self) -> dict:
        return {
            'id': self.id,
            'blog_id': self.blog_id,
            'author_id': self.author_id,
            'parent_id': self.parent_id,
            'root_id': self.root_id,
            'content': self.content,
            'content_html': self.content_html,
            'status': self.status,
            'is_deleted': self.is_deleted,
            'likes_count': self.likes_count,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
        }


class CommentLike(db.Model):
    """评论点赞记录，保证同一用户对同一评论只能点赞一次。"""
    __tablename__ = 'comment_likes'

    id = db.Column(db.Integer, primary_key=True)
    comment_id = db.Column(db.String(36), db.ForeignKey('blog_comments.id'), nullable=False, index=True)
    user_id = db.Column(db.String(36), db.ForeignKey('users.id'), nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=datetime.now)

    __table_args__ = (
        db.UniqueConstraint('comment_id', 'user_id', name='uq_comment_like_comment_user'),
    )

    comment = db.relationship('BlogComment', backref=db.backref('likes', lazy='dynamic', cascade='all, delete-orphan'))
    user = db.relationship('User', backref=db.backref('comment_likes', lazy='dynamic', cascade='all, delete-orphan'))

    def __repr__(self) -> str:
        return f'<CommentLike comment={self.comment_id} user={self.user_id}>'


