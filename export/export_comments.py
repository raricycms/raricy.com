# -*- coding: utf-8 -*-
"""
export_comments_to_excel.py

功能：把所有博客评论（包括作者、所属博客、点赞数、状态等）导出为 Excel 文件
"""
import os
import sys

# 设置项目根目录
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(current_dir)
sys.path.insert(0, project_root)

import pandas as pd
from app import create_app
from app.extensions import db
from app.models import BlogComment, User, Blog   # 根据实际项目路径导入模型

# -------------------------------------------------
# 1️⃣ 创建 Flask 应用并推入上下文
# -------------------------------------------------
app = create_app()
app.app_context().push()   # 让 SQLAlchemy 能在独立脚本里使用

# -------------------------------------------------
# 2️⃣ 导出函数
# -------------------------------------------------
def export_comments_to_excel(file_path: str = 'blog_comments.xlsx') -> None:
    """
    将所有评论导出为 Excel。
    - 包含评论基本信息、作者用户名、所属博客标题、点赞数、审核状态、是否已删除、创建/更新时间等。
    - 按创建时间倒序排列，方便在 Excel 中直接查看最新评论。
    """
    # ① 查询评论 + 作者 + 所属博客（只取标题，避免大字段）
    comments = (
        db.session.query(
            BlogComment.id.label('comment_id'),
            Blog.id.label('blog_id'),
            Blog.title.label('blog_title'),
            User.id.label('author_id'),
            User.username.label('author_name'),
            BlogComment.parent_id,
            BlogComment.root_id,
            BlogComment.content,
            BlogComment.content_html,
            BlogComment.status,
            BlogComment.is_deleted,
            BlogComment.likes_count,
            BlogComment.created_at,
            BlogComment.updated_at,
        )
        .join(User, BlogComment.author_id == User.id)          # 作者信息
        .join(Blog, BlogComment.blog_id == Blog.id)           # 所属博客信息
        .order_by(BlogComment.created_at.desc())
        .all()
    )

    # ② 转为 DataFrame（列名自行定义，中文更易读）
    df = pd.DataFrame(comments, columns=[
        '评论ID', '博客ID', '博客标题', '作者ID', '作者用户名',
        '父评论ID', '根评论ID', '原始内容', 'HTML 内容',
        '状态', '已删除', '点赞数', '创建时间', '更新时间'
    ])

    # ③ 时间格式化（可选）
    df['创建时间'] = df['创建时间'].dt.strftime('%Y-%m-%d %H:%M:%S')
    df['更新时间'] = df['更新时间'].dt.strftime('%Y-%m-%d %H:%M:%S')

    # ④ 导出 Excel
    df.to_excel(file_path, index=False, engine='openpyxl')
    print(f'✅ 已导出 {len(df)} 条评论数据到 {file_path}')

# -------------------------------------------------
# 5️⃣ 脚本入口
# -------------------------------------------------
if __name__ == '__main__':
    # 默认导出到当前目录的 blog_comments.xlsx，可自行修改路径
    export_comments_to_excel()
