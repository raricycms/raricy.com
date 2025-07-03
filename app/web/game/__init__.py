from flask import Blueprint, render_template

game_bp = Blueprint('game', __name__)

@game_bp.route('/')
def menu():
    return render_template('game/menu.html')

@game_bp.route('/xingkong')
def xingkong():
    return render_template('game/xingkong.html')

@game_bp.route('/gecao')
def gecao():
    return render_template('game/gecao.html')

@game_bp.route('/reversi')
def reversi():
    return render_template('game/reversi.html')

@game_bp.route('/quandi')
def quandi():
    return render_template('game/quandi.html')

@game_bp.route('/2048')
def _2048():
    return render_template('game/2048.html')