import pandas as pd
from app import create_app
from app.extensions import db   # 你的 Flask 工厂函数
from app.models import Blog, User, BlogContent  # 根据实际路径导入模型
import re

app = create_app()
app.app_context().push()   # 让 SQLAlchemy 能在脚本里使用

def clean_text(text):
    """清理文本中的非法字符"""
    if not text or not isinstance(text, str):
        return text

    # 方法1：移除控制字符（只保留可打印字符）
    # return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]', '', text)

    # 方法2：移除所有非ASCII字符
    # return text.encode('ascii', errors='ignore').decode('ascii')

    # 方法3：保留中文但移除控制字符
    # 移除控制字符，但保留中文字符
    cleaned = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]', '', text)

    # 替换或移除其他可能的问题字符
    cleaned = cleaned.replace('\x0b', '')  # 垂直制表符
    cleaned = cleaned.replace('\x0c', '')  # 换页符

    return cleaned

def export_blogs_to_excel(file_path='blogs.xlsx'):
    # ① 查询所有博客（包括作者、点赞数、评论数）
    # 使用 join 把作者用户名直接取出来，避免 N+1 查询
    blogs = (
        db.session.query(
            Blog.id,
            Blog.title,
            Blog.description,
            User.username.label('author'),   # 作者名称
            Blog.created_at,
            Blog.likes_count,
            Blog.comments_count,
            Blog.category_id,
            Blog.is_featured,
            Blog.ignore,
        )
        .join(User, Blog.author_id == User.id)
        .order_by(Blog.created_at.desc())
        .all()
    )

    data = []
    for blog in blogs:
        row = list(blog)
        # 清理content字段（第9个元素，0-based索引）
        if len(row) > 9 and row[9]:
            row[9] = clean_text(str(row[9]))
        data.append(row)
    
    # ② 把查询结果转成 DataFrame
    df = pd.DataFrame(data, columns=[
        'ID', '标题', '简介', '作者', '创建时间',
        '点赞数', '评论数', '栏目ID', '精选', '是否删除'
    ])

    # ③（可选）对时间列做格式化
    df['创建时间'] = df['创建时间'].dt.strftime('%Y-%m-%d %H:%M:%S')

    # ④ 导出为 Excel（使用 openpyxl 引擎）
    df.to_excel(file_path, index=False, engine='openpyxl')
    print(f'已导出 {len(df)} 条博客数据到 {file_path}')

if __name__ == '__main__':
    export_blogs_to_excel()
