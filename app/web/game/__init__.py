from flask import Blueprint, render_template

game_bp = Blueprint('game', __name__)


@game_bp.route('/')
def menu():
    return render_template('game/menu.html')


@game_bp.route('/cube')
def cube():
    return render_template('game/cube.html')


@game_bp.route('/galaxies')
def galaxies():
    return render_template('game/galaxies.html')

@game_bp.route('/wand')
def wand():
    return render_template('game/wand_demo.html')

from app.web.game.game_api import register_game_api

register_game_api(game_bp)

