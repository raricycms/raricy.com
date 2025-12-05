from flask import Blueprint, render_template, abort

game_bp = Blueprint('game', __name__)

@game_bp.route('/')
def menu():
    return abort(404)
