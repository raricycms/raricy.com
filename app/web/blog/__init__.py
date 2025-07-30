from flask import Blueprint, render_template, current_app, abort, request, jsonify
from flask_login import login_required, current_user
from app.extensions import db, turnstile
from app.models import User
import os
import json
import markdown
import uuid
import pygments
from datetime import datetime
from app.utils.process_markdown import safe_markdown_to_html

blog_bp = Blueprint('blog', __name__)

@blog_bp.route('/')
def menu():
    blogs = []
    for blog_id in os.listdir(os.path.join(current_app.instance_path, "blogs")):
        if os.path.isdir(os.path.join(current_app.instance_path, "blogs", blog_id)):
            info_path = os.path.join(current_app.instance_path, "blogs", blog_id, "info.json")
            if not os.path.isfile(info_path):
                continue
            with open(info_path, "r", encoding="utf-8") as f:
                info = json.load(f)
            if info.get("ignore", False):
                continue
            blogs.append({
                "id": blog_id,
                "author_id": info.get("author_id"),
                "title": info.get("title", "无标题"),
                "description": info.get("description", ""),
                "date": info.get("date", "未知日期"),
                "author": info.get("author", "未知作者"),
            })
    blogs.sort(key=lambda x: x["date"], reverse=True)
    return render_template('blog/menu.html', blogs=blogs)

@blog_bp.route('/<blog_id>')
def blog_detail(blog_id):
    blog_path = os.path.join(current_app.instance_path, "blogs", blog_id)
    if not os.path.isdir(blog_path):
        abort(404)
    info_path = os.path.join(blog_path, "info.json")
    with open(info_path, "r", encoding="utf-8") as f:
        info = json.load(f)
    content_path = os.path.join(blog_path, "content.md")
    with open(content_path, "r", encoding="utf-8") as f:
        content = f.read()
    info['content'] = safe_markdown_to_html(content)
    return render_template('blog/blog.html', blog=info, content=content)

@blog_bp.route('/upload_blog', methods=['GET', 'POST'])
@login_required
def upload():
    if request.method == 'GET':
        return render_template('blog/upload_blog.html')
    elif request.method == 'POST':
        data = request.get_json()
        if not data or not data.get('title') or not data.get('content') or not data.get('description'):
            return jsonify({'code': 400, 'message': '缺少必要参数'}), 400
        # 生成博客ID
        # 验证Turnstile
        if current_app.config['TURNSTILE_AVAILABLE'] and not turnstile.verify(data.get('cf-turnstile-response')):
            print("Turnstile verification failed. Reason:", data.get('cf-turnstile-response'))
            return jsonify({'code': 400, 'message': '人机验证失败'}), 400
        
        if len(data['title']) > 30:
            return jsonify({'code': 400, 'message': '标题不能超过30个字符'}), 400
        
        if len(data['description']) > 100:
            return jsonify({'code': 400, 'message': '描述不能超过100个字符'}), 400

        if len(data['content']) > 250000:
            return jsonify({'code': 400, 'message': '内容不能超过250000个字符'}), 400

        blog_id = str(uuid.uuid4())
        # 创建博客目录
        blog_path = os.path.join(current_app.instance_path, "blogs", blog_id)
        os.makedirs(blog_path, exist_ok=True)
        # 保存博客信息
        info = {
            "title": data['title'],
            "description": data['description'],
            "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "author": current_user.username,
            "author_id": current_user.id,
        }
        with open(os.path.join(blog_path, "info.json"), "w", encoding="utf-8") as f:
            json.dump(info, f, ensure_ascii=False, indent=4)
        # 保存博客内容
        with open(os.path.join(blog_path, "content.md"), "w", encoding="utf-8") as f:
            f.write(data['content'])

        return jsonify({'code': 200, 'message': '上传成功', 'blog_id': blog_id})
        