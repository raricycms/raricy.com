from flask import Blueprint, render_template

game_bp = Blueprint('game', __name__)

@game_bp.route('/')
def menu():
    return render_template('game/menu.html')