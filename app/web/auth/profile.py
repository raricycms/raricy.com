from flask import Blueprint, render_template, request, jsonify, session, url_for
from app.models import User
from app.models.blog import Blog
from app.models.comment import BlogComment
from flask_login import logout_user, login_required, current_user
from flask import send_from_directory, abort, current_app
from app.extensions import db
import os

from . import auth_bp

@auth_bp.route('/profile/<user_id>')
def profile(user_id):
    user = User.query.filter_by(id=user_id).first_or_404()

    # 统计数据
    blogs_count = Blog.query.filter_by(author_id=user.id, ignore=False).count()
    likes_received = db.session.query(
        db.func.coalesce(db.func.sum(Blog.likes_count), 0)
    ).filter(Blog.author_id == user.id, Blog.ignore == False).scalar()
    comments_count = BlogComment.query.filter_by(
        author_id=user.id, is_deleted=False
    ).count()

    # 最近博客
    recent_blogs = Blog.query.filter_by(author_id=user.id, ignore=False) \
        .order_by(Blog.created_at.desc()).limit(5).all()

    # 最近评论
    recent_comments = db.session.query(BlogComment, Blog.title.label('blog_title')) \
        .join(Blog, BlogComment.blog_id == Blog.id) \
        .filter(BlogComment.author_id == user.id, BlogComment.is_deleted == False) \
        .order_by(BlogComment.created_at.desc()).limit(5).all()

    # 构建评论列表（带博客标题）
    comments_data = []
    for comment, blog_title in recent_comments:
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
        recent_blogs=recent_blogs,
        recent_comments=comments_data,
    )

@auth_bp.route('/profile/<user_id>/edit', methods=['POST'])
@login_required
def edit_profile(user_id):
    """编辑个人资料（仅可编辑自己的资料）"""
    if current_user.id != user_id:
        return jsonify({'code': 403, 'message': '无权编辑他人资料'}), 403

    data = request.get_json() or {}
    bio = (data.get('bio') or '').strip()

    if len(bio) > 500:
        return jsonify({'code': 400, 'message': '个人简介不能超过 500 字'}), 400

    current_user.bio = bio if bio else None
    db.session.commit()

    return jsonify({
        'code': 200,
        'message': '资料已保存',
        'bio': bio,
    })

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



@auth_bp.route('/change_password', methods=['POST'])
@login_required
def change_password():
    data = request.get_json() or {}

    current_password = (data.get('current_password') or '').strip()
    new_password = (data.get('new_password') or '').strip()
    confirm_password = (data.get('confirm_password') or '').strip()

    if not current_password or not new_password or not confirm_password:
        return jsonify({'code': 400, 'message': '请填写完整的信息'}), 400

    if not current_user.check_password(current_password):
        return jsonify({'code': 400, 'message': '原密码不正确'}), 400

    if new_password != confirm_password:
        return jsonify({'code': 400, 'message': '两次输入的新密码不一致'}), 400

    if len(new_password) < 8:
        return jsonify({'code': 400, 'message': '新密码长度至少为 8 位'}), 400

    if current_password == new_password:
        return jsonify({'code': 400, 'message': '新密码不能与原密码相同'}), 400

    current_user.set_password(new_password)
    current_user.session_version = int(current_user.session_version or 0) + 1
    db.session.commit()

    logout_user()
    session.pop('session_version', None)

    return jsonify({
        'code': 200,
        'message': '密码修改成功，请使用新密码重新登录。',
        'redirect_url': url_for('auth.login')
    }), 200
