from flask import Blueprint, render_template, current_app, abort
import os
import markdown
import json
import frontmatter

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
    return render_template('story/menu.html', batches=batches)

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
    batch_dir = os.path.join(current_app.instance_path, "stories", f"{batch_id}")
    for story_id in os.listdir(batch_dir):
        if not story_id.endswith(".md"):
            continue
        story_id = story_id[:-3]
        md_path = os.path.join(batch_dir, f"{story_id}.md")
        if os.path.isfile(md_path):
            post = frontmatter.load(md_path)
            meta = post.metadata
            if meta.get("ignore", False):
                continue
            stories.append({
                "id": story_id,
                "title": meta.get("title", story_id),
                "description": meta.get("description", ""),
                "chapter_count": meta.get("chapter_count", 1),
                "genre": meta.get("genre", "小说"),
                "status": meta.get("status", "完结"),
                "author": meta.get("author", "未知作者"),
                "priority": meta.get("priority", 0)
            })
    
    # 按照 priority 从大到小排序，如果没有 priority 字段则默认为 0
    stories.sort(key=lambda x: x.get("priority", 0), reverse=True)
    
    return render_template('story/batch.html', batch_id=batch_id, batch_title=batch_title, batch_description=batch_description, stories=stories)

@story_bp.route("/<batch_id>/<story_id>")
def story_detail(batch_id, story_id):
    # 拼出 Markdown 路径
    md_path = os.path.join(current_app.instance_path, "stories", f"{batch_id}", f"{story_id}.md")
    # 判断文件是否存在
    if not os.path.isfile(md_path):
        abort(404)

    # 读取 Markdown 内容和 front matter
    post = frontmatter.load(md_path)
    md_content = post.content
    metadata = post.metadata

    # 从 metadata 里获取信息
    story_title = metadata.get("title", story_id)
    story_author = metadata.get("author", "未知作者")
    story_genre = metadata.get("genre", "未知类型")
    story_status = metadata.get("status", "未知状态")

    # 转换为 HTML
    html_content = markdown.markdown(md_content, extensions=["extra", "codehilite", "tables", "toc"])

    # 渲染模板
    return render_template(
        "story/story_base.html",
        story_title=story_title,
        story_author=story_author,
        story_genre=story_genre,
        story_status=story_status,
        batch_id=batch_id,
        story_content=html_content
    )

