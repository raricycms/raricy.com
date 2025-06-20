from flask import Flask
from .web import register_blueprints
def create_app():
    app = Flask(__name__)

    register_blueprints(app)

    return app
