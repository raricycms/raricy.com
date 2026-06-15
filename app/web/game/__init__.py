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


@game_bp.route('/2048')
def game_2048():
    return render_template('game/2048.html')


@game_bp.route('/connect4')
def connect4():
    return render_template('game/connect4.html')


@game_bp.route('/utictactoe')
def utictactoe():
    return render_template('game/utictactoe.html')


@game_bp.route('/speed')
def speed():
    return render_template('game/speed.html')


@game_bp.route('/cubetictactoe')
def cubetictactoe():
    return render_template('game/cubetictactoe.html')


@game_bp.route('/gomoku')
def gomoku():
    return render_template('game/gomoku.html')

from app.web.game.game_api import register_game_api

register_game_api(game_bp)

