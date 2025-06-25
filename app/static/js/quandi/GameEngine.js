class GameEngine {
    constructor() {
        this.width = 1200;
        this.height = 600;
        this.players = [];
        this.territory = new Territory();
        this.gameState = 'menu'; // menu, playing, paused, gameOver
        this.difficulty = 'medium';
        this.gameTime = 0;
        this.maxGameTime = 120000; // 2分钟
        this.lastUpdate = 0;
        this.P1_startX = 0.15*this.width;
        this.P1_startY = 0.5*this.height;
        this.P2_startX = 0.85*this.width;
        this.P2_startY = 0.5*this.height;

    }

    init(canvas) {
        this.canvas = canvas;
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.ctx = canvas.getContext('2d');
        this.renderer = new Renderer(canvas);
        this.itemManager = new ItemManager(canvas);
        
        // 创建玩家
        this.players = [
            new Player(1, this.P1_startX, this.P1_startY, '#ff4444', {
                up: 'KeyW',
                down: 'KeyS',
                left: 'KeyA',
                right: 'KeyD',
                startX: this.P1_startX
                              
            }, this.canvas),
            new Player(2, this.P2_startX, this.P2_startY, '#4444ff', {
                up: 'ArrowUp',
                down: 'ArrowDown',
                left: 'ArrowLeft',
                right: 'ArrowRight',
                startX: this.P2_startX
               
            }, this.canvas)
        ];

        this.setDifficulty(this.difficulty);
    }

    setDifficulty(level) {
        this.difficulty = level;
        const settings = {
            easy: { speed: 2, maxTime: 90000 },
            medium: { speed: 2.5, maxTime: 60000 },
            hard: { speed: 3, maxTime: 40000 }
        };

        const setting = settings[level];
        this.maxGameTime = setting.maxTime;
        
        if (this.players) {
            this.players.forEach(player => {
                player.speed = setting.speed;
            });
        }
    }

    setPlayerColor(playerId, color) {
        if (this.players[playerId - 1]) {
            this.players[playerId - 1].color = color;
        }
    }

    start() {

        this.setDifficulty(this.difficulty);

        this.gameState = 'playing';
        this.gameTime = 0;
        this.lastUpdate = Date.now();
        
        // 重置玩家位置
        this.players[0].reset(this.P1_startX, this.P1_startY);
        this.players[1].reset(this.P2_startX, this.P2_startY);
        
        // 重置领土
        this.territory.reset();
        this.itemManager.reset();
        this.gameLoop();
        console.log('game started');
    }

    restart() {
        this.gameState = 'menu';
        setTimeout(() => {
            this.start();
        }, 100);
        console.log('game restarted');
        
    }

    gameLoop() {
        if (this.gameState !== 'playing') return;

        const now = Date.now();
        const deltaTime = now - this.lastUpdate;
        this.lastUpdate = now;

        this.update(deltaTime);
        this.render();

        requestAnimationFrame(() => this.gameLoop());
    }

    update(deltaTime) {
        this.gameTime += deltaTime;

        // 检查游戏时间
        if (this.gameTime >= this.maxGameTime) {
            this.endGame();
            return;
        }

        // 更新道具系统
        this.itemManager.update(deltaTime);
    
        // 检查道具碰撞
        this.players.forEach(player => {
            this.itemManager.checkItemCollision(player);
        
            // 检查障碍物碰撞（阻止移动但不死亡）
            const obstacle = this.itemManager.checkObstacleCollision(player);
            if (obstacle) {
                // 可以在这里添加碰撞反馈，比如阻止移动
                player.handleObstacleCollision(obstacle);
            }
        });
    
        // 清理过期道具
        this.itemManager.cleanup();

        // 更新玩家
        this.players.forEach(player => player.update());

        // 碰撞检测
        this.checkCollisions();

        // 检测圈地
        this.players.forEach(player => {
            const newTerritory = this.territory.detectEnclosure(player);
            if (newTerritory) {
                player.score = this.territory.calculateScore(player.id, this.canvas.width, this.canvas.height);
            }
        });

        // 检查游戏结束条件
        const alivePlayers = this.players.filter(p => p.isAlive);
        if (alivePlayers.length <= 1) {
            this.endGame();
        }
    }

    checkCollisions() {
        for (let i = 0; i < this.players.length; i++) {
            const player = this.players[i];
            if (!player.isAlive) continue;

            // 检查与其他玩家轨迹的碰撞
            for (let j = 0; j < this.players.length; j++) {
                if (i === j) continue;
                const otherPlayer = this.players[j];
                
                if (player.checkCollisionWithTrail(otherPlayer.trail)) {
                    player.die();
                    break;
                }

                // 检查与其他玩家领土的碰撞
                const otherTerritories = this.territory.getPlayerTerritories(otherPlayer.id);
                if (!player.canEnterEnemyTerritory()) {
                    if (player.checkCollisionWithTerritory(otherTerritories)) {
                        player.die();
                        break;
                    }
                }
            }
        }
    }

    render() {
        // 清空画布
        this.renderer.clear();

        // 绘制生成点
        this.players.forEach(player => {
            this.renderer.drawSpawnPoint(player.startX, this.P1_startY, player.color);
        });

        // 渲染道具和障碍物
        this.itemManager.render(this.renderer);
    
        // 渲染领土
        this.players.forEach(player => {
            const territories = this.territory.getPlayerTerritories(player.id);
            if (territories && territories.length > 0) {
                this.renderer.drawTerritories(territories, player.id, player.color);
            }
        });
    
        // 渲染轨迹
        this.players.forEach(player => {
            if (player.trail && player.trail.length > 0) {
                this.renderer.drawTrail(player.trail, player.color);
            }
        });
    
        // 渲染玩家
        this.players.forEach(player => {
            this.renderer.drawPlayer(player);
        });
    
        // 更新UI
        this.updateUI();
    }

    renderTerritories() {
        this.players.forEach(player => {
            const territories = this.territory.getPlayerTerritories(player.id);
            this.ctx.fillStyle = player.color + '40'; // 半透明
            
            territories.forEach(territory => {
                this.ctx.beginPath();
                territory.forEach((point, index) => {
                    if (index === 0) {
                        this.ctx.moveTo(point.x, point.y);
                    } else {
                        this.ctx.lineTo(point.x, point.y);
                    }
                });
                this.ctx.closePath();
                this.ctx.fill();
            });
        });
    }

    renderTrails() {
        this.players.forEach(player => {
            if (player.trail.length < 2) return;

            this.ctx.strokeStyle = player.color;
            this.ctx.lineWidth = 4;
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';

            this.ctx.beginPath();
            player.trail.forEach((point, index) => {
                if (index === 0) {
                    this.ctx.moveTo(point.x, point.y);
                } else {
                    this.ctx.lineTo(point.x, point.y);
                }
            });
            this.ctx.stroke();
        });
    }

    renderPlayers() {
        this.players.forEach(player => {
            if (!player.isAlive) return;

            // 玩家主体
            this.ctx.fillStyle = player.color;
            this.ctx.beginPath();
            this.ctx.arc(player.x, player.y, player.size, 0, Math.PI * 2);
            this.ctx.fill();

            // 玩家边框
            this.ctx.strokeStyle = '#333';
            this.ctx.lineWidth = 2;
            this.ctx.stroke();

            // 玩家ID
            this.ctx.fillStyle = '#fff';
            this.ctx.font = 'bold 12px Arial';
            this.ctx.textAlign = 'center';
            this.ctx.fillText(player.id.toString(), player.x, player.y + 4);
        });
    }

    updateUI() {
        // 更新分数
        this.players.forEach((player, index) => {
            const score = this.territory.calculateScore(player.id, this.canvas.width, this.canvas.height);
            const scoreElement = document.getElementById(`player${player.id}Score`);
            const scoreTextElement = document.getElementById(`player${player.id}ScoreText`);
            
            if (scoreElement && scoreTextElement) {
                scoreElement.style.width = score + '%';
                scoreTextElement.textContent = Math.round(score) + '%';
            }
        });

        // 更新游戏状态
        const statusElement = document.getElementById('gameStatus');
        if (statusElement) {
            const remainingTime = Math.max(0, this.maxGameTime - this.gameTime);
            const minutes = Math.floor(remainingTime / 60000);
            const seconds = Math.floor((remainingTime % 60000) / 1000);
            statusElement.textContent = `剩余时间: ${minutes}:${seconds.toString().padStart(2, '0')}`;
        }
    }

    pause() {
        this.gameState = 'paused';
    }

    resume() {
        if (this.gameState === 'paused') {
            this.gameState = 'playing';
            this.lastUpdate = Date.now();
            this.gameLoop();
        }
    }

    endGame() {
        this.gameState = 'gameOver';
        
        // 计算最终分数
        const scores = this.players.map(player => ({
            id: player.id,
            score: this.territory.calculateScore(player.id, this.canvas.width, this.canvas.height),
            isAlive: player.isAlive
        }));

        // 确定获胜者
        const winner = scores.reduce((prev, current) => {
            if (!prev.isAlive && current.isAlive) return current;
            if (prev.isAlive && !current.isAlive) return prev;
            return prev.score > current.score ? prev : current;
        });

        // 显示游戏结束界面
        this.showGameOver(winner, scores);
    }

    showGameOver(winner, scores) {
        const gameOverMenu = document.getElementById('gameOverMenu');
        const gameOverTitle = document.getElementById('gameOverTitle');
        const gameOverMessage = document.getElementById('gameOverMessage');

        gameOverTitle.textContent = `玩家${winner.id}获胜！`;
        gameOverMessage.textContent = `最终分数 - 玩家1: ${Math.round(scores[0].score)}%, 玩家2: ${Math.round(scores[1].score)}%`;

        gameOverMenu.classList.add('active');
    }

/*    handleInput(code, isPressed) {
        this.players.forEach(player => {
            if (!player.isAlive) return;

            const controls = player.controls;
            if (isPressed) {
                switch (code) {
                    case controls.up:
                        player.setDirection(0, -1);
                        break;
                    case controls.down:
                        player.setDirection(0, 1);
                        break;
                    case controls.left:
                        player.setDirection(-1, 0);
                        break;
                    case controls.right:
                        player.setDirection(1, 0);
                        break;
                }
            }
        });
    }*/
}
