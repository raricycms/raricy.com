from flask_sitemap import Sitemap
from flask_sqlalchemy import SQLAlchemy
from flask_migrate import Migrate
from flask_turnstile import Turnstile

# 初始化扩展
db = SQLAlchemy()
migrate = Migrate()
sitemap = Sitemap()
turnstile = Turnstile()

def init_extensions(app):
    sitemap.init_app(app)
    db.init_app(app)
    migrate.init_app(app, db)
    turnstile.init_app(app)