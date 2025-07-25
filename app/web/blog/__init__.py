from flask import Blueprint, render_template, current_app, abort
import os
import json
import markdown
import pygments

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
    info['content'] = markdown.markdown(content, extensions=[
        "extra", 
        "codehilite", 
        "tables", 
        "toc"
    ], extension_configs={
        'codehilite': {
            'css_class': 'highlight',
            'use_pygments': True,
            'noclasses': False,
            'linenums': False
        }
    })
    return render_template('blog/blog.html', blog=info, content=content)