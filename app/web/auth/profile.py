from flask import Blueprint, render_template, request, jsonify
from app.models import User
from app.models.blog import Blog
from app.models.comment import BlogComment
from flask_login import current_user
from flask import send_from_directory, abort, current_app
from app.extensions import db
import os

from . import auth_bp

@auth_bp.route('/profile/<user_id>')
def profile(user_id):
    user = User.query.filter_by(id=user_id).first_or_404()
    is_owner = current_user.is_authenticated and current_user.id == user.id

    # 读取查询参数
    tab = request.args.get('tab', 'blogs')
    if tab not in ('blogs', 'comments'):
        tab = 'blogs'
    blog_page = request.args.get('blog_page', 1, type=int)
    comment_page = request.args.get('comment_page', 1, type=int)

    # 统计数据（始终计算，不受隐私设置影响）
    blogs_count = Blog.query.filter_by(author_id=user.id, ignore=False).count()
    likes_received = db.session.query(
        db.func.coalesce(db.func.sum(Blog.likes_count), 0)
    ).filter(Blog.author_id == user.id, Blog.ignore == False).scalar()
    comments_count = BlogComment.query.join(
        Blog, BlogComment.blog_id == Blog.id
    ).filter(
        BlogComment.author_id == user.id,
        BlogComment.is_deleted == False,
        Blog.ignore == False
    ).count()

    # 隐私可见性：本人始终可见，他人受隐私设置控制
    show_blogs = is_owner or user.show_recent_blogs
    show_comments = is_owner or user.show_recent_comments

    # 博客分页
    blogs_pagination = None
    if show_blogs:
        blogs_pagination = Blog.query.filter_by(author_id=user.id, ignore=False) \
            .order_by(Blog.created_at.desc()) \
            .paginate(page=blog_page, per_page=20, error_out=False)

    # 评论分页
    comments_pagination = None
    comments_data = []
    if show_comments:
        comments_pagination = db.session.query(BlogComment, Blog.title.label('blog_title')) \
            .join(Blog, BlogComment.blog_id == Blog.id) \
            .filter(BlogComment.author_id == user.id, BlogComment.is_deleted == False, Blog.ignore == False) \
            .order_by(BlogComment.created_at.desc()) \
            .paginate(page=comment_page, per_page=20, error_out=False)

        for comment, blog_title in comments_pagination.items:
            comments_data.append({
                'id': comment.id,
                'blog_id': comment.blog_id,
                'blog_title': blog_title,
                'content': comment.content[:120] if comment.content else '',
                'created_at': comment.created_at,
            })

    return render_template(
        'auth/profile.html',
        user=user,
        blogs_count=blogs_count,
        likes_received=likes_received,
        comments_count=comments_count,
        tab=tab,
        blog_page=blog_page,
        comment_page=comment_page,
        show_blogs=show_blogs,
        show_comments=show_comments,
        blogs_pagination=blogs_pagination,
        comments_pagination=comments_pagination,
        comments_data=comments_data,
    )


@auth_bp.route('/username/<user_id>')
def username(user_id):
    user = User.query.filter_by(id=user_id).first_or_404()
    return jsonify(user.to_dict())


@auth_bp.route('/avatar/<user_id>')
def get_avatar(user_id):
    user = User.query.filter_by(id=user_id).first_or_404()
    avatar_dir = os.path.normpath(os.path.join(current_app.instance_path, 'avatars', f'{user.id}.png'))
    if not os.path.exists(avatar_dir):
        abort(404)
    return send_from_directory(
        directory=os.path.dirname(avatar_dir),
        path=os.path.basename(avatar_dir),
        mimetype='image/png'
    )


