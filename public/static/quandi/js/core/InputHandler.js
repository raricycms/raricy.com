class InputHandler {
    constructor(gameEngine) {
        this.gameEngine = gameEngine;
        this.keyStates = new Set();
        this.localBindings = null;
        this.dx = this.dy = 0;
        this.keydown = (event) => this.handleKeyDown(event);
        this.keyup = (event) => { this.keyStates.delete(event.code); this.updatePlayerMovement(); };
        this.blur = () => this.clear();
        this.visibility = () => { if (document.hidden) this.clear(); };
        document.addEventListener('keydown', this.keydown);
        document.addEventListener('keyup', this.keyup);
        window.addEventListener('blur', this.blur);
        document.addEventListener('visibilitychange', this.visibility);
    }
    setLocalBindings(bindings) { this.localBindings = bindings; }
    handleKeyDown(event) {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable) return;
        if (event.code === 'Escape') { this.clear(); showMainMenu(); return; }
        if (event.code === 'Space') {
            event.preventDefault();
            if (event.repeat) return;
            if (this.gameEngine.gameState === 'playing') pauseGame();
            else if (this.gameEngine.gameState === 'paused') resumeGame();
            return;
        }
        if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) return;
        event.preventDefault();
        this.keyStates.add(event.code);
        this.updatePlayerMovement();
    }
    updatePlayerMovement() {
        if (this.gameEngine.gameState !== 'playing') return;
        const direction = (bindings) => ({
            x: Number(this.keyStates.has(bindings.right)) - Number(this.keyStates.has(bindings.left)),
            y: Number(this.keyStates.has(bindings.down)) - Number(this.keyStates.has(bindings.up)),
        });
        if (this.gameEngine.networkMode === 'online') {
            const value = direction(this.localBindings || Config.KEY_BINDINGS.player1);
            this.dx = value.x; this.dy = value.y;
            this.gameEngine.localPlayer?.setDirection(this.dx, this.dy);
        } else for (const player of this.gameEngine.players) {
            const value = direction(player.controls);
            player.setDirection(value.x, value.y);
        }
    }
    getCurrentInput() { this.updatePlayerMovement(); return { direction: { x: this.dx, y: this.dy }, isMoving: this.dx !== 0 || this.dy !== 0 }; }
    clear() { this.keyStates.clear(); this.dx = this.dy = 0; this.updatePlayerMovement(); }
    destroy() {
        this.clear();
        document.removeEventListener('keydown', this.keydown);
        document.removeEventListener('keyup', this.keyup);
        window.removeEventListener('blur', this.blur);
        document.removeEventListener('visibilitychange', this.visibility);
    }
}
