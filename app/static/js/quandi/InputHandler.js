class InputHandler {
    constructor(gameEngine) {
        this.gameEngine = gameEngine;
        this.pressedKeys = new Set();
        this.keyStates = new Map();
        this.init();
    }

    init() {
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));
        document.addEventListener('keyup', (e) => this.handleKeyUp(e));
        
        // 防止方向键滚动页面
        document.addEventListener('keydown', (e) => {
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) {
                e.preventDefault();
            }
        });
    }

    handleKeyDown(e) {
        if (this.keyStates.get(e.code)) return; // 防止重复触发
        
        this.keyStates.set(e.code, true);
        this.pressedKeys.add(e.code);
        
        // 游戏控制
        if (this.gameEngine.gameState === 'playing') {
            this.updatePlayerMovement();
        }
        
        // 暂停控制
        if (e.code === 'Escape') {
            if (this.gameEngine.gameState === 'playing') {
                pauseGame();
            } else if (this.gameEngine.gameState === 'paused') {
                resumeGame();
            }
        }
    }

    handleKeyUp(e) {
        this.keyStates.set(e.code, false);
        this.pressedKeys.delete(e.code);
        
        if (this.gameEngine.gameState === 'playing') {
            this.updatePlayerMovement();
        }
    }

    updatePlayerMovement() {
        this.gameEngine.players.forEach(player => {
            if (!player.isAlive) return;

            const controls = player.controls;
            let dx = 0, dy = 0;

            // 检查按键状态
            if (this.keyStates.get(controls.left)) dx = -1;
            if (this.keyStates.get(controls.right)) dx = 1;
            if (this.keyStates.get(controls.up)) dy = -1;
            if (this.keyStates.get(controls.down)) dy = 1;

            player.setDirection(dx, dy);
        });
    }
}
