import pandas as pd
from app import create_app
from app.extensions import db   # 你的 Flask 工厂函数
from app.models import Blog, User   # 根据实际路径导入模型

app = create_app()
app.app_context().push()   # 让 SQLAlchemy 能在脚本里使用

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
        )
        .join(User, Blog.author_id == User.id)
        .order_by(Blog.created_at.desc())
        .all()
    )

    # ② 把查询结果转成 DataFrame
    df = pd.DataFrame(blogs, columns=[
        'ID', '标题', '简介', '作者', '创建时间',
        '点赞数', '评论数', '栏目ID', '精选'
    ])

    # ③（可选）对时间列做格式化
    df['创建时间'] = df['创建时间'].dt.strftime('%Y-%m-%d %H:%M:%S')

    # ④ 导出为 Excel（使用 openpyxl 引擎）
    df.to_excel(file_path, index=False, engine='openpyxl')
    print(f'已导出 {len(df)} 条博客数据到 {file_path}')

if __name__ == '__main__':
    export_blogs_to_excel()
