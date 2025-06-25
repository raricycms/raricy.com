/**
 * 玩家管理类
 * 负责管理玩家对象和相关操作
 */
class PlayerManager {
    constructor(canvas) {
        this.canvas = canvas;
        this.keys = {};
        this.lastShot = 0;
        this.lastShot2 = 0;
        this.shotCooldown = 150;

        // 玩家1
        this.player = {
            x: 0,
            y: 0,
            width: 20,
            height: 20,
            speed: 6
        };

        // 玩家2（双人模式）
        this.player2 = {
            x: 0,
            y: 0,
            width: 20,
            height: 20,
            speed: 6
        };

        this.initializePositions();
        this.bindEvents();
    }

    /**
     * 初始化玩家位置
     */
    initializePositions() {
        this.player.x = this.canvas.width / 2 - this.player.width / 2;
        this.player.y = this.canvas.height - this.player.height - 50;

        this.player2.x = this.canvas.width / 2 - this.player2.width / 2 - 50;
        this.player2.y = this.canvas.height - this.player2.height - 50;
    }

    /**
     * 绑定键盘和触摸事件
     */
    bindEvents() {
        // 键盘事件
        document.addEventListener('keydown', (e) => {
            this.keys[e.code] = true;
            if (e.code === 'KeyX') {
                e.preventDefault();
                weaponManager.useBomb();
            }
            if (e.code === 'Escape') {
                e.preventDefault();
                gameController.togglePause();
            }
        });

        document.addEventListener('keyup', (e) => {
            this.keys[e.code] = false;
        });

        // 移动端控制
        this.bindMobileControls();
    }

    /**
     * 绑定移动端控制
     */
    bindMobileControls() {
        const mobileButtons = {
            upBtn: 'KeyW',
            downBtn: 'KeyS',
            leftBtn: 'KeyA',
            rightBtn: 'KeyD'
        };

        Object.entries(mobileButtons).forEach(([btnId, keyCode]) => {
            const btn = document.getElementById(btnId);
            btn.addEventListener('touchstart', (e) => {
                e.preventDefault();
                this.keys[keyCode] = true;
            });
            btn.addEventListener('touchend', (e) => {
                e.preventDefault();
                this.keys[keyCode] = false;
            });
            btn.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.keys[keyCode] = true;
            });
            btn.addEventListener('mouseup', (e) => {
                e.preventDefault();
                this.keys[keyCode] = false;
            });
        });

        const bombBtn = document.getElementById('bombBtn');
        bombBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            weaponManager.useBomb();
        });
        bombBtn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            weaponManager.useBomb();
        });
    }

    /**
     * 更新玩家位置
     * @param {boolean} isDualMode - 是否为双人模式
     */
    updateMovement(isDualMode) {
        // 玩家1控制（方向键）
        if (this.keys['ArrowLeft']) {
            this.player.x = Math.max(0, this.player.x - this.player.speed);
        }
        if (this.keys['ArrowRight']) {
            this.player.x = Math.min(this.canvas.width - this.player.width, this.player.x + this.player.speed);
        }
        if (this.keys['ArrowUp']) {
            this.player.y = Math.max(0, this.player.y - this.player.speed);
        }
        if (this.keys['ArrowDown']) {
            this.player.y = Math.min(this.canvas.height - this.player.height, this.player.y + this.player.speed);
        }

        // 玩家2控制（WASD键，仅在双人模式下）
        if (isDualMode) {
            if (this.keys['KeyA']) {
                this.player2.x = Math.max(0, this.player2.x - this.player2.speed);
            }
            if (this.keys['KeyD']) {
                this.player2.x = Math.min(this.canvas.width - this.player2.width, this.player2.x + this.player2.speed);
            }
            if (this.keys['KeyW']) {
                this.player2.y = Math.max(0, this.player2.y - this.player2.speed);
            }
            if (this.keys['KeyS']) {
                this.player2.y = Math.min(this.canvas.height - this.player2.height, this.player2.y + this.player2.speed);
            }
        }
    }

    /**
     * 自动射击
     * @param {boolean} isDualMode - 是否为双人模式
     * @param {boolean} isPoweredUp - 是否处于火力增强状态
     */
    autoShoot(isDualMode, isPoweredUp) {
        const now = Date.now();
        
        // 玩家1射击
        if (now - this.lastShot > this.shotCooldown) {
            this.createPlayerBullets(this.player, 1, isPoweredUp);
            this.lastShot = now;
        }

        // 玩家2射击（仅在双人模式下）
        if (isDualMode && now - this.lastShot2 > this.shotCooldown) {
            this.createPlayerBullets(this.player2, 2, isPoweredUp);
            this.lastShot2 = now;
        }
    }

    /**
     * 创建玩家子弹
     * @param {Object} player - 玩家对象
     * @param {number} playerNum - 玩家编号
     * @param {boolean} isPoweredUp - 是否火力增强
     */
    createPlayerBullets(player, playerNum, isPoweredUp) {
        if (isPoweredUp) {
            // 火力增强时的三发子弹
            weaponManager.bullets.push({
                x: player.x + player.width / 2 - 2,
                y: player.y,
                width: 4,
                height: 12,
                speed: 12,
                damage: 2,
                player: playerNum
            });
            weaponManager.bullets.push({
                x: player.x + player.width / 2 - 10,
                y: player.y + 5,
                width: 4,
                height: 12,
                speed: 12,
                damage: 2,
                player: playerNum
            });
            weaponManager.bullets.push({
                x: player.x + player.width / 2 + 6,
                y: player.y + 5,
                width: 4,
                height: 12,
                speed: 12,
                damage: 2,
                player: playerNum
            });
        } else {
            // 普通单发子弹
            weaponManager.bullets.push({
                x: player.x + player.width / 2 - 2,
                y: player.y,
                width: 4,
                height: 12,
                speed: 10,
                damage: 2,
                player: playerNum
            });
        }
    }

    /**
     * 调整玩家位置以适应双人模式
     * @param {boolean} isDualMode - 是否为双人模式
     */
    adjustForDualMode(isDualMode) {
        if (isDualMode) {
            this.player.x += 25; // 调整P1位置
            this.player2.x = this.canvas.width / 2 - this.player2.width / 2 - 50;
            this.player2.y = this.canvas.height - this.player2.height - 50;
        }
    }
}
