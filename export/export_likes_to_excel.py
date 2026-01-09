import os
import sys

# 设置项目根目录
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(current_dir)
sys.path.insert(0, project_root)

import pandas as pd
from app import create_app
from app.extensions import db
from app.models import Blog, User, BlogLike
from sqlalchemy.orm import aliased

app = create_app()
app.app_context().push()

def export_likes_to_excel(file_path='likes.xlsx'):
    User_author = aliased(User)
    likes = (
            db.session.query(
                BlogLike.blog_id,
                BlogLike.user_id,
                BlogLike.deleted,
                User.username.label('点赞用户名'),
                Blog.title,
                User_author.username.label('作者用户名'),
            )
            .join(User, User.id == BlogLike.user_id )
            .join(Blog, Blog.id == BlogLike.blog_id)
            .join(User_author, User_author.id == Blog.author_id)
            .all()
    )
    data = []
    for like in likes:
        row = list(like)
        # 清理文本字段
        data.append(row)

    # 转换为DataFrame
    df = pd.DataFrame(data, columns=[
        '博客ID', '用户ID', '是否删除', '用户名', '博客标题', '博客作者用户名'
    ])

    # 导出为Excel
    df.to_excel(file_path, index=False, engine='openpyxl')
    print(f'已导出 {len(df)} 条点赞数据到 {file_path}')

def clean_text(text):
    """清理文本中的非法字符"""
    if not text or not isinstance(text, str):
        return text

    # 移除控制字符
    cleaned = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]', '', text)
    cleaned = cleaned.replace('\x0b', '').replace('\x0c', '')

    return cleaned

if __name__ == '__main__':
    export_likes_to_excel()
