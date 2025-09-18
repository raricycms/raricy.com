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

@game_bp.route('/Tetris')
def Tetris():
    return render_template('game/Tetris.html')

@game_bp.route('/nengliangqiudazhan')
def nengliangqiudazhan():
    return render_template('game/能量球大战.html')

@game_bp.route('/yinyou')
def yinyou():
    return render_template('game/音游.html')

@game_bp.route('/chaojijingziqi')
def chaojijingziqi():
    return render_template('game/超级井字棋.html')

@game_bp.route('/siziqi')
def siziqi():
    return render_template('game/四子棋.html')

@game_bp.route('/lifangqi')
def lifangqi():
    return render_template('game/立方棋.html')

@game_bp.route('/sudujielong')
def sudujielong():
    return render_template('game/速度接龙.html')

@game_bp.route('/tanchishe')
def tanchishe():
    return render_template('game/贪吃蛇.html')

@game_bp.route('/zhongguoxiangqi')
def zhongguoxiangqi():
    return render_template('game/中国象棋.html')

@game_bp.route('/guojitiaqi')
def guojitiaqi():
    return render_template('game/国际跳棋.html')

@game_bp.route('/guojixiangqi')
def guojixiangqi():
    return render_template('game/国际象棋.html')

@game_bp.route('/weiqi')
def weiqi():
    return render_template('game/围棋.html')

@game_bp.route('/gomoku')
def gomoku():
    return render_template('game/gomoku.html')

@game_bp.route('/blackjack_21')
def blackjack_21():
    return render_template('game/blackjack_21_点.html')

@game_bp.route('/xiufushiguangji')
def xiufushiguangji():
    from flask import redirect
    return redirect('http://116.62.179.232:8765')

@game_bp.route('/renshengchongkai')
def renshengchongkai():
    from flask import redirect
    return redirect('http://116.62.179.232:5411')