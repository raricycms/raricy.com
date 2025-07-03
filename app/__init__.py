from flask import Flask
from .web import register_blueprints
from .extensions import init_extensions
from .config import get_config

def create_app():
    app = Flask(__name__)
    app.config.from_object(get_config())
    register_blueprints(app)
    init_extensions(app)
    with app.app_context():
        from app.models import User
        from app.extensions import db
        db.create_all()
    return app
