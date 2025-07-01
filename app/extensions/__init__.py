from flask_sitemap import Sitemap
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_turnstile import Turnstile
from flask_login import LoginManager
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
    login_manager.login_view = 'sign_in.login'  # type: ignore
    
    @login_manager.user_loader
    def load_user(user_id):
        from app.models import User  # 导入你的用户模型
        return User.query.get(int(user_id)) if user_id else None