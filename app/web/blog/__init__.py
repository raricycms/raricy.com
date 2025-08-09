from flask import Blueprint, render_template, current_app, abort, request, jsonify
from flask_login import login_required, current_user
from app.extensions import db, turnstile
from app.models import Blog, BlogContent
import os
import uuid
from datetime import datetime
from app.utils.process_markdown import safe_markdown_to_html

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
        