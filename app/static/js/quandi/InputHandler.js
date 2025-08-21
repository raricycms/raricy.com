class InputHandler {
    constructor(gameEngine) {
        this.gameEngine = gameEngine;
        this.pressedKeys = new Set();
        this.keyStates = new Map();
        
        // 触控相关属性
        this.touchControls = new Map(); // 存储每个玩家的触控状态
        this.touchStartPos = new Map(); // 记录触摸开始位置
        this.virtualJoysticks = new Map(); // 虚拟摇杆
        this.touchSensitivity = 50; // 触摸灵敏度
        
        this.init();
        this.createVirtualControls();
    }

    init() {
        // 键盘事件
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));
        document.addEventListener('keyup', (e) => this.handleKeyUp(e));
        
        // 防止方向键滚动页面
        document.addEventListener('keydown', (e) => {
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) {
                e.preventDefault();
            }
        });

        // 触控事件
        document.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
        document.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
        document.addEventListener('touchend', (e) => this.handleTouchEnd(e), { passive: false });
        document.addEventListener('touchcancel', (e) => this.handleTouchEnd(e), { passive: false });

        // 防止触摸时的默认行为
        document.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
        document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    }

    createVirtualControls() {
        // 检测是否为移动设备
        if (!this.isMobileDevice()) return;

        // 创建虚拟控制界面
        this.createVirtualJoystick();
        this.createActionButtons();
    }

    isMobileDevice() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
               ('ontouchstart' in window) ||
               (navigator.maxTouchPoints > 0);
    }

    createVirtualJoystick() {
        // 创建左侧虚拟摇杆容器
        const joystickContainer = document.createElement('div');
        joystickContainer.id = 'virtual-joystick';
        joystickContainer.style.cssText = `
            position: fixed;
            left: 20px;
            bottom: 20px;
            width: 120px;
            height: 120px;
            background: rgba(255, 255, 255, 0.3);
            border: 2px solid rgba(255, 255, 255, 0.5);
            border-radius: 50%;
            z-index: 1000;
            touch-action: none;
        `;

        // 创建摇杆手柄
        const joystickHandle = document.createElement('div');
        joystickHandle.id = 'joystick-handle';
        joystickHandle.style.cssText = `
            position: absolute;
            width: 40px;
            height: 40px;
            background: rgba(255, 255, 255, 0.8);
            border-radius: 50%;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            transition: none;
        `;

        joystickContainer.appendChild(joystickHandle);
        document.body.appendChild(joystickContainer);

        this.virtualJoysticks.set('player1', {
            container: joystickContainer,
            handle: joystickHandle,
            centerX: 80, // 相对于容器的中心
            centerY: 80,
            isActive: false
        });
    }

    createActionButtons() {
        // 创建暂停按钮
        const pauseButton = document.createElement('div');
        pauseButton.id = 'pause-button';
        pauseButton.innerHTML = '⏸️';
        pauseButton.style.cssText = `
            position: fixed;
            right: 20px;
            top: 20px;
            width: 50px;
            height: 50px;
            background: rgba(255, 255, 255, 0.3);
            border: 2px solid rgba(255, 255, 255, 0.5);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
            z-index: 1000;
            touch-action: none;
            user-select: none;
        `;

        pauseButton.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.handlePauseToggle();
        });

        document.body.appendChild(pauseButton);
    }

    handleTouchStart(e) {
        e.preventDefault();
        
        for (let touch of e.changedTouches) {
            const touchId = touch.identifier;
            const x = touch.clientX;
            const y = touch.clientY;

            // 检查是否触摸了虚拟摇杆
            const joystick = this.virtualJoysticks.get('player1');
            if (joystick && this.isPointInElement(x, y, joystick.container)) {
                joystick.isActive = true;
                this.touchStartPos.set(touchId, { x, y, type: 'joystick' });
                this.updateJoystickHandle(joystick, x, y);
            } else {
                // 记录其他触摸点
                this.touchStartPos.set(touchId, { x, y, type: 'gesture' });
            }
        }
    }

    handleTouchMove(e) {
        e.preventDefault();
        
        for (let touch of e.changedTouches) {
            const touchId = touch.identifier;
            const startPos = this.touchStartPos.get(touchId);
            
            if (!startPos) continue;

            const currentX = touch.clientX;
            const currentY = touch.clientY;

            if (startPos.type === 'joystick') {
                const joystick = this.virtualJoysticks.get('player1');
                if (joystick && joystick.isActive) {
                    this.updateJoystickHandle(joystick, currentX, currentY);
                    this.updatePlayerMovementFromJoystick(joystick, currentX, currentY);
                }
            } else if (startPos.type === 'gesture') {
                // 处理手势控制
                this.handleGestureMovement(startPos, currentX, currentY);
            }
        }
    }

    handleTouchEnd(e) {
        e.preventDefault();
        
        for (let touch of e.changedTouches) {
            const touchId = touch.identifier;
            const startPos = this.touchStartPos.get(touchId);
            
            if (!startPos) continue;

            if (startPos.type === 'joystick') {
                const joystick = this.virtualJoysticks.get('player1');
                if (joystick) {
                    joystick.isActive = false;
                    this.resetJoystickHandle(joystick);
                    this.stopPlayerMovement('player1');
                }
            }

            this.touchStartPos.delete(touchId);
        }
    }

    updateJoystickHandle(joystick, touchX, touchY) {
        const containerRect = joystick.container.getBoundingClientRect();
        const centerX = containerRect.left + containerRect.width / 2;
        const centerY = containerRect.top + containerRect.height / 2;
        
        const deltaX = touchX - centerX;
        const deltaY = touchY - centerY;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        const maxDistance = containerRect.width / 2 - 20; // 留出边距

        let handleX = deltaX;
        let handleY = deltaY;

        if (distance > maxDistance) {
            const ratio = maxDistance / distance;
            handleX = deltaX * ratio;
            handleY = deltaY * ratio;
        }

        joystick.handle.style.transform = `translate(${handleX}px, ${handleY}px)`;
    }

    resetJoystickHandle(joystick) {
        joystick.handle.style.transform = 'translate(0px, 0px)';
    }

    updatePlayerMovementFromJoystick(joystick, touchX, touchY) {
        const containerRect = joystick.container.getBoundingClientRect();
        const centerX = containerRect.left + containerRect.width / 2;
        const centerY = containerRect.top + containerRect.height / 2;
        
        const deltaX = touchX - centerX;
        const deltaY = touchY - centerY;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

        if (distance < 10) {
            this.stopPlayerMovement('player1');
            return;
        }

        // 计算方向
        let dx = 0, dy = 0;
        const threshold = 20;

        if (Math.abs(deltaX) > threshold) {
            dx = deltaX > 0 ? 1 : -1;
        }
        if (Math.abs(deltaY) > threshold) {
            dy = deltaY > 0 ? 1 : -1;
        }

        // 更新玩家移动
        const player = this.gameEngine.players.find(p => p.id === 'player1');
        if (player && player.isAlive) {
            player.setDirection(dx, dy);
        }
    }

    handleGestureMovement(startPos, currentX, currentY) {
        const deltaX = currentX - startPos.x;
        const deltaY = currentY - startPos.y;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

        if (distance < this.touchSensitivity) return;

        // 计算主要方向
        let dx = 0, dy = 0;
        
        if (Math.abs(deltaX) > Math.abs(deltaY)) {
            dx = deltaX > 0 ? 1 : -1;
        } else {
            dy = deltaY > 0 ? 1 : -1;
        }

        // 更新第一个玩家的移动（如果没有虚拟摇杆激活）
        const joystick = this.virtualJoysticks.get('player1');
        if (!joystick || !joystick.isActive) {
            const player = this.gameEngine.players.find(p => p.id === 'player1');
            if (player && player.isAlive) {
                player.setDirection(dx, dy);
            }
        }
    }

    stopPlayerMovement(playerId) {
        const player = this.gameEngine.players.find(p => p.id === playerId);
        if (player) {
            player.setDirection(0, 0);
        }
    }

    isPointInElement(x, y, element) {
        const rect = element.getBoundingClientRect();
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    handlePauseToggle() {
        if (this.gameEngine.gameState === 'playing') {
            if (typeof pauseGame === 'function') {
                pauseGame();
            }
        } else if (this.gameEngine.gameState === 'paused') {
            if (typeof resumeGame === 'function') {
                resumeGame();
            }
        }
    }

    // 键盘处理方法
    handleKeyDown(e) {
        if (this.keyStates.get(e.code)) return;
        
        this.keyStates.set(e.code, true);
        this.pressedKeys.add(e.code);
        
        if (this.gameEngine.gameState === 'playing') {
            this.updatePlayerMovement();
        }
        
        // ESC键直接退出游戏，关闭HTML页面
        if (e.code === 'Escape') {
            window.close();
            return;
        }
        
        // 空格键暂停/继续游戏
        if (e.code === 'Space') {
            e.preventDefault(); // 防止页面滚动
            if (this.gameEngine.gameState === 'playing') {
                if (typeof pauseGame === 'function') {
                    pauseGame();
                }
            } else if (this.gameEngine.gameState === 'paused') {
                if (typeof resumeGame === 'function') {
                    resumeGame();
                }
            }
            return;
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

            if (this.keyStates.get(controls.left)) dx = -1;
            if (this.keyStates.get(controls.right)) dx = 1;
            if (this.keyStates.get(controls.up)) dy = -1;
            if (this.keyStates.get(controls.down)) dy = 1;

            player.setDirection(dx, dy);
        });
    }

    // 清理方法
    destroy() {
        // 移除虚拟控件
        const joystick = document.getElementById('virtual-joystick');
        const pauseButton = document.getElementById('pause-button');
        
        if (joystick) joystick.remove();
        if (pauseButton) pauseButton.remove();
        
        // 清理数据
        this.touchControls.clear();
        this.touchStartPos.clear();
        this.virtualJoysticks.clear();
    }
}
