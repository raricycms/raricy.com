from flask import current_app
from . import db

def init_models(app):
    """集中初始化数据库模型"""
    with app.app_context():
        # 延迟导入解决循环依赖
        from ..models import User, InviteCode  
        db.create_all()