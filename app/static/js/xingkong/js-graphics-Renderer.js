/**
 * 渲染器类
 * 负责游戏的所有图形渲染
 */
class Renderer {
    constructor() {
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.resizeCanvas();
        window.addEventListener('resize', () => this.resizeCanvas());
    }

    /**
     * 调整画布大小
     */
    resizeCanvas() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        
        if (gameState.gameRunning) {
            playerManager.player.x = Math.min(playerManager.player.x, this.canvas.width - playerManager.player.width);
            playerManager.player.y = Math.min(playerManager.player.y, this.canvas.height - playerManager.player.height);
            if (gameState.isDualMode) {
                playerManager.player2.x = Math.min(playerManager.player2.x, this.canvas.width - playerManager.player2.width);
                playerManager.player2.y = Math.min(playerManager.player2.y, this.canvas.height - playerManager.player2.height);
            }
        }
    }

    /**
     * 主绘制方法
     */
    draw() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        this.drawScrollingBackground();
        
        if (gameState.isFunMode) {
            this.drawBlackholes();
            this.drawMeteors();
        }
        
        this.drawPlayer();
        if (gameState.isDualMode) {
            this.drawPlayer2();
        }
        this.drawBullets();
        this.drawEnemies();
        this.drawEnemyBullets();
        this.drawBoss();
        this.drawPowerups();
        this.drawExplosions();
        
        if (gameState.gamePaused) {
            this.drawPauseOverlay();
        }
    }

    /**
     * 绘制滚动背景
     */
    drawScrollingBackground() {
        this.ctx.save();
        this.ctx.globalAlpha = 0.2;
        
        // 绘制网格线
        this.ctx.strokeStyle = '#4a90e2';
        this.ctx.lineWidth = 1;
        for (let i = 0; i < this.canvas.width; i += 100) {
            this.ctx.beginPath();
            this.ctx.moveTo(i, (gameController.backgroundOffset - this.canvas.height) % 200);
            this.ctx.lineTo(i, (gameController.backgroundOffset - this.canvas.height) % 200 + this.canvas.height);
            this.ctx.stroke();
        }
        
        // 绘制星点
        this.ctx.fillStyle = '#ffffff';
        for (let i = 0; i < 20; i++) {
            const x = (i * 50) % this.canvas.width;
            const y = (gameController.backgroundOffset + i * 30) % this.canvas.height;
            this.ctx.beginPath();
            this.ctx.arc(x, y, 1, 0, Math.PI * 2);
            this.ctx.fill();
        }
        
        this.ctx.restore();
    }

    /**
     * 绘制暂停覆盖层
     */
    drawPauseOverlay() {
        this.ctx.save();
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        this.ctx.fillStyle = 'white';
        this.ctx.font = '48px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText('游戏暂停', this.canvas.width / 2, this.canvas.height / 2);
        this.ctx.restore();
    }

    /**
     * 绘制玩家1
     */
    drawPlayer() {
        this.ctx.save();
        this.ctx.translate(playerManager.player.x + playerManager.player.width / 2, playerManager.player.y + playerManager.player.height / 2);
        
        const time = Date.now() * 0.001;
        
        // 主体渐变
        const gradient = this.ctx.createLinearGradient(0, -25, 0, 25);
        if (gameState.isPoweredUp) {
            gradient.addColorStop(0, '#ffffff');
            gradient.addColorStop(0.2, '#ff6b9d');
            gradient.addColorStop(0.5, '#ff4a90');
            gradient.addColorStop(0.8, '#e2357a');
            gradient.addColorStop(1, '#8800ff');
        } else {
            gradient.addColorStop(0, '#ffffff');
            gradient.addColorStop(0.2, '#6bb6ff');
            gradient.addColorStop(0.5, '#4a90e2');
            gradient.addColorStop(0.8, '#357abd');
            gradient.addColorStop(1, '#1a5490');
        }
        
        // 绘制飞机主体
        this.ctx.fillStyle = gradient;
        this.ctx.beginPath();
        this.ctx.moveTo(0, -25);
        this.ctx.quadraticCurveTo(-6, -20, -10, -10);
        this.ctx.quadraticCurveTo(-12, 0, -8, 15);
        this.ctx.quadraticCurveTo(-6, 22, -4, 25);
        this.ctx.lineTo(4, 25);
        this.ctx.quadraticCurveTo(6, 22, 8, 15);
        this.ctx.quadraticCurveTo(12, 0, 10, -10);
        this.ctx.quadraticCurveTo(6, -20, 0, -25);
        this.ctx.fill();
        
        // 绘制机翼、驾驶舱、引擎等
        this.drawPlayerDetails(time, gameState.isPoweredUp, false);
        
        // 绘制特效
        if (gameState.isPoweredUp) {
            this.drawPowerUpEffect(time);
        }
        
        if (gameState.isShielded) {
            this.drawShieldEffect(time);
        }
        
        // 显示玩家判定区中心点
        this.drawPlayerCore();
        
        // 双人模式下显示P1标识
        if (gameState.isDualMode) {
            this.drawPlayerLabel('P1');
        }
        
        this.ctx.restore();
    }

    /**
     * 绘制玩家2（双人模式）
     */
    drawPlayer2() {
        if (!gameState.isDualMode) return;
        
        this.ctx.save();
        this.ctx.translate(playerManager.player2.x + playerManager.player2.width / 2, playerManager.player2.y + playerManager.player2.height / 2);
        
        const time = Date.now() * 0.001;
        
        // Player 2 使用不同的颜色方案（橙色系）
        const gradient = this.ctx.createLinearGradient(0, -25, 0, 25);
        if (gameState.isPoweredUp) {
            gradient.addColorStop(0, '#ffffff');
            gradient.addColorStop(0.2, '#ff6b9d');
            gradient.addColorStop(0.5, '#ff4a90');
            gradient.addColorStop(0.8, '#e2357a');
            gradient.addColorStop(1, '#8800ff');
        } else {
            gradient.addColorStop(0, '#ffffff');
            gradient.addColorStop(0.2, '#ffbb66');
            gradient.addColorStop(0.5, '#ff8800');
            gradient.addColorStop(0.8, '#cc6600');
            gradient.addColorStop(1, '#994400');
        }
        
        // 绘制飞机主体（与玩家1相同的形状）
        this.ctx.fillStyle = gradient;
        this.ctx.beginPath();
        this.ctx.moveTo(0, -25);
        this.ctx.quadraticCurveTo(-6, -20, -10, -10);
        this.ctx.quadraticCurveTo(-12, 0, -8, 15);
        this.ctx.quadraticCurveTo(-6, 22, -4, 25);
        this.ctx.lineTo(4, 25);
        this.ctx.quadraticCurveTo(6, 22, 8, 15);
        this.ctx.quadraticCurveTo(12, 0, 10, -10);
        this.ctx.quadraticCurveTo(6, -20, 0, -25);
        this.ctx.fill();
        
        // 绘制玩家2的详细部件（橙色主题）
        this.drawPlayerDetails(time, gameState.isPoweredUp, true);
        
        // 绘制特效
        if (gameState.isPoweredUp) {
            this.drawPowerUpEffect(time);
        }
        
        if (gameState.isShielded) {
            this.drawShieldEffect(time);
        }
        
        // 显示玩家判定区中心点
        this.drawPlayerCore();
        
        // 显示P2标识
        this.drawPlayerLabel('P2');
        
        this.ctx.restore();
    }

    /**
     * 绘制玩家详细部件
     * @param {number} time - 时间参数
     * @param {boolean} isPoweredUp - 是否火力增强
     * @param {boolean} isPlayer2 - 是否为玩家2
     */
    drawPlayerDetails(time, isPoweredUp, isPlayer2 = false) {
        // 机翼
        const wingGradient = this.ctx.createLinearGradient(-25, 0, 25, 0);
        if (isPoweredUp) {
            wingGradient.addColorStop(0, '#ff4a90');
            wingGradient.addColorStop(0.3, '#e2357a');
            wingGradient.addColorStop(0.7, '#e2357a');
            wingGradient.addColorStop(1, '#ff4a90');
        } else {
            if (isPlayer2) {
                wingGradient.addColorStop(0, '#ff8800');
                wingGradient.addColorStop(0.3, '#cc6600');
                wingGradient.addColorStop(0.7, '#cc6600');
                wingGradient.addColorStop(1, '#ff8800');
            } else {
                wingGradient.addColorStop(0, '#4a90e2');
                wingGradient.addColorStop(0.3, '#357abd');
                wingGradient.addColorStop(0.7, '#357abd');
                wingGradient.addColorStop(1, '#4a90e2');
            }
        }
        
        this.ctx.fillStyle = wingGradient;
        // 左翼
        this.ctx.beginPath();
        this.ctx.moveTo(-25, 8);
        this.ctx.quadraticCurveTo(-20, 2, -12, 5);
        this.ctx.lineTo(-8, 12);
        this.ctx.quadraticCurveTo(-15, 18, -22, 15);
        this.ctx.quadraticCurveTo(-25, 12, -25, 8);
        this.ctx.fill();
        
        // 右翼
        this.ctx.beginPath();
        this.ctx.moveTo(25, 8);
        this.ctx.quadraticCurveTo(20, 2, 12, 5);
        this.ctx.lineTo(8, 12);
        this.ctx.quadraticCurveTo(15, 18, 22, 15);
        this.ctx.quadraticCurveTo(25, 12, 25, 8);
        this.ctx.fill();
        
        // 驾驶舱
        const cockpitGradient = this.ctx.createRadialGradient(-2, -12, 0, 0, -8, 12);
        cockpitGradient.addColorStop(0, '#ffffff');
        if (isPlayer2) {
            cockpitGradient.addColorStop(0.3, '#ffddcc');
            cockpitGradient.addColorStop(0.7, '#ff8800');
            cockpitGradient.addColorStop(1, '#994400');
        } else {
            cockpitGradient.addColorStop(0.3, '#ccddff');
            cockpitGradient.addColorStop(0.7, '#4a90e2');
            cockpitGradient.addColorStop(1, '#1a5490');
        }
        
        this.ctx.fillStyle = cockpitGradient;
        this.ctx.beginPath();
        this.ctx.ellipse(0, -10, 8, 12, 0, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 引擎
        this.drawEngines(time, isPoweredUp, isPlayer2);
        
        // 装饰线条
        this.ctx.strokeStyle = isPoweredUp ? '#ff00ff' : (isPlayer2 ? '#ffaa00' : '#00ffff');
        this.ctx.lineWidth = 1.5;
        this.ctx.beginPath();
        this.ctx.moveTo(-5, -20);
        this.ctx.lineTo(-5, 15);
        this.ctx.moveTo(5, -20);
        this.ctx.lineTo(5, 15);
        this.ctx.stroke();
        
        // 核心光球
        this.drawCoreOrb(time, isPoweredUp, isPlayer2);
    }

    /**
     * 绘制引擎
     * @param {number} time - 时间参数
     * @param {boolean} isPoweredUp - 是否火力增强
     * @param {boolean} isPlayer2 - 是否为玩家2
     */
    drawEngines(time, isPoweredUp, isPlayer2 = false) {
        const engineGradient = this.ctx.createRadialGradient(0, 20, 0, 0, 20, 12);
        if (isPoweredUp) {
            engineGradient.addColorStop(0, '#ffffff');
            engineGradient.addColorStop(0.2, '#ff00ff');
            engineGradient.addColorStop(0.6, '#8800ff');
            engineGradient.addColorStop(1, '#4400aa');
        } else {
            if (isPlayer2) {
                engineGradient.addColorStop(0, '#ffffff');
                engineGradient.addColorStop(0.2, '#ffaa00');
                engineGradient.addColorStop(0.6, '#ff6600');
                engineGradient.addColorStop(1, '#cc4400');
            } else {
                engineGradient.addColorStop(0, '#ffffff');
                engineGradient.addColorStop(0.2, '#00ffff');
                engineGradient.addColorStop(0.6, '#0088ff');
                engineGradient.addColorStop(1, '#004488');
            }
        }
        
        this.ctx.fillStyle = engineGradient;
        
        // 主引擎
        this.ctx.beginPath();
        this.ctx.ellipse(0, 22, 4, 8 + Math.sin(time * 10) * 2, 0, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 副引擎
        this.ctx.beginPath();
        this.ctx.ellipse(-8, 20, 3, 6 + Math.sin(time * 8) * 1, 0, 0, Math.PI * 2);
        this.ctx.fill();
        
        this.ctx.beginPath();
        this.ctx.ellipse(8, 20, 3, 6 + Math.sin(time * 8 + Math.PI) * 1, 0, 0, Math.PI * 2);
        this.ctx.fill();
    }

    /**
     * 绘制核心光球
     * @param {number} time - 时间参数
     * @param {boolean} isPoweredUp - 是否火力增强
     * @param {boolean} isPlayer2 - 是否为玩家2
     */
    drawCoreOrb(time, isPoweredUp, isPlayer2 = false) {
        const coreGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 6);
        if (isPoweredUp) {
            coreGradient.addColorStop(0, '#ffffff');
            coreGradient.addColorStop(0.5, '#ff00ff');
            coreGradient.addColorStop(1, 'transparent');
        } else {
            if (isPlayer2) {
                coreGradient.addColorStop(0, '#ffffff');
                coreGradient.addColorStop(0.5, '#ffaa00');
                coreGradient.addColorStop(1, 'transparent');
            } else {
                coreGradient.addColorStop(0, '#ffffff');
                coreGradient.addColorStop(0.5, '#00ffff');
                coreGradient.addColorStop(1, 'transparent');
            }
        }
        
        this.ctx.fillStyle = coreGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 4 + Math.sin(time * 5) * 1, 0, Math.PI * 2);
        this.ctx.fill();
    }

    /**
     * 绘制火力增强特效
     * @param {number} time - 时间参数
     */
    drawPowerUpEffect(time) {
        this.ctx.strokeStyle = '#ff00ff';
        this.ctx.lineWidth = 3;
        this.ctx.setLineDash([4, 4]);
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 30 + Math.sin(time * 3) * 5, 0, Math.PI * 2);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
        
        // 环绕粒子
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2 + time * 2;
            const distance = 35 + Math.sin(time * 4 + i) * 5;
            const x = Math.cos(angle) * distance;
            const y = Math.sin(angle) * distance;
            
            this.ctx.fillStyle = '#ff00ff';
            this.ctx.beginPath();
            this.ctx.arc(x, y, 2, 0, Math.PI * 2);
            this.ctx.fill();
        }
    }

    /**
     * 绘制护盾特效
     * @param {number} time - 时间参数
     */
    drawShieldEffect(time) {
        this.ctx.strokeStyle = '#00bfff';
        this.ctx.lineWidth = 4;
        this.ctx.setLineDash([6, 6]);
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 35 + Math.sin(time * 4) * 3, 0, Math.PI * 2);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
        
        this.ctx.globalAlpha = 0.3 + 0.2 * Math.sin(time * 6);
        this.ctx.fillStyle = '#00bfff';
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 35, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.globalAlpha = 1;
    }

    /**
     * 绘制玩家核心点
     */
    drawPlayerCore() {
        this.ctx.fillStyle = '#ff0000';
        this.ctx.shadowColor = '#ff0000';
        this.ctx.shadowBlur = 10;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 2, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.shadowBlur = 0;
    }

    /**
     * 绘制玩家标签
     * @param {string} label - 标签文本
     */
    drawPlayerLabel(label) {
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = 'bold 12px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.shadowColor = '#000000';
        this.ctx.shadowBlur = 3;
        this.ctx.fillText(label, 0, -35);
        this.ctx.shadowBlur = 0;
    }

    /**
     * 绘制子弹
     */
    drawBullets() {
        weaponManager.bullets.forEach(bullet => {
            this.ctx.save();
            
            const bulletGradient = this.ctx.createLinearGradient(bullet.x, bullet.y, bullet.x, bullet.y + bullet.height);
            if (gameState.isPoweredUp) {
                bulletGradient.addColorStop(0, '#ffffff');
                bulletGradient.addColorStop(0.3, '#ff00ff');
                bulletGradient.addColorStop(0.7, '#8800ff');
                bulletGradient.addColorStop(1, '#4400aa');
            } else {
                // 根据玩家区分子弹颜色
                if (bullet.player === 2) {
                    bulletGradient.addColorStop(0, '#ffffff');
                    bulletGradient.addColorStop(0.3, '#ffaa00');
                    bulletGradient.addColorStop(0.7, '#ff6600');
                    bulletGradient.addColorStop(1, '#cc4400');
                } else {
                    bulletGradient.addColorStop(0, '#ffffff');
                    bulletGradient.addColorStop(0.3, '#00ffff');
                    bulletGradient.addColorStop(0.7, '#0088ff');
                    bulletGradient.addColorStop(1, '#004488');
                }
            }
            
            this.ctx.fillStyle = bulletGradient;
            this.ctx.fillRect(bullet.x, bullet.y, bullet.width, bullet.height);
            
            // 发光效果
            this.ctx.shadowColor = gameState.isPoweredUp ? '#ff00ff' : (bullet.player === 2 ? '#ffaa00' : '#00ffff');
            this.ctx.shadowBlur = 25;
            this.ctx.fillRect(bullet.x, bullet.y, bullet.width, bullet.height);
            
            this.ctx.globalAlpha = 0.6;
            this.ctx.shadowBlur = 35;
            this.ctx.fillRect(bullet.x - 1, bullet.y - 1, bullet.width + 2, bullet.height + 2);
            
            this.ctx.restore();
        });
    }

    /**
     * 绘制敌机
     */
    drawEnemies() {
        enemyManager.enemies.forEach(enemy => {
            this.ctx.save();
            this.ctx.translate(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2);
            
            const time = Date.now() * 0.001;
            
            // 根据敌机类型绘制不同外观
            switch (enemy.type) {
                case 'basic':
                    this.drawBasicEnemy(enemy, time);
                    break;
                case 'fast':
                    this.drawFastEnemy(enemy, time);
                    break;
                case 'heavy':
                    this.drawHeavyEnemy(enemy, time);
                    break;
                case 'sniper':
                    this.drawSniperEnemy(enemy, time);
                    break;
                case 'patrol':
                    this.drawPatrolEnemy(enemy, time);
                    break;
                case 'ball':
                    this.drawBallEnemy(enemy, time);
                    break;
            }
            
            // 绘制血条（多血量敌机）
            if (enemy.maxHealth > 1) {
                this.drawEnemyHealthBar(enemy);
            }
            
            this.ctx.restore();
        });
    }

    /**
     * 绘制基础敌机
     * @param {Object} enemy - 敌机对象
     * @param {number} time - 时间参数
     */
    drawBasicEnemy(enemy, time) {
        const basicGradient = this.ctx.createLinearGradient(0, -enemy.height/2, 0, enemy.height/2);
        basicGradient.addColorStop(0, '#ffffff');
        basicGradient.addColorStop(0.2, enemy.color);
        basicGradient.addColorStop(0.7, enemy.secondaryColor);
        basicGradient.addColorStop(1, '#220000');
        
        this.ctx.fillStyle = basicGradient;
        this.ctx.beginPath();
        this.ctx.moveTo(0, enemy.height/2);
        this.ctx.lineTo(-enemy.width/2, -enemy.height/2);
        this.ctx.lineTo(0, -enemy.height/3);
        this.ctx.lineTo(enemy.width/2, -enemy.height/2);
        this.ctx.closePath();
        this.ctx.fill();
        
        // 引擎光
        this.ctx.fillStyle = '#ff6600';
        this.ctx.shadowColor = '#ff6600';
        this.ctx.shadowBlur = 10;
        this.ctx.beginPath();
        this.ctx.arc(-enemy.width/3, enemy.height/3, 3, 0, Math.PI * 2);
        this.ctx.arc(enemy.width/3, enemy.height/3, 3, 0, Math.PI * 2);
        this.ctx.fill();
    }

    /**
     * 绘制快速敌机
     * @param {Object} enemy - 敌机对象
     * @param {number} time - 时间参数
     */
    drawFastEnemy(enemy, time) {
        const fastGradient = this.ctx.createLinearGradient(0, -enemy.height/2, 0, enemy.height/2);
        fastGradient.addColorStop(0, '#ffffff');
        fastGradient.addColorStop(0.2, enemy.color);
        fastGradient.addColorStop(0.7, enemy.secondaryColor);
        fastGradient.addColorStop(1, '#442200');
        
        this.ctx.fillStyle = fastGradient;
        this.ctx.beginPath();
        this.ctx.moveTo(0, enemy.height/2);
        this.ctx.quadraticCurveTo(-enemy.width/3, 0, -enemy.width/4, -enemy.height/2);
        this.ctx.lineTo(0, -enemy.height/3);
        this.ctx.lineTo(enemy.width/4, -enemy.height/2);
        this.ctx.quadraticCurveTo(enemy.width/3, 0, 0, enemy.height/2);
        this.ctx.fill();
        
        const thrusterGradient = this.ctx.createRadialGradient(0, enemy.height/3, 0, 0, enemy.height/3, 8);
        thrusterGradient.addColorStop(0, '#ffffff');
        thrusterGradient.addColorStop(0.5, '#ffaa00');
        thrusterGradient.addColorStop(1, 'transparent');
        
        this.ctx.fillStyle = thrusterGradient;
        this.ctx.fillRect(-enemy.width/2, enemy.height/4, enemy.width/6, enemy.height/4);
        this.ctx.fillRect(enemy.width/3, enemy.height/4, enemy.width/6, enemy.height/4);
    }

    /**
     * 绘制重型敌机
     * @param {Object} enemy - 敌机对象
     * @param {number} time - 时间参数
     */
    drawHeavyEnemy(enemy, time) {
        const heavyGradient = this.ctx.createLinearGradient(0, -enemy.height/2, 0, enemy.height/2);
        heavyGradient.addColorStop(0, '#ffffff');
        heavyGradient.addColorStop(0.2, enemy.color);
        heavyGradient.addColorStop(0.5, enemy.secondaryColor);
        heavyGradient.addColorStop(0.8, '#440044');
        heavyGradient.addColorStop(1, '#220022');
        
        this.ctx.fillStyle = heavyGradient;
        this.ctx.fillRect(-enemy.width/2, -enemy.height/2, enemy.width, enemy.height);
        
        this.ctx.strokeStyle = '#888888';
        this.ctx.lineWidth = 2;
        for (let i = 0; i < 3; i++) {
            const y = -enemy.height/3 + (i * enemy.height/6);
            this.ctx.beginPath();
            this.ctx.moveTo(-enemy.width/3, y);
            this.ctx.lineTo(enemy.width/3, y);
            this.ctx.stroke();
        }
        
        const cannonGradient = this.ctx.createLinearGradient(0, -enemy.height/2 - 10, 0, 0);
        cannonGradient.addColorStop(0, '#aaaaaa');
        cannonGradient.addColorStop(1, '#666666');
        
        this.ctx.fillStyle = cannonGradient;
        this.ctx.fillRect(-4, -enemy.height/2 - 10, 8, 15);
        
        this.ctx.fillStyle = '#8844ff';
        this.ctx.shadowColor = '#8844ff';
        this.ctx.shadowBlur = 15;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 6 + Math.sin(time * 4) * 2, 0, Math.PI * 2);
        this.ctx.fill();
    }

    /**
     * 绘制狙击手敌机
     * @param {Object} enemy - 敌机对象
     * @param {number} time - 时间参数
     */
    drawSniperEnemy(enemy, time) {
        const sniperGradient = this.ctx.createLinearGradient(0, -enemy.height/2, 0, enemy.height/2);
        sniperGradient.addColorStop(0, '#ffffff');
        sniperGradient.addColorStop(0.2, enemy.color);
        sniperGradient.addColorStop(0.7, enemy.secondaryColor);
        sniperGradient.addColorStop(1, '#004400');
        
        this.ctx.fillStyle = sniperGradient;
        this.ctx.beginPath();
        this.ctx.moveTo(0, enemy.height/2);
        this.ctx.lineTo(-enemy.width/3, -enemy.height/3);
        this.ctx.lineTo(-enemy.width/4, -enemy.height/2);
        this.ctx.lineTo(enemy.width/4, -enemy.height/2);
        this.ctx.lineTo(enemy.width/3, -enemy.height/3);
        this.ctx.closePath();
        this.ctx.fill();
        
        const sniperCannonGradient = this.ctx.createLinearGradient(0, -enemy.height/2 - 15, 0, 0);
        sniperCannonGradient.addColorStop(0, '#00ff88');
        sniperCannonGradient.addColorStop(0.5, '#33cc66');
        sniperCannonGradient.addColorStop(1, '#004400');
        
        this.ctx.fillStyle = sniperCannonGradient;
        this.ctx.fillRect(-3, -enemy.height/2 - 15, 6, 20);
        
        this.ctx.fillStyle = '#ffff00';
        this.ctx.shadowColor = '#ffff00';
        this.ctx.shadowBlur = 20;
        this.ctx.beginPath();
        this.ctx.arc(0, -enemy.height/3, 5 + Math.sin(time * 6) * 1, 0, Math.PI * 2);
        this.ctx.fill();
        
        if (enemy.y < 150) {
            this.ctx.strokeStyle = '#ff0000';
            this.ctx.lineWidth = 2;
            this.ctx.setLineDash([4, 4]);
            this.ctx.shadowColor = '#ff0000';
            this.ctx.shadowBlur = 10;
            this.ctx.beginPath();
            this.ctx.moveTo(0, enemy.height/2);
            
            // 在双人模式下，选择最近的玩家作为目标
            let targetPlayer = playerManager.player;
            if (gameState.isDualMode) {
                const dist1 = Math.sqrt((playerManager.player.x - enemy.x) ** 2 + (playerManager.player.y - enemy.y) ** 2);
                const dist2 = Math.sqrt((playerManager.player2.x - enemy.x) ** 2 + (playerManager.player2.y - enemy.y) ** 2);
                if (dist2 < dist1) {
                    targetPlayer = playerManager.player2;
                }
            }
            
            const targetX = targetPlayer.x + targetPlayer.width/2 - enemy.x - enemy.width/2;
            const targetY = targetPlayer.y + targetPlayer.height/2 - enemy.y - enemy.height/2;
            this.ctx.lineTo(targetX, targetY);
            this.ctx.stroke();
            this.ctx.setLineDash([]);
        }
    }

    /**
     * 绘制巡逻敌机
     * @param {Object} enemy - 敌机对象
     * @param {number} time - 时间参数
     */
    drawPatrolEnemy(enemy, time) {
        const patrolGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, enemy.width/2);
        patrolGradient.addColorStop(0, '#ffffff');
        patrolGradient.addColorStop(0.3, enemy.color);
        patrolGradient.addColorStop(0.7, enemy.secondaryColor);
        patrolGradient.addColorStop(1, '#440044');
        
        this.ctx.fillStyle = patrolGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, enemy.width/2, 0, Math.PI * 2);
        this.ctx.fill();
        
        this.ctx.strokeStyle = '#ff44ff';
        this.ctx.lineWidth = 3;
        this.ctx.shadowColor = '#ff44ff';
        this.ctx.shadowBlur = 15;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, enemy.width/2 - 3, 0, Math.PI * 2);
        this.ctx.stroke();
        
        const thrusterAngle = time * 2;
        for (let i = 0; i < 6; i++) {
            const angle = (i * Math.PI / 3) + thrusterAngle;
            const x = Math.cos(angle) * enemy.width/3;
            const y = Math.sin(angle) * enemy.width/3;
            
            this.ctx.fillStyle = '#ffaa00';
            this.ctx.shadowColor = '#ffaa00';
            this.ctx.shadowBlur = 10;
            this.ctx.beginPath();
            this.ctx.arc(x, y, 4, 0, Math.PI * 2);
            this.ctx.fill();
        }
        
        this.ctx.fillStyle = '#ff44ff';
        this.ctx.shadowColor = '#ff44ff';
        this.ctx.shadowBlur = 20;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 8 + Math.sin(time * 5) * 2, 0, Math.PI * 2);
        this.ctx.fill();
    }

    /**
     * 绘制球形敌机
     * @param {Object} enemy - 敌机对象
     * @param {number} time - 时间参数
     */
    drawBallEnemy(enemy, time) {
        // Ball敌机 - 球形设计
        const ballGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, enemy.width/2);
        ballGradient.addColorStop(0, '#ffffff');
        ballGradient.addColorStop(0.3, enemy.color);
        ballGradient.addColorStop(0.7, enemy.secondaryColor);
        ballGradient.addColorStop(1, '#004444');
        
        this.ctx.fillStyle = ballGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, enemy.width/2, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 能量环
        this.ctx.strokeStyle = enemy.color;
        this.ctx.lineWidth = 2;
        this.ctx.shadowColor = enemy.color;
        this.ctx.shadowBlur = 15;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, enemy.width/2 + 5 + Math.sin(time * 4) * 3, 0, Math.PI * 2);
        this.ctx.stroke();
        
        // 内部能量核心
        this.ctx.fillStyle = '#ffffff';
        this.ctx.shadowColor = '#ffffff';
        this.ctx.shadowBlur = 20;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 8 + Math.sin(time * 6) * 2, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 旋转的能量点
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2 + time * 3;
            const radius = enemy.width/3;
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;
            
            this.ctx.fillStyle = enemy.color;
            this.ctx.shadowColor = enemy.color;
            this.ctx.shadowBlur = 10;
            this.ctx.beginPath();
            this.ctx.arc(x, y, 3, 0, Math.PI * 2);
            this.ctx.fill();
        }
    }

    /**
     * 绘制敌机血条
     * @param {Object} enemy - 敌机对象
     */
    drawEnemyHealthBar(enemy) {
        const healthRatio = enemy.health / enemy.maxHealth;
        
        // 背景
        this.ctx.fillStyle = 'rgba(255, 0, 0, 0.8)';
        this.ctx.fillRect(-enemy.width/2, -enemy.height/2 - 12, enemy.width, 4);
        
        // 血量
        const healthGradient = this.ctx.createLinearGradient(-enemy.width/2, 0, enemy.width/2, 0);
        healthGradient.addColorStop(0, '#ff0000');
        healthGradient.addColorStop(0.5, '#ffff00');
        healthGradient.addColorStop(1, '#00ff00');
        
        this.ctx.fillStyle = healthGradient;
        this.ctx.fillRect(-enemy.width/2, -enemy.height/2 - 12, enemy.width * healthRatio, 4);
        
        // 边框
        this.ctx.strokeStyle = '#ffffff';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(-enemy.width/2, -enemy.height/2 - 12, enemy.width, 4);
    }

    /**
     * 绘制Boss
     */
    drawBoss() {
        if (!gameState.currentBoss) return;

        this.ctx.save();
        this.ctx.translate(gameState.currentBoss.x + gameState.currentBoss.width / 2, gameState.currentBoss.y + gameState.currentBoss.height / 2);
        
        const time = Date.now() * 0.001;
        const bossData = gameState.currentBoss.bossData;
        
        // 根据Boss类型绘制不同外观
        switch (gameState.currentBoss.type) {
            case 'destroyer':
                this.drawDestroyerBoss(bossData, time);
                break;
            case 'watcher':
                this.drawWatcherBoss(bossData, time);
                break;
            case 'spider':
                this.drawSpiderBoss(bossData, time);
                break;
            case 'crystal':
                this.drawCrystalBoss(bossData, time);
                break;
            case 'flame':
                this.drawFlameBoss(bossData, time);
                break;
            default:
                this.drawDestroyerBoss(bossData, time);
                break;
        }
        
        this.ctx.restore();
    }

    /**
     * 绘制毁灭者Boss
     * @param {Object} bossData - Boss数据
     * @param {number} time - 时间参数
     */
    drawDestroyerBoss(bossData, time) {
        // 毁灭者 - 重装甲多炮管设计
        const bossGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 70);
        bossGradient.addColorStop(0, '#ffffff');
        bossGradient.addColorStop(0.2, bossData.color);
        bossGradient.addColorStop(0.6, bossData.secondaryColor);
        bossGradient.addColorStop(1, '#440000');
        
        this.ctx.fillStyle = bossGradient;
        this.ctx.fillRect(-60, -60, 120, 120);
        
        // 装甲板
        this.ctx.strokeStyle = '#666666';
        this.ctx.lineWidth = 4;
        for (let i = 0; i < 5; i++) {
            const y = -40 + (i * 20);
            this.ctx.beginPath();
            this.ctx.moveTo(-50, y);
            this.ctx.lineTo(50, y);
            this.ctx.stroke();
        }
        
        // 多重炮管
        const cannonGradient = this.ctx.createLinearGradient(0, 0, 0, 40);
        cannonGradient.addColorStop(0, '#aaaaaa');
        cannonGradient.addColorStop(1, '#333333');
        
        this.ctx.fillStyle = cannonGradient;
        // 主炮
        this.ctx.fillRect(-8, 45, 16, 35);
        // 副炮
        this.ctx.fillRect(-35, 35, 12, 40);
        this.ctx.fillRect(23, 35, 12, 40);
        this.ctx.fillRect(-50, 25, 10, 35);
        this.ctx.fillRect(40, 25, 10, 35);
        
        // 核心
        this.ctx.fillStyle = bossData.coreColor;
        this.ctx.shadowColor = bossData.coreColor;
        this.ctx.shadowBlur = 20;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 15 + Math.sin(time * 3) * 3, 0, Math.PI * 2);
        this.ctx.fill();
    }

    /**
     * 绘制监视者Boss
     * @param {Object} bossData - Boss数据
     * @param {number} time - 时间参数
     */
    drawWatcherBoss(bossData, time) {
        // 监视者 - 巨大眼球设计
        const bossGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 70);
        bossGradient.addColorStop(0, '#ffffff');
        bossGradient.addColorStop(0.3, bossData.color);
        bossGradient.addColorStop(0.7, bossData.secondaryColor);
        bossGradient.addColorStop(1, '#442200');
        
        this.ctx.fillStyle = bossGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 65, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 巨大眼球
        const eyeGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 50);
        eyeGradient.addColorStop(0, '#ffffff');
        eyeGradient.addColorStop(0.3, bossData.eyeColor);
        eyeGradient.addColorStop(0.7, bossData.secondaryColor);
        eyeGradient.addColorStop(1, '#000000');
        
        this.ctx.fillStyle = eyeGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 45, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 瞳孔
        this.ctx.fillStyle = '#000000';
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 20 + Math.sin(time * 4) * 3, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 激光发射器
        this.ctx.strokeStyle = bossData.eyeColor;
        this.ctx.lineWidth = 6;
        this.ctx.shadowColor = bossData.eyeColor;
        this.ctx.shadowBlur = 25;
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2 + time;
            const x1 = Math.cos(angle) * 50;
            const y1 = Math.sin(angle) * 50;
            const x2 = Math.cos(angle) * 70;
            const y2 = Math.sin(angle) * 70;
            
            this.ctx.beginPath();
            this.ctx.moveTo(x1, y1);
            this.ctx.lineTo(x2, y2);
            this.ctx.stroke();
        }
    }

    /**
     * 绘制蛛网王Boss
     * @param {Object} bossData - Boss数据
     * @param {number} time - 时间参数
     */
    drawSpiderBoss(bossData, time) {
        // 蛛网王 - 多触手设计
        const bossGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 40);
        bossGradient.addColorStop(0, '#ffffff');
        bossGradient.addColorStop(0.3, bossData.color);
        bossGradient.addColorStop(0.7, bossData.secondaryColor);
        bossGradient.addColorStop(1, '#220044');
        
        this.ctx.fillStyle = bossGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 35, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 触手
        this.ctx.strokeStyle = bossData.color;
        this.ctx.lineWidth = 8;
        this.ctx.shadowColor = bossData.color;
        this.ctx.shadowBlur = 15;
        
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const waveOffset = Math.sin(time * 3 + i) * 15;
            
            this.ctx.beginPath();
            this.ctx.moveTo(Math.cos(angle) * 35, Math.sin(angle) * 35);
            this.ctx.quadraticCurveTo(
                Math.cos(angle) * 50 + waveOffset,
                Math.sin(angle) * 50 + waveOffset,
                Math.cos(angle) * 80,
                Math.sin(angle) * 80
            );
            this.ctx.stroke();
            
            // 触手末端
            this.ctx.fillStyle = bossData.eyeColor;
            this.ctx.beginPath();
            this.ctx.arc(Math.cos(angle) * 80, Math.sin(angle) * 80, 6, 0, Math.PI * 2);
            this.ctx.fill();
        }
        
        // 中央核心
        this.ctx.fillStyle = bossData.eyeColor;
        this.ctx.shadowColor = bossData.eyeColor;
        this.ctx.shadowBlur = 25;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 12 + Math.sin(time * 5) * 3, 0, Math.PI * 2);
        this.ctx.fill();
    }

    /**
     * 绘制水晶核心Boss
     * @param {Object} bossData - Boss数据
     * @param {number} time - 时间参数
     */
    drawCrystalBoss(bossData, time) {
        // 水晶核心 - 几何水晶设计
        const sides = 8;
        const radius = 60;
        
        // 外层水晶
        const crystalGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
        crystalGradient.addColorStop(0, '#ffffff');
        crystalGradient.addColorStop(0.3, bossData.color);
        crystalGradient.addColorStop(0.7, bossData.secondaryColor);
        crystalGradient.addColorStop(1, 'rgba(0, 255, 255, 0.3)');
        
        this.ctx.fillStyle = crystalGradient;
        this.ctx.beginPath();
        for (let i = 0; i < sides; i++) {
            const angle = (i / sides) * Math.PI * 2 + time * 0.5;
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;
            if (i === 0) this.ctx.moveTo(x, y);
            else this.ctx.lineTo(x, y);
        }
        this.ctx.closePath();
        this.ctx.fill();
        
        // 能量护盾
        this.ctx.strokeStyle = bossData.color;
        this.ctx.lineWidth = 4;
        this.ctx.setLineDash([10, 10]);
        this.ctx.shadowColor = bossData.color;
        this.ctx.shadowBlur = 20;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 75 + Math.sin(time * 4) * 8, 0, Math.PI * 2);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
        
        // 内层水晶
        this.ctx.fillStyle = bossData.coreColor;
        this.ctx.beginPath();
        for (let i = 0; i < sides; i++) {
            const angle = (i / sides) * Math.PI * 2 - time * 0.8;
            const x = Math.cos(angle) * 30;
            const y = Math.sin(angle) * 30;
            if (i === 0) this.ctx.moveTo(x, y);
            else this.ctx.lineTo(x, y);
        }
        this.ctx.closePath();
        this.ctx.fill();
        
        // 核心光点
        this.ctx.fillStyle = '#ffffff';
        this.ctx.shadowColor = '#ffffff';
        this.ctx.shadowBlur = 30;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 8 + Math.sin(time * 6) * 2, 0, Math.PI * 2);
        this.ctx.fill();
    }

    /**
     * 绘制烈焰君主Boss
     * @param {Object} bossData - Boss数据
     * @param {number} time - 时间参数
     */
    drawFlameBoss(bossData, time) {
        // 烈焰君主 - 火焰效果设计
        const bossGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 70);
        bossGradient.addColorStop(0, '#ffffff');
        bossGradient.addColorStop(0.2, bossData.color);
        bossGradient.addColorStop(0.6, bossData.secondaryColor);
        bossGradient.addColorStop(1, '#440000');
        
        this.ctx.fillStyle = bossGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 65, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 火焰环
        for (let ring = 0; ring < 3; ring++) {
            const ringRadius = 45 + ring * 15;
            const flameCount = 12 + ring * 4;
            
            for (let i = 0; i < flameCount; i++) {
                const angle = (i / flameCount) * Math.PI * 2 + time * (1 + ring * 0.5);
                const flameLength = 15 + Math.sin(time * 4 + i) * 8;
                const x1 = Math.cos(angle) * ringRadius;
                const y1 = Math.sin(angle) * ringRadius;
                const x2 = Math.cos(angle) * (ringRadius + flameLength);
                const y2 = Math.sin(angle) * (ringRadius + flameLength);
                
                const flameGradient = this.ctx.createLinearGradient(x1, y1, x2, y2);
                flameGradient.addColorStop(0, bossData.color);
                flameGradient.addColorStop(0.5, bossData.eyeColor);
                flameGradient.addColorStop(1, 'rgba(255, 255, 0, 0)');
                
                this.ctx.strokeStyle = flameGradient;
                this.ctx.lineWidth = 4 - ring;
                this.ctx.shadowColor = bossData.color;
                this.ctx.shadowBlur = 15;
                this.ctx.beginPath();
                this.ctx.moveTo(x1, y1);
                this.ctx.lineTo(x2, y2);
                this.ctx.stroke();
            }
        }
        
        // 核心火焰
        const coreGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 30);
        coreGradient.addColorStop(0, '#ffffff');
        coreGradient.addColorStop(0.3, bossData.eyeColor);
        coreGradient.addColorStop(0.7, bossData.color);
        coreGradient.addColorStop(1, bossData.secondaryColor);
        
        this.ctx.fillStyle = coreGradient;
        this.ctx.shadowColor = bossData.color;
        this.ctx.shadowBlur = 25;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 25 + Math.sin(time * 5) * 5, 0, Math.PI * 2);
        this.ctx.fill();
    }

    /**
     * 绘制敌机子弹
     */
    drawEnemyBullets() {
        weaponManager.enemyBullets.forEach(bullet => {
            this.ctx.save();
            
            let color = '#ff6600';
            let glowColor = '#ff6600';
            
            // 根据子弹类型设置颜色
            if (bullet.isTargeted || bullet.isSniper) {
                color = '#ff0000';
                glowColor = '#ff0000';
            }
            if (bullet.isBoss) {
                color = '#ff3300';
                glowColor = '#ff3300';
            }
            if (bullet.isBall || bullet.isRadial) {
                color = '#00ffff';
                glowColor = '#00ffff';
            }
            if (bullet.isSpecial) {
                color = '#ff00ff';
                glowColor = '#ff00ff';
            }
            if (bullet.isFlame) {
                color = '#ff6600';
                glowColor = '#ffaa00';
            }
            
            if (bullet.isBall || bullet.isRadial) {
                // Ball敌机的圆形子弹
                const ballBulletGradient = this.ctx.createRadialGradient(
                    bullet.x + bullet.width/2, bullet.y + bullet.height/2, 0,
                    bullet.x + bullet.width/2, bullet.y + bullet.height/2, bullet.width/2
                );
                ballBulletGradient.addColorStop(0, '#ffffff');
                ballBulletGradient.addColorStop(0.5, color);
                ballBulletGradient.addColorStop(1, '#004444');
                
                this.ctx.fillStyle = ballBulletGradient;
                this.ctx.shadowColor = glowColor;
                this.ctx.shadowBlur = 15;
                this.ctx.beginPath();
                this.ctx.arc(bullet.x + bullet.width/2, bullet.y + bullet.height/2, bullet.width/2, 0, Math.PI * 2);
                this.ctx.fill();
            } else {
                // 普通子弹
                const bulletGradient = this.ctx.createLinearGradient(
                    bullet.x, bullet.y, 
                    bullet.x, bullet.y + bullet.height
                );
                bulletGradient.addColorStop(0, '#ffffff');
                bulletGradient.addColorStop(0.5, color);
                bulletGradient.addColorStop(1, '#440000');
                
                this.ctx.fillStyle = bulletGradient;
                this.ctx.fillRect(bullet.x, bullet.y, bullet.width, bullet.height);
                
                this.ctx.shadowColor = glowColor;
                this.ctx.shadowBlur = bullet.isBoss ? 20 : (bullet.isTargeted ? 15 : 10);
                this.ctx.fillRect(bullet.x, bullet.y, bullet.width, bullet.height);
            }
            
            this.ctx.restore();
        });
    }

    /**
     * 绘制道具
     */
    drawPowerups() {
        powerupManager.powerups.forEach(powerup => {
            this.ctx.save();
            this.ctx.translate(powerup.x + powerup.width / 2, powerup.y + powerup.height / 2);
            
            const time = Date.now() * 0.005;
            this.ctx.rotate(time);
            
            // 根据道具类型绘制不同外观和颜色
            switch (powerup.type) {
                case 'health':
                    this.drawHealthPowerup();
                    break;
                case 'power':
                    this.drawPowerPowerup();
                    break;
                case 'bomb':
                    this.drawBombPowerup();
                    break;
                case 'shield':
                    this.drawShieldPowerup();
                    break;
            }
            
            this.ctx.restore();
        });
    }

    /**
     * 绘制生命道具
     */
    drawHealthPowerup() {
        // 外圈光晕
        const outerGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 25);
        outerGradient.addColorStop(0, 'rgba(0, 255, 0, 0.8)');
        outerGradient.addColorStop(0.7, 'rgba(0, 255, 0, 0.3)');
        outerGradient.addColorStop(1, 'rgba(0, 255, 0, 0)');
        
        this.ctx.fillStyle = outerGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 22, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 主体
        const healthGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 18);
        healthGradient.addColorStop(0, '#ffffff');
        healthGradient.addColorStop(0.5, '#00ff00');
        healthGradient.addColorStop(1, '#008800');
        
        this.ctx.fillStyle = healthGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 18, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 十字标记
        this.ctx.fillStyle = '#ffffff';
        this.ctx.shadowColor = '#00ff00';
        this.ctx.shadowBlur = 20;
        this.ctx.fillRect(-14, -3, 28, 6);
        this.ctx.fillRect(-3, -14, 6, 28);
    }

    /**
     * 绘制火力道具
     */
    drawPowerPowerup() {
        // 外圈光晕
        const outerGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 25);
        outerGradient.addColorStop(0, 'rgba(255, 165, 0, 0.8)');
        outerGradient.addColorStop(0.7, 'rgba(255, 165, 0, 0.3)');
        outerGradient.addColorStop(1, 'rgba(255, 165, 0, 0)');
        
        this.ctx.fillStyle = outerGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 22, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 主体
        const powerGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 18);
        powerGradient.addColorStop(0, '#ffffff');
        powerGradient.addColorStop(0.5, '#ffa500');
        powerGradient.addColorStop(1, '#ff6600');
        
        this.ctx.fillStyle = powerGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 18, 0, Math.PI * 2);
        this.ctx.fill();
        
        // P标记
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = 'bold 18px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.shadowColor = '#ffa500';
        this.ctx.shadowBlur = 25;
        this.ctx.fillText('P', 0, 6);
    }

    /**
     * 绘制炸弹道具
     */
    drawBombPowerup() {
        // 外圈光晕
        const outerGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 25);
        outerGradient.addColorStop(0, 'rgba(255, 68, 68, 0.8)');
        outerGradient.addColorStop(0.7, 'rgba(255, 68, 68, 0.3)');
        outerGradient.addColorStop(1, 'rgba(255, 68, 68, 0)');
        
        this.ctx.fillStyle = outerGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 22, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 主体
        const bombGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 18);
        bombGradient.addColorStop(0, '#ffffff');
        bombGradient.addColorStop(0.5, '#ff4444');
        bombGradient.addColorStop(1, '#cc0000');
        
        this.ctx.fillStyle = bombGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 18, 0, Math.PI * 2);
        this.ctx.fill();
        
        // B标记
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = 'bold 18px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.shadowColor = '#ff4444';
        this.ctx.shadowBlur = 25;
        this.ctx.fillText('B', 0, 6);
    }

    /**
     * 绘制护盾道具
     */
    drawShieldPowerup() {
        // 外圈光晕
        const outerGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 25);
        outerGradient.addColorStop(0, 'rgba(0, 191, 255, 0.8)');
        outerGradient.addColorStop(0.7, 'rgba(0, 191, 255, 0.3)');
        outerGradient.addColorStop(1, 'rgba(0, 191, 255, 0)');
        
        this.ctx.fillStyle = outerGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 22, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 主体
        const shieldGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, 18);
        shieldGradient.addColorStop(0, '#ffffff');
        shieldGradient.addColorStop(0.5, '#00bfff');
        shieldGradient.addColorStop(1, '#0088cc');
        
        this.ctx.fillStyle = shieldGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, 18, 0, Math.PI * 2);
        this.ctx.fill();
        
        // S标记
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = 'bold 18px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.shadowColor = '#00bfff';
        this.ctx.shadowBlur = 25;
        this.ctx.fillText('S', 0, 6);
    }

    /**
     * 绘制爆炸效果
     */
    drawExplosions() {
        weaponManager.explosions.forEach(explosion => {
            this.ctx.save();
            this.ctx.globalAlpha = explosion.opacity;
            
            // 外层爆炸
            const outerGradient = this.ctx.createRadialGradient(
                explosion.x, explosion.y, 0,
                explosion.x, explosion.y, explosion.radius
            );
            outerGradient.addColorStop(0, '#ffffff');
            outerGradient.addColorStop(0.2, '#ffff00');
            outerGradient.addColorStop(0.5, '#ffaa00');
            outerGradient.addColorStop(0.8, '#ff6600');
            outerGradient.addColorStop(1, 'rgba(255, 0, 0, 0)');
            
            this.ctx.fillStyle = outerGradient;
            this.ctx.beginPath();
            this.ctx.arc(explosion.x, explosion.y, explosion.radius, 0, Math.PI * 2);
            this.ctx.fill();
            
            // 中层爆炸
            const middleGradient = this.ctx.createRadialGradient(
                explosion.x, explosion.y, 0,
                explosion.x, explosion.y, explosion.radius * 0.7
            );
            middleGradient.addColorStop(0, '#ffffff');
            middleGradient.addColorStop(0.5, '#ffff00');
            middleGradient.addColorStop(1, 'rgba(255, 255, 0, 0)');
            
            this.ctx.fillStyle = middleGradient;
            this.ctx.beginPath();
            this.ctx.arc(explosion.x, explosion.y, explosion.radius * 0.7, 0, Math.PI * 2);
            this.ctx.fill();
            
            // 核心
            this.ctx.fillStyle = '#ffffff';
            this.ctx.shadowColor = '#ffffff';
            this.ctx.shadowBlur = 15;
            this.ctx.beginPath();
            this.ctx.arc(explosion.x, explosion.y, explosion.radius * 0.3, 0, Math.PI * 2);
            this.ctx.fill();
            
            this.ctx.restore();
        });
    }
    /**
     * 绘制黑洞（趣味模式）
     */
    drawBlackholes() {
        if (!gameState.isFunMode) return;
        
        specialEffectsManager.blackholes.forEach(blackhole => {
            this.ctx.save();
            
            const time = Date.now() * 0.001;
            
            // 绘制外围影响区域
            const outerGradient = this.ctx.createRadialGradient(
                blackhole.x, blackhole.y, blackhole.innerRadius,
                blackhole.x, blackhole.y, blackhole.radius
            );
            outerGradient.addColorStop(0, 'rgba(100, 50, 150, 0.3)');
            outerGradient.addColorStop(0.7, 'rgba(75, 0, 130, 0.2)');
            outerGradient.addColorStop(1, 'rgba(50, 0, 100, 0.1)');
            
            this.ctx.fillStyle = outerGradient;
            this.ctx.beginPath();
            this.ctx.arc(blackhole.x, blackhole.y, blackhole.radius, 0, Math.PI * 2);
            this.ctx.fill();
            
            // 黑洞中心
            const centerGradient = this.ctx.createRadialGradient(
                blackhole.x, blackhole.y, 0,
                blackhole.x, blackhole.y, blackhole.innerRadius
            );
            centerGradient.addColorStop(0, '#000000');
            centerGradient.addColorStop(0.6, '#1a0a2e');
            centerGradient.addColorStop(0.8, '#2d1b69');
            centerGradient.addColorStop(1, '#4a148c');
            
            this.ctx.fillStyle = centerGradient;
            this.ctx.beginPath();
            this.ctx.arc(blackhole.x, blackhole.y, blackhole.innerRadius, 0, Math.PI * 2);
            this.ctx.fill();
            
            // 旋转光环
            this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            this.ctx.lineWidth = 2;
            this.ctx.setLineDash([5, 5]);
            this.ctx.beginPath();
            this.ctx.arc(blackhole.x, blackhole.y, blackhole.innerRadius + 5, time, time + Math.PI);
            this.ctx.stroke();
            this.ctx.setLineDash([]);
            
            // 事件视界
            this.ctx.strokeStyle = 'rgba(255, 0, 255, 0.8)';
            this.ctx.lineWidth = 1;
            this.ctx.beginPath();
            this.ctx.arc(blackhole.x, blackhole.y, blackhole.innerRadius, 0, Math.PI * 2);
            this.ctx.stroke();
            
            // 中心奇点
            this.ctx.fillStyle = '#ffffff';
            this.ctx.shadowColor = '#ffffff';
            this.ctx.shadowBlur = 10;
            this.ctx.beginPath();
            this.ctx.arc(blackhole.x, blackhole.y, 2 + Math.sin(time * 5) * 1, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.shadowBlur = 0;
            
            this.ctx.restore();
        });
    }

    /**
     * 绘制陨石（趣味模式）
     */
    drawMeteors() {
        if (!gameState.isFunMode) return;
        
        specialEffectsManager.meteors.forEach(meteor => {
            this.ctx.save();
            
            // 绘制尾焰（不随陨石旋转）
            this.drawMeteorTrail(meteor);
            
            // 绘制陨石主体（会旋转）
            this.ctx.translate(meteor.x + meteor.width / 2, meteor.y + meteor.height / 2);
            this.ctx.rotate(meteor.rotation);
            
            // 陨石主体 - 多层次绘制
            this.drawMeteorBody(meteor);
            
            this.ctx.restore();
        });
    }

    /**
     * 绘制陨石尾焰
     * @param {Object} meteor - 陨石对象
     */
    drawMeteorTrail(meteor) {
        const centerX = meteor.x + meteor.width / 2;
        const centerY = meteor.y + meteor.height / 2;
        
        // 主尾焰
        const trailLength = 120;
        const trailWidth = 50;
        
        // 创建尾焰渐变
        const trailGradient = this.ctx.createLinearGradient(
            centerX, centerY,
            centerX, centerY - trailLength
        );
        trailGradient.addColorStop(0, 'rgba(255, 100, 0, 0.9)');
        trailGradient.addColorStop(0.3, 'rgba(255, 150, 0, 0.7)');
        trailGradient.addColorStop(0.6, 'rgba(255, 200, 50, 0.5)');
        trailGradient.addColorStop(0.8, 'rgba(255, 255, 100, 0.3)');
        trailGradient.addColorStop(1, 'rgba(255, 255, 200, 0.1)');
        
        this.ctx.fillStyle = trailGradient;
        this.ctx.beginPath();
        this.ctx.moveTo(centerX - trailWidth / 2, centerY);
        this.ctx.lineTo(centerX + trailWidth / 2, centerY);
        this.ctx.lineTo(centerX + trailWidth / 4, centerY - trailLength);
        this.ctx.lineTo(centerX - trailWidth / 4, centerY - trailLength);
        this.ctx.closePath();
        this.ctx.fill();
        
        // 内层尾焰（更亮）
        const innerTrailGradient = this.ctx.createLinearGradient(
            centerX, centerY,
            centerX, centerY - trailLength * 0.7
        );
        innerTrailGradient.addColorStop(0, 'rgba(255, 255, 255, 0.8)');
        innerTrailGradient.addColorStop(0.4, 'rgba(255, 200, 100, 0.6)');
        innerTrailGradient.addColorStop(0.8, 'rgba(255, 150, 50, 0.3)');
        innerTrailGradient.addColorStop(1, 'rgba(255, 100, 0, 0.1)');
        
        this.ctx.fillStyle = innerTrailGradient;
        this.ctx.beginPath();
        this.ctx.moveTo(centerX - trailWidth / 4, centerY);
        this.ctx.lineTo(centerX + trailWidth / 4, centerY);
        this.ctx.lineTo(centerX + trailWidth / 8, centerY - trailLength * 0.7);
        this.ctx.lineTo(centerX - trailWidth / 8, centerY - trailLength * 0.7);
        this.ctx.closePath();
        this.ctx.fill();
        
        // 火花粒子效果
        this.drawMeteorSparks(meteor);
    }

    /**
     * 绘制陨石火花
     * @param {Object} meteor - 陨石对象
     */
    drawMeteorSparks(meteor) {
        const centerX = meteor.x + meteor.width / 2;
        const centerY = meteor.y + meteor.height / 2;
        const time = Date.now() * 0.01;
        
        // 随机火花
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2 + time * 0.1;
            const distance = 15 + Math.sin(time + i) * 10;
            const sparkX = centerX + Math.cos(angle) * distance;
            const sparkY = centerY + Math.sin(angle) * distance - Math.random() * 30;
            
            const sparkSize = 2 + Math.random() * 3;
            const alpha = 0.5 + Math.random() * 0.5;
            
            this.ctx.save();
            this.ctx.globalAlpha = alpha;
            this.ctx.fillStyle = `hsl(${30 + Math.random() * 30}, 100%, ${70 + Math.random() * 30}%)`;
            this.ctx.beginPath();
            this.ctx.arc(sparkX, sparkY, sparkSize, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.restore();
        }
    }

    /**
     * 绘制陨石主体
     * @param {Object} meteor - 陨石对象
     */
    drawMeteorBody(meteor) {
        const size = meteor.width / 2;
        
        // 外层岩石纹理
        this.ctx.fillStyle = '#8B4513';
        this.ctx.beginPath();
        this.ctx.arc(0, 0, size, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 岩石裂纹和凹凸
        this.ctx.strokeStyle = '#654321';
        this.ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2;
            const startRadius = size * 0.6;
            const endRadius = size * 0.9;
            
            this.ctx.beginPath();
            this.ctx.moveTo(
                Math.cos(angle) * startRadius,
                Math.sin(angle) * startRadius
            );
            this.ctx.lineTo(
                Math.cos(angle + 0.2) * endRadius,
                Math.sin(angle + 0.2) * endRadius
            );
            this.ctx.stroke();
        }
        
        // 内层高温区域
        const innerGradient = this.ctx.createRadialGradient(0, 0, 0, 0, 0, size * 0.7);
        innerGradient.addColorStop(0, 'rgba(255, 100, 0, 0.8)');
        innerGradient.addColorStop(0.5, 'rgba(255, 50, 0, 0.6)');
        innerGradient.addColorStop(1, 'rgba(139, 69, 19, 0.3)');
        
        this.ctx.fillStyle = innerGradient;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, size * 0.7, 0, Math.PI * 2);
        this.ctx.fill();
        
        // 熔岩斑点
        this.ctx.fillStyle = '#FF4500';
        for (let i = 0; i < 5; i++) {
            const angle = (i / 5) * Math.PI * 2 + Math.sin(Date.now() * 0.001 + i) * 0.5;
            const distance = (size * 0.3) + Math.sin(Date.now() * 0.002 + i) * (size * 0.2);
            const spotSize = 3 + Math.sin(Date.now() * 0.003 + i) * 2;
            
            this.ctx.beginPath();
            this.ctx.arc(
                Math.cos(angle) * distance,
                Math.sin(angle) * distance,
                spotSize,
                0,
                Math.PI * 2
            );
            this.ctx.fill();
        }
        
        // 中心白热点
        this.ctx.fillStyle = '#FFFFFF';
        this.ctx.shadowColor = '#FFFFFF';
        this.ctx.shadowBlur = 8;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, size * 0.15, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.shadowBlur = 0;
        
        // 边缘发光效果
        this.ctx.strokeStyle = '#FF6600';
        this.ctx.lineWidth = 3;
        this.ctx.shadowColor = '#FF6600';
        this.ctx.shadowBlur = 10;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, size, 0, Math.PI * 2);
        this.ctx.stroke();
        this.ctx.shadowBlur = 0;
    }

    /**
     * 绘制UI界面
     */
    drawUI() {
        this.ctx.fillStyle = '#ffffff';
        this.ctx.font = '20px Arial';
        this.ctx.textAlign = 'left';
        
        // 分数
        this.ctx.fillText(`分数: ${gameState.score}`, 10, 30);
        
        // 生命值
        this.ctx.fillText(`生命: ${gameState.lives}`, 10, 60);
        
        // 击杀数
        this.ctx.fillText(`击杀: ${gameState.kills}`, 10, 90);
        
        // 炸弹数量
        this.ctx.fillText(`炸弹: ${gameState.bombCount}`, 10, 120);
        
        // 难度
        const difficultyName = gameConfig.getDifficultyConfig(gameState.currentDifficulty).name;
        this.ctx.fillText(`难度: ${difficultyName}`, 10, 150);
        
        // 趣味模式标识
        if (gameState.isFunMode) {
            this.ctx.fillStyle = '#ff00ff';
            this.ctx.fillText('趣味模式', 10, 180);
        }
    }
}
