"""
博客模块蓝图
"""
from flask import Blueprint

# 创建蓝图
blog_bp = Blueprint('blog', __name__)

# 注册各个视图模块
from . import views, admin_views, api_views

# 注册路由
views.register_views(blog_bp)
admin_views.register_admin_views(blog_bp)
api_views.register_api_views(blog_bp)
