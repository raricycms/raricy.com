from flask import Blueprint

message_board_bp = Blueprint('message_board', __name__)

from . import views, api_views

views.register_views(message_board_bp)
api_views.register_api_views(message_board_bp)
