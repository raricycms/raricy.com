from flask import Blueprint, render_template, current_app, abort
import os
import markdown
import json
story_bp = Blueprint('story', __name__)

@story_bp.route('/')
def menu():
    batches = []
    for batch_id in os.listdir(os.path.join(current_app.instance_path, "stories")):
        if os.path.isdir(os.path.join(current_app.instance_path, "stories", batch_id)):
            info_path = os.path.join(current_app.instance_path, "stories", batch_id, "info.json")
            if not os.path.isfile(info_path):
                continue
            with open(info_path, "r", encoding="utf-8") as f:
                info = json.load(f)
            if info.get("ignore", False):
                continue
            batches.append({
                "id": batch_id,
                "name": info["name"],
                "description": info["description"],
                "story_count": len(os.listdir(os.path.join(current_app.instance_path, "stories", batch_id))) -1,
                "priority": info.get("priority", 0)
            })
    batches.sort(key=lambda x: x.get("priority", 0), reverse=True)
    return render_template('story/new_menu.html', batches=batches)

@story_bp.route('/<batch_id>')
def batch_detail(batch_id):
    info_path = os.path.join(current_app.instance_path, "stories", f"{batch_id}", "info.json")
    if not os.path.isfile(info_path):
        abort(404)
    with open(info_path, "r", encoding="utf-8") as f:
        info = json.load(f)
    batch_title = info["title"]
    batch_description = info["description"]
    stories = []
    for story_id in os.listdir(os.path.join(current_app.instance_path, "stories", f"{batch_id}")):
        if os.path.isdir(os.path.join(current_app.instance_path, "stories", f"{batch_id}", story_id)):
            info_path = os.path.join(current_app.instance_path, "stories", f"{batch_id}", story_id, "info.json")
            with open(info_path, "r", encoding="utf-8") as f:
                info = json.load(f)
            if info.get("ignore", False):
                continue
            stories.append(info)
    
    # 按照 priority 从大到小排序，如果没有 priority 字段则默认为 0
    stories.sort(key=lambda x: x.get("priority", 0), reverse=True)
    
    return render_template('story/batch.html', batch_id=batch_id, batch_title=batch_title, batch_description=batch_description, stories=stories)

@story_bp.route("/read/<batch_id>/<story_id>")
def story_detail(batch_id,story_id):
    # 拼出 Markdown 路径
    md_path = os.path.join(current_app.instance_path, "stories", f"{batch_id}", f"{story_id}", "story.md")
    info_path = os.path.join(current_app.instance_path, "stories", f"{batch_id}", f"{story_id}", "info.json")
    # 判断文件是否存在
    if not os.path.isfile(md_path):
        abort(404)
    if not os.path.isfile(info_path):
        abort(404)
    with open(info_path, "r", encoding="utf-8") as f:
        info = json.load(f)
    story_title = info["title"]
    story_author = info["author"]
    story_genre = info["genre"]
    story_status = info["status"]

    # 读取 Markdown 内容
    with open(md_path, "r", encoding="utf-8") as f:
        md_content = f.read()

    # 转换为 HTML
    html_content = markdown.markdown(md_content, extensions=["extra", "codehilite", "tables", "toc"])

    # 渲染模板
    return render_template("story/story_base.html", story_title=story_title, story_author=story_author, story_genre=story_genre, story_status=story_status, batch_id=batch_id, story_content=html_content)

