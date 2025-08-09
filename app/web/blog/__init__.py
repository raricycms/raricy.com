from flask import Blueprint, render_template, current_app, abort, request, jsonify, url_for
from flask_login import login_required, current_user
from app.extensions import db, turnstile
from app.models import Blog, BlogContent, BlogLike
from app.extensions.decorators import admin_required
import os
import uuid
from datetime import datetime
from app.utils.process_markdown import safe_markdown_to_html
import shutil

blog_bp = Blueprint('blog', __name__)

@blog_bp.route('/')
def menu():
    """
    博客列表页

    由数据库中的 `Blog` 元信息提供列表所需字段。
    """
    blogs = []
    # 仅显示未被忽略的博客，按创建时间倒序
    for blog in Blog.query.filter_by(ignore=False).order_by(Blog.created_at.desc()).all():
        # 模板兼容：保持与历史结构一致的键名
        item = blog.to_dict()
        blogs.append(item)
    return render_template('blog/menu.html', blogs=blogs)

@blog_bp.route('/<blog_id>')
def blog_detail(blog_id):
    """
    博客详情页

    - 元信息来自数据库 `Blog`
    - 正文从数据库 `BlogContent` 读取并渲染
    """
    blog = Blog.query.get(blog_id)
    if not blog or blog.ignore:
        abort(404)

    # 从数据库读取正文
    content_obj = BlogContent.query.get(blog_id)
    content = content_obj.content if content_obj else ''

    blog_dict = blog.to_dict()
    blog_dict['content'] = safe_markdown_to_html(content)
    # 当前用户是否已点赞
    liked = False
    try:
        if current_user.is_authenticated:
            liked = BlogLike.query.filter_by(blog_id=blog_id, user_id=current_user.id).first() is not None
    except Exception:
        liked = False
    blog_dict['liked'] = liked
    return render_template('blog/blog.html', blog=blog_dict, content=content)

@blog_bp.route('/upload_blog', methods=['GET', 'POST'])
@login_required
def upload():
    """
    上传新博客

    - 将元信息写入数据库 `Blog`
    - 正文写入数据库 `BlogContent`
    """
    if request.method == 'GET':
        return render_template('blog/upload_blog.html')
    elif request.method == 'POST':
        data = request.get_json()
        if not data or not data.get('title') or not data.get('content') or not data.get('description'):
            return jsonify({'code': 400, 'message': '缺少必要参数'}), 400

        # Turnstile 人机验证（可选）
        if current_app.config['TURNSTILE_AVAILABLE'] and not turnstile.verify(data.get('cf-turnstile-response')):
            print("Turnstile verification failed. Reason:", data.get('cf-turnstile-response'))
            return jsonify({'code': 400, 'message': '人机验证失败'}), 400

        # 基本校验
        if len(data['title']) > 30:
            return jsonify({'code': 400, 'message': '标题不能超过30个字符'}), 400
        if len(data['description']) > 100:
            return jsonify({'code': 400, 'message': '描述不能超过100个字符'}), 400
        if len(data['content']) > 200000:
            return jsonify({'code': 400, 'message': '内容不能超过200000个字符'}), 400

        # 生成博客 ID，并准备目录
        blog_id = str(uuid.uuid4())
        # 若历史上仍需要创建目录以便放图片等资源，可保留目录；否则可以完全省略
        blog_path = os.path.join(current_app.instance_path, "blogs", blog_id)
        os.makedirs(blog_path, exist_ok=True)

        # 写入数据库（元信息）
        blog = Blog(
            id=blog_id,
            title=data['title'],
            description=data['description'],
            author_id=current_user.id,
            created_at=datetime.now(),
        )
        db.session.add(blog)
        # 正文保存到 BlogContent（与 Blog 同事务提交）
        content_obj = BlogContent(blog_id=blog_id, content=data['content'])
        db.session.add(content_obj)
        db.session.commit()

        return jsonify({'code': 200, 'message': '上传成功', 'blog_id': blog_id})
        

@blog_bp.route('/<blog_id>/like', methods=['POST'])
@login_required
def like_toggle(blog_id):
    """
    点赞/取消点赞切换接口。

    返回：{ code, liked, likes_count }
    """
    blog = Blog.query.get(blog_id)
    if not blog or blog.ignore:
        return jsonify({'code': 404, 'message': '未找到文章'}), 404

    like = BlogLike.query.filter_by(blog_id=blog_id, user_id=current_user.id).first()
    if like:
        # 取消点赞
        db.session.delete(like)
        blog.likes_count = max(0, (blog.likes_count or 0) - 1)
        liked = False
    else:
        # 点赞
        like = BlogLike(blog_id=blog_id, user_id=current_user.id)
        db.session.add(like)
        blog.likes_count = (blog.likes_count or 0) + 1
        liked = True

    db.session.commit()
    return jsonify({'code': 200, 'liked': liked, 'likes_count': blog.likes_count})


@blog_bp.route('/<blog_id>/likers', methods=['GET'])
@login_required
@admin_required
def likers(blog_id):
    """
    管理员查看点赞者列表。
    支持简单分页参数：?offset=0&limit=50
    """
    blog = Blog.query.get(blog_id)
    if not blog:
        return jsonify({'code': 404, 'message': '未找到文章'}), 404

    try:
        offset = int(request.args.get('offset', 0))
        limit = int(request.args.get('limit', 50))
        limit = max(1, min(limit, 200))
        offset = max(0, offset)
    except Exception:
        offset, limit = 0, 50

    q = BlogLike.query.filter_by(blog_id=blog_id).order_by(BlogLike.created_at.desc())
    total = q.count()
    likes = q.offset(offset).limit(limit).all()

    users = []
    for like in likes:
        user = like.user
        users.append({
            'id': user.id if user else like.user_id,
            'username': user.username if user else None,
            'avatar_url': url_for('auth.get_avatar', user_id=(user.id if user else like.user_id)),
            'liked_at': like.created_at.strftime('%Y-%m-%d %H:%M:%S') if like.created_at else None,
        })

    return jsonify({'code': 200, 'total': total, 'offset': offset, 'limit': limit, 'users': users})


@blog_bp.route('/<blog_id>', methods=['DELETE'])
@login_required
@admin_required
def delete_blog(blog_id):
    """
    管理员删除文章：删除 Blog、BlogContent、BlogLike，并清理 instance/blogs/<id> 目录。
    """
    blog = Blog.query.get(blog_id)
    if not blog:
        return jsonify({'code': 404, 'message': '未找到文章'}), 404

    # 删除磁盘目录（若存在）
    blog_path = os.path.join(current_app.instance_path, 'blogs', blog_id)
    try:
        shutil.rmtree(blog_path, ignore_errors=True)
    except Exception:
        # 忽略清理错误，继续逻辑删除
        pass

    db.session.delete(blog)
    db.session.commit()
    return jsonify({'code': 200, 'message': '文章已删除'})
