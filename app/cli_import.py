import os
import json
import click
from flask import current_app
from datetime import datetime
from app.extensions import db
from app.models import User, Blog, BlogContent


def register_import_commands(app):
    """
    注册与数据导入相关的 CLI 命令。
    使用方式：
      - flask import-blogs [--overwrite]
    """

    @app.cli.command('import-blogs')
    @click.option('--overwrite', is_flag=True, help='如数据库已存在同 id 的博客，是否覆盖元信息（不会改正文文件）')
    def import_blogs(overwrite: bool):
        """
        一次性导入历史 `instance/blogs/<id>/info.json` 到数据库 `Blog`。

        - 仅迁移元信息：title/description/author_id/created_at/ignore
        - 正文内容仍保留在 content.md，无需移动
        """
        instance_path = current_app.instance_path
        blogs_root = os.path.join(instance_path, 'blogs')
        if not os.path.isdir(blogs_root):
            click.echo('\x1b[33m提示：未找到 instance/blogs 目录，无需导入\x1b[0m')
            return

        migrated = 0
        skipped = 0
        for blog_id in os.listdir(blogs_root):
            blog_dir = os.path.join(blogs_root, blog_id)
            if not os.path.isdir(blog_dir):
                continue
            info_path = os.path.join(blog_dir, 'info.json')
            if not os.path.isfile(info_path):
                continue
            try:
                with open(info_path, 'r', encoding='utf-8') as f:
                    info = json.load(f)
            except Exception as e:
                click.echo(f'\x1b[31m跳过：读取 {info_path} 失败：{e}\x1b[0m')
                continue

            existing = Blog.query.get(blog_id)
            if existing and not overwrite:
                skipped += 1
                continue

            # 解析 info.json
            title = info.get('title') or '无标题'
            description = info.get('description') or ''
            author_id = info.get('author_id')
            ignore = bool(info.get('ignore', False))
            date_str = info.get('date')
            try:
                created_at = datetime.strptime(date_str, '%Y-%m-%d %H:%M:%S') if date_str else datetime.now()
            except Exception:
                created_at = datetime.now()

            if existing:
                existing.title = title
                existing.description = description
                existing.author_id = author_id or existing.author_id
                existing.ignore = ignore
                existing.created_at = created_at
            else:
                # 若无 author_id，则尝试使用任意一个用户作为占位作者，避免外键校验失败
                fallback_user = User.query.first()
                blog = Blog(
                    id=blog_id,
                    title=title,
                    description=description,
                    author_id=author_id or (fallback_user.id if fallback_user else None),
                    created_at=created_at,
                    ignore=ignore,
                )
                if not blog.author_id:
                    click.echo(f'\x1b[33m警告：{blog_id} 缺少 author_id，使用占位作者；请后续修复\x1b[0m')
                db.session.add(blog)

            migrated += 1

            # 读取并导入正文 content.md 至 BlogContent
            content_path = os.path.join(blog_dir, 'content.md')
            if os.path.isfile(content_path):
                try:
                    with open(content_path, 'r', encoding='utf-8') as cf:
                        content_text = cf.read()
                except Exception as e:
                    click.echo(f'\x1b[31m警告：读取 {content_path} 失败：{e}\x1b[0m')
                    content_text = ''
                content_obj = BlogContent.query.get(blog_id)
                if content_obj:
                    content_obj.content = content_text
                else:
                    db.session.add(BlogContent(blog_id=blog_id, content=content_text))

        db.session.commit()
        click.echo(f'\x1b[32m完成：导入 {migrated} 项，跳过 {skipped} 项\x1b[0m')


