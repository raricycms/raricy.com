import os
import sys

# 设置项目根目录
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(current_dir)
sys.path.insert(0, project_root)

import pandas as pd
from app.extensions import db
from app.models import User  # 根据实际路径导入
from app import create_app

app = create_app()
app.app_context().push()
# 查询所有用户名
users = User.query.with_entities(User.username).all()

# 转换为列表
usernames = [user.username for user in users]

# 创建 DataFrame
df = pd.DataFrame(usernames, columns=['用户名'])

# 导出到 Excel
df.to_excel('用户列表.xlsx', index=False)
