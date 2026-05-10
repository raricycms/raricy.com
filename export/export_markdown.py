# -*- coding: utf-8 -*-
"""
export_markdown.py

功能：将所有未删除的博客导出为 Markdown 文件（含 YAML front matter 元数据）。
     使用 yield_per 流式查询，逐篇写入文件，避免 OOM。
"""

import os
import sys
import re

current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(current_dir)
sys.path.insert(0, project_root)

import yaml
from app import create_app
from app.extensions import db
from app.models import Blog, BlogContent

app = create_app()
app.app_context().push()


def _sanitize_filename(title):
    name = re.sub(r'[<>:"/\\|?*]', '-', title)
    name = re.sub(r'\s+', '_', name)
    name = name.strip('._-')
    return name[:60] if name else 'untitled'


def export_markdown(output_dir=None):
    if output_dir is None:
        output_dir = os.path.join(project_root, 'exported_blogs')

    os.makedirs(output_dir, exist_ok=True)

    query = Blog.query.filter_by(ignore=False).order_by(Blog.created_at.desc())

    count = 0
    seen_names = set()

    for blog in query.yield_per(100):
        content_obj = db.session.get(BlogContent, blog.id)
        content = content_obj.content if content_obj else ''

        metadata = {
            'id': blog.id,
            'title': blog.title,
            'author': blog.author.username if blog.author else 'unknown',
            'date': blog.created_at.strftime('%Y-%m-%d') if blog.created_at else '',
            'updated': content_obj.updated_at.strftime('%Y-%m-%d') if (content_obj and content_obj.updated_at) else '',
            'category': blog.category.name if blog.category else '',
            'category_path': blog.category.get_full_path() if blog.category else '',
            'description': blog.description,
            'is_featured': blog.is_featured,
            'likes': blog.likes_count,
            'comments': blog.comments_count,
        }
        metadata = {k: v for k, v in metadata.items()
                    if v not in (None, '', False) or k in ('likes', 'comments', 'is_featured')}

        date_str = blog.created_at.strftime('%Y-%m-%d') if blog.created_at else 'nodate'
        base = _sanitize_filename(blog.title)
        filename = f'{date_str}-{base}.md'
        if filename in seen_names:
            filename = f'{date_str}-{base}-{blog.id[:8]}.md'
        seen_names.add(filename)

        filepath = os.path.join(output_dir, filename)

        with open(filepath, 'w', encoding='utf-8') as f:
            f.write('---\n')
            yaml.dump(metadata, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
            f.write('---\n')
            if content:
                f.write('\n')
                f.write(content)
                if not content.endswith('\n'):
                    f.write('\n')

        count += 1

    print(f'✅ 已导出 {count} 篇博客到 {output_dir}')


if __name__ == '__main__':
    export_markdown()
