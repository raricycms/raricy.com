from flask_sitemap import Sitemap
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_turnstile import Turnstile
from flask_login import LoginManager
from flask import session
# 初始化扩展
db = SQLAlchemy()
migrate = Migrate()
sitemap = Sitemap()
turnstile = Turnstile()
login_manager = LoginManager()

def init_extensions(app):
    sitemap.init_app(app)
    db.init_app(app)
    migrate.init_app(app, db)
    turnstile.init_app(app)
    login_manager.init_app(app)
    login_manager.login_view = 'auth.login'  # type: ignore
    
    @login_manager.user_loader
    def load_user(user_id):
        from app.models import User  # 导入你的用户模型
        if not user_id:
            return None

        user = User.query.get(user_id)
        if not user:
            return None

        stored_version = session.get('session_version')
        try:
            stored_version = int(stored_version) if stored_version is not None else None
        except (TypeError, ValueError):
            stored_version = None

        if stored_version is None or stored_version != int(user.session_version or 0):
            session.pop('_user_id', None)
            session.pop('session_version', None)
            session.pop('_fresh', None)
            return None

        return user
