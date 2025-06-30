from flask import Flask
from .web import register_blueprints
from .extensions import init_extensions
def create_app():
    app = Flask(__name__)

    register_blueprints(app)
    init_extensions(app)
    return app
