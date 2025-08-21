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
        this.P1_startX = 0.15 * this.width;
        this.P1_startY = 0.5 * this.height;
        this.P2_startX = 0.85 * this.width;
        this.P2_startY = 0.5 * this.height;
        this.gameMode = 'explore';

        // 倒计时相关
        this.countdown = 0; // 倒计时秒数
        this.countdownActive = false; // 倒计时是否激活

        // 物理帧相关设置
        this.PHYSICS_FPS = 60; // 固定物理帧率
        this.PHYSICS_TIMESTEP = 1000 / this.PHYSICS_FPS; // 每个物理帧的时间（毫秒）
        this.MAX_FRAME_SKIP = 5; // 最大跳帧数，防止死循环
        this.accumulator = 0; // 时间累积器
        this.currentTime = 0;
        this.frameCount = 0;
        this.lastFpsUpdate = 0;
        this.fps = 0;

        // 渲染优化相关
        this.renderFrameCount = 0; // 渲染帧计数器
        this.shouldRenderStatic = true; // 是否应该渲染静态元素
        this.staticCanvas = null; // 静态元素的离屏画布
        this.staticCtx = null; // 静态元素的绘制上下文
        this.staticNeedsUpdate = true; // 静态元素是否需要更新

        // 动态元素相关
        this.dynamicCanvas = null; // 动态元素的离屏画布（轨迹 + 玩家）
        this.dynamicCtx = null; // 动态元素的绘制上下文
        this.dynamicNeedsUpdate = true; // 动态元素是否需要更新

        this.flagManager = new FlagManager(this.width, this.height);
        this.survivalManager = new SurvivalManager(this.width, this.height);
    }

    init(canvas) {
        this.canvas = canvas;
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.ctx = canvas.getContext('2d');
        this.renderer = new Renderer(canvas);
        this.itemManager = new ItemManager(canvas, this.flagManager);
        this.itemManager.init();

        // 创建静态元素的离屏画布
        this.staticCanvas = document.createElement('canvas');
        this.staticCanvas.width = this.width;
        this.staticCanvas.height = this.height;
        this.staticCtx = this.staticCanvas.getContext('2d');
        this.staticRenderer = new Renderer(this.staticCanvas);

        // 创建动态元素的离屏画布（轨迹 + 玩家）
        this.dynamicCanvas = document.createElement('canvas');
        this.dynamicCanvas.width = this.width;
        this.dynamicCanvas.height = this.height;
        this.dynamicCtx = this.dynamicCanvas.getContext('2d');
        this.dynamicRenderer = new Renderer(this.dynamicCanvas);

        // 创建玩家
        this.players = [
            new Player(1, this.P1_startX, this.P1_startY, '#E6194B', {
                up: 'KeyW',
                down: 'KeyS',
                left: 'KeyA',
                right: 'KeyD',
                startX: this.P1_startX
            }, this.canvas),
            new Player(2, this.P2_startX, this.P2_startY, '#0047AB', {
                up: 'ArrowUp',
                down: 'ArrowDown',
                left: 'ArrowLeft',
                right: 'ArrowRight',
                startX: this.P2_startX
            }, this.canvas)
        ];

        this.setDifficulty(this.difficulty);
    }

    setgamemode(mode) {
        this.gameMode = mode;
        const settings = {
            explore: { lives: 1 },
            fight: { lives: 3 },
            infinite: { lives: 2 },
            survival: { lives: 3 },
            capture: { lives: 1 }
        };
        const setting = settings[mode];
        if (this.players) {
            this.players.forEach(player => {
                player.lives = setting.lives;
            });
        }
        if (mode === 'survival') {
            this.survivalManager.init();
            this.survivalManager.setDifficulty(this.difficulty);
        } else if (mode === 'capture') {
            this.flagManager.init();
        }
        this.staticNeedsUpdate = true; // 模式改变时需要更新静态元素
    }

    setDifficulty(level) {
        this.difficulty = level;
        const settings = {
            slow: { speed: 2.5, maxTime: 120000, Length: 400},
            medium: { speed: 3.5, maxTime: 100000, Length: 350},
            fast: { speed: 4, maxTime: 80000, Length: 300 },
            ultra: { speed: 6, maxTime: 80000, Length: 250 }
        };

        const setting = settings[level];
        this.maxGameTime = setting.maxTime;

        if (this.players) {
            this.players.forEach(player => {
                player.speed = setting.speed;
                player.trailLength = setting.Length;
                player.standardistant = 2;
            });
        }
        this.staticNeedsUpdate = true; // 难度改变时需要更新静态元素
    }

    setPlayerColor(playerId, color) {
        if (this.players[playerId - 1]) {
            this.players[playerId - 1].color = color;
            this.staticNeedsUpdate = true; // 颜色改变时需要更新静态元素
            this.dynamicNeedsUpdate = true; // 颜色改变时需要更新动态元素
        }
    }

    start() {
        this.setDifficulty(this.difficulty);
        this.setgamemode(this.gameMode);

        // 初始化倒计时
        this.countdown = 3; // 3秒倒计时
        this.countdownActive = true;
        this.gameState = 'countdown'; // 新增倒计时状态
        this.gameTime = 0;
        this.currentTime = performance.now();
        this.lastUpdate = this.currentTime;
        this.accumulator = 0;
        this.frameCount = 0;
        this.lastFpsUpdate = this.currentTime;
        this.renderFrameCount = 0; // 重置渲染帧计数器
        this.staticNeedsUpdate = true; // 游戏开始时需要更新静态元素
        this.dynamicNeedsUpdate = true; // 游戏开始时需要更新动态元素

        // 初始化初始栏杆的计时，但实际计时将在倒计时结束后开始
        this.itemManager.initialBarrierStartTime = Date.now();

        // 重置玩家位置
        this.players[0].reset(this.P1_startX, this.P1_startY);
        this.players[1].reset(this.P2_startX, this.P2_startY);

        // 重置领土
        this.territory.reset();
        this.itemManager.reset();
        this.timer = 0;

        this.gameLoop();
    }

    restart() {
        this.gameState = 'menu';
        setTimeout(() => {
            this.start();
        }, 100);
    }

    gameLoop() {
        if (this.gameState !== 'playing' && this.gameState !== 'countdown' && this.gameState !== 'paused') return;

        const newTime = performance.now();
        const frameTime = Math.min(newTime - this.currentTime, 250); // 限制最大帧时间为250ms
        this.currentTime = newTime;
        
        // 只有在非暂停状态下才累积时间
        if (this.gameState !== 'paused') {
            this.accumulator += frameTime;
        }

        // 处理倒计时逻辑
        if (this.gameState === 'countdown') {
            // 更新倒计时
            this.countdown -= frameTime / 1000; // 将毫秒转换为秒

            // 检查倒计时是否结束
            if (this.countdown <= 0) {
                this.countdownActive = false;
                this.gameState = 'playing'; // 倒计时结束后进入游戏状态
                this.accumulator = 0; // 重置accumulator以避免速度异常
                // 倒计时结束后重置初始栏杆的计时
                this.itemManager.initialBarrierStartTime = Date.now();
            }
        }

        // 固定时间步长的物理更新（仅在游戏状态为playing时执行）
        if (this.gameState === 'playing') {
            let updateCount = 0;
            while (this.accumulator >= this.PHYSICS_TIMESTEP && updateCount < this.MAX_FRAME_SKIP) {
                this.fixedUpdate(this.PHYSICS_TIMESTEP);
                this.accumulator -= this.PHYSICS_TIMESTEP;
                updateCount++;
            }
        }

        // 计算插值因子（用于平滑渲染）
        const interpolation = this.accumulator / this.PHYSICS_TIMESTEP;

        // 渲染（可变帧率）
        this.render(interpolation);

        // 更新FPS计数
        this.updateFPS();

        // 每隔一定帧数清理一次过期缓存
        this.frameCount++;
        if (this.frameCount % this.PHYSICS_FPS === 0) { // 例如，每60帧清理一次
            this.renderer.cleanupExpiredCaches();
        }

        requestAnimationFrame(() => this.gameLoop());
    }

    // 固定时间步长的更新函数
    fixedUpdate(deltaTime) {
        this.timer += 1;
        if (this.timer % (2*this.PHYSICS_FPS) === 0) { // 调整为物理帧的倍数 (60fps * 2 = 120)
            this.timer = 0;
        }

        this.gameTime += deltaTime;

        // 检查游戏时间 (在无限模式下不检查时间)
        if (this.gameMode !== 'infinite' && this.gameTime >= this.maxGameTime) {
            this.endGame();
            return;
        }

        // 模式特定更新
        if (this.gameMode === 'survival' && this.survivalManager) {
            this.survivalManager.update(deltaTime, this.players, this.territory);
        } else if (this.gameMode === 'capture') {
            this.flagManager.update(this.territory, this.players);
        }


        // 更新道具系统
        this.itemManager.update(deltaTime);

        // 检查道具碰撞
        this.players.forEach(player => {
            this.itemManager.checkItemCollision(player);
            this.itemManager.checkObstacleCollision(player);
        });

        // 清理过期道具
        this.itemManager.cleanup();

        // 更新玩家（传入固定的时间步长）
        this.players.forEach(player => player.fixedUpdate ? player.fixedUpdate(deltaTime) : player.update());

        // 玩家更新后，标记动态元素需要更新
        this.dynamicNeedsUpdate = true;

        // 碰撞检测
        if (this.gameMode !== "survival"){
            this.checkCollisions();
        }

        // 检测圈地
        let territoryChanged = false;
        this.players.forEach(player => {
            const newTerritory = this.territory.detectEnclosure(player);
            if (newTerritory) {
                territoryChanged = true;
                player.score = this.territory.calculateScore(player.id, this.canvas.width, this.canvas.height);

                // 在无限模式下，检查是否有玩家领土达到60%
                if (this.gameMode === 'infinite' && player.score >= 60) {
                    this.endGame();
                    return;
                }

                if (this.gameMode === 'capture') {
                    this.flagManager.checkCaptureInNewTerritory(newTerritory, player.id);
                }
            }
        });

        // 如果领土发生变化，标记静态元素需要更新
        if (territoryChanged) {
            this.staticNeedsUpdate = true;
        }

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

                if (player.checkCollisionWithTrail(otherPlayer.trail, otherPlayer) === 'head-collision') {
                    if (this.gameMode === 'explore') {
                        player.die();
                        otherPlayer.die();
                        break;
                    } else if (this.gameMode === 'fight' || this.gameMode === 'infinite') {
                        otherPlayer.die();
                        player.die();
                        break;
                    }
                } else if (player.checkCollisionWithTrail(otherPlayer.trail, otherPlayer) === 'trail-collision') {
                    if (this.gameMode === 'explore') {
                        player.die();
                        break
                    } else if (this.gameMode === 'fight' || this.gameMode === 'infinite') {
                        otherPlayer.die();
                        break;
                    }
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

    // 渲染静态元素到离屏画布
    renderStaticElements() {
        // 清空静态画布
        this.staticCtx.clearRect(0, 0, this.width, this.height);

        // 绘制生成点
        this.players.forEach(player => {
            this.staticRenderer.drawSpawnPoint(player.startX, this.P1_startY, player.color);
        });

        // 渲染领土
        this.players.forEach(player => {
            const territories = this.territory.getPlayerTerritories(player.id);
            if (territories && territories.length > 0) {
                this.staticRenderer.drawTerritories(territories, player.id, player.color);
            }
        });

        // 渲染道具和障碍物
        this.staticRenderer.drawItems(this.itemManager);

        // 渲染旗帜
        if (this.gameMode === 'capture') {
            this.flagManager.render(this.staticCtx, this.players);
        }

        this.staticNeedsUpdate = false;
    }

    // 渲染动态元素到离屏画布（轨迹 + 玩家）
    renderDynamicElements(interpolation = 0) {
        // 清空动态画布
        this.dynamicCtx.clearRect(0, 0, this.width, this.height);

        // 渲染轨迹（在玩家下方）
        this.players.forEach(player => {
            if (player.trail && player.trail.length > 0) {
                this.dynamicRenderer.drawTrail(player.trail, player.color);
            }
        });

        // 渲染玩家（在轨迹上方）
        this.players.forEach(player => {
            this.dynamicRenderer.drawPlayer(player);
        });

        // 渲染AI敌人
        if (this.gameMode === 'survival') {
            this.survivalManager.render(this.dynamicCtx);
        }

        this.dynamicNeedsUpdate = false;
    }

    // 渲染函数（支持插值和分层渲染）
    render(interpolation = 0) {
        // 清空主画布
        this.renderer.clear();

        // 第一层：绘制动态元素（轨迹 + 玩家，最底层）
        this.ctx.drawImage(this.dynamicCanvas, 0, 0);

        // 第二层：绘制静态元素（障碍物等，在动态元素之上）
        this.ctx.drawImage(this.staticCanvas, 0, 0);

        // 增加渲染帧计数器
        this.renderFrameCount++;

        // 判断是否应该更新静态元素（每2帧更新一次，或者有变化时强制更新）
        this.shouldRenderStatic = (this.renderFrameCount % 2 === 0) || this.staticNeedsUpdate;

        // 动态元素每帧都更新（因为玩家位置和轨迹都在变化）
        this.shouldRenderDynamic = this.dynamicNeedsUpdate;

        // 更新静态元素（如果需要的话）
        if (this.shouldRenderStatic) {
            this.renderStaticElements();
        }

        // 更新动态元素（每帧都更新）
        if (this.shouldRenderDynamic) {
            this.renderDynamicElements(interpolation);
        }

        // 如果处于倒计时状态，绘制倒计时界面
        if (this.gameState === 'countdown' && this.countdownActive) {
            this.renderer.drawCountdown(this.countdown);
        }

        // 更新UI（每帧都更新，因为包含实时信息）
        this.updateUI();
    }

    // FPS计算
    updateFPS() {
        this.frameCount++;
        const now = performance.now();
        if (now - this.lastFpsUpdate >= 1000) {
            this.fps = Math.round((this.frameCount * 1000) / (now - this.lastFpsUpdate));
            this.frameCount = 0;
            this.lastFpsUpdate = now;
        }
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

        // 更新生命值显示（仅在fight模式下显示）
        if (this.gameMode === 'fight' || this.gameMode === 'survival') {
            this.players.forEach(player => {
                const livesElement = document.getElementById(`player${player.id}Lives`);
                const livesCountElement = document.getElementById(`player${player.id}LivesCount`);

                if (livesElement && livesCountElement) {
                    livesElement.style.display = 'block';
                    livesCountElement.textContent = player.lives;

                    // 根据生命值改变颜色
                    if (player.lives <= 1) {
                        livesCountElement.className = 'lives-count critical';
                    } else if (player.lives <= 2) {
                        livesCountElement.className = 'lives-count warning';
                    } else {
                        livesCountElement.className = 'lives-count normal';
                    }
                }
            });
        } else {
            // 在其他模式下隐藏生命值显示
            this.players.forEach(player => {
                const livesElement = document.getElementById(`player${player.id}Lives`);
                if (livesElement) {
                    livesElement.style.display = 'none';
                }
            });
        }

        // 更新护盾倒计时
        this.players.forEach((player, index) => {
            const shieldElement = document.getElementById(`player${player.id}Shield`);
            if (shieldElement) {
                if (player.shield && player.shield.isActive()) {
                    const remainingTime = Math.ceil(player.shield.getRemainingTime() / 1000);
                    shieldElement.textContent = `护盾: ${remainingTime}s`;
                    shieldElement.classList.add('active');
                    shieldElement.style.display = 'block';
                } else {
                    shieldElement.classList.remove('active');
                    shieldElement.style.display = 'none';
                }
            }
        });

        // 更新初始栏杆倒计时
        const barrierElement = document.getElementById('initialBarrier');
        if (barrierElement) {
            if (this.itemManager.hasInitialBarriers()) {
                const remainingTime = Math.ceil(this.itemManager.getInitialBarrierRemainingTime() / 1000);
                barrierElement.textContent = `初始栏杆: ${remainingTime}s`;
                barrierElement.classList.add('active');
                barrierElement.style.display = 'block';
            } else {
                barrierElement.classList.remove('active');
                barrierElement.style.display = 'none';
            }
        }

        // 更新封锁时间显示（仅在infinite模式下显示）
        if (this.gameMode === 'infinite') {
            this.players.forEach(player => {
                const lockElement = document.getElementById(`player${player.id}Lock`);
                if (lockElement) {
                    if (player.lockTime && Date.now() < player.lockTime) {
                        const remainingTime = Math.ceil((player.lockTime - Date.now()) / 1000);
                        lockElement.textContent = `封锁: ${remainingTime}s`;
                        lockElement.classList.add('active');
                        lockElement.style.display = 'block';
                    } else {
                        lockElement.classList.remove('active');
                        lockElement.style.display = 'none';
                    }
                }
            });
        } else {
            // 在其他模式下隐藏封锁时间显示
            this.players.forEach(player => {
                const lockElement = document.getElementById(`player${player.id}Lock`);
                if (lockElement) {
                    lockElement.style.display = 'none';
                }
            });
        }
        
        // 更新夺旗模式回家倒计时显示（仅在capture模式下显示）
        if (this.gameMode === 'capture') {
            this.players.forEach(player => {
                const homeElement = document.getElementById(`player${player.id}Home`);
                if (homeElement) {
                    const remainingTime = player.getHomeCountdownRemaining();
                    if (remainingTime > 0) {
                        homeElement.textContent = `回家: ${remainingTime}s`;
                        homeElement.classList.add('active');
                        homeElement.style.display = 'block';
                    } else {
                        homeElement.classList.remove('active');
                        homeElement.style.display = 'none';
                    }
                }
            });
        } else {
            // 在其他模式下隐藏回家倒计时显示
            this.players.forEach(player => {
                const homeElement = document.getElementById(`player${player.id}Home`);
                if (homeElement) {
                    homeElement.style.display = 'none';
                }
            });
        }

        // 更新游戏状态
        const statusElement = document.getElementById('gameStatus');
        if (statusElement) {
            if (this.gameMode === 'infinite') {
                // 在无限模式下显示不同的状态信息
                statusElement.textContent = `无限模式 - 目标:60%领土`;
            } else {
                // 原有的时间显示逻辑
                const remainingTime = Math.max(0, this.maxGameTime - this.gameTime);
                const minutes = Math.floor(remainingTime / 60000);
                const seconds = Math.floor((remainingTime % 60000) / 1000);
                if (this.gameMode === 'fight') {
                    statusElement.textContent = `对战模式 - 剩余时间: ${minutes}:${seconds.toString().padStart(2, '0')}`
                }
                else if (this.gameMode === 'explore') {
                    statusElement.textContent = `探索模式 - 剩余时间: ${minutes}:${seconds.toString().padStart(2, '0')}`;
                }
                else if (this.gameMode === 'survival') {
                    const enemyCount = this.survivalManager.getEnemyCount();
                    statusElement.textContent = `生存模式 - 敌人数量:${enemyCount} - 剩余时间: ${minutes}:${seconds.toString().padStart(2, '0')}`;
                }
                else if (this.gameMode === 'capture') {
                    const flagCounts = this.flagManager.getFlagCounts();
                    statusElement.textContent = `夺旗模式 - P1旗帜:${flagCounts[1]} P2旗帜:${flagCounts[2]} - 剩余时间: ${minutes}:${seconds.toString().padStart(2, '0')}`;
                }
            }
        }

        // 可选：显示FPS信息
        const fpsElement = document.getElementById('fpsDisplay');
        if (fpsElement) {
            fpsElement.textContent = `FPS: ${this.fps}`;
        }
    }

    pause() {
        if (this.gameState === 'playing') {
            this.gameState = 'paused';
            // 记录暂停开始时间，用于初始栏杆和护盾计时
            if (this.itemManager) {
                this.itemManager.pauseStartTime = Date.now();
            }
            
            // 暂停所有玩家的护盾计时和封锁时间
            if (this.players) {
                this.players.forEach(player => {
                    if (player.shield && player.shield.isActive()) {
                        // 保存暂停时的剩余时间
                        player.shield.pausedRemainingTime = player.shield.getRemainingTime();
                        // 保存暂停开始时间
                        player.shield.pauseStartTime = Date.now();
                    }
                    
                    // 暂停玩家的封锁时间
                    if (player.lockTime && Date.now() < player.lockTime) {
                        // 保存暂停时的剩余封锁时间
                        player.pausedLockTime = player.lockTime - Date.now();
                    }
                    
                    // 暂停夺旗模式回家倒计时
                    if (this.gameMode === 'capture') {
                        player.pauseHomeCountdown();
                    }
                });
            }
        }
    }

    resume() {
        if (this.gameState === 'paused') {
            this.gameState = 'playing';
            
            // 调整初始栏杆开始时间，以补偿暂停期间的时间
            if (this.itemManager && this.itemManager.pauseStartTime) {
                const pauseDuration = Date.now() - this.itemManager.pauseStartTime;
                this.itemManager.initialBarrierStartTime += pauseDuration;
                this.itemManager.pauseStartTime = null;
            }
            
            // 恢复所有玩家的护盾计时和封锁时间
            if (this.players) {
                this.players.forEach(player => {
                    if (player.shield && player.shield.pauseStartTime) {
                        // 计算暂停持续时间
                        const pauseDuration = Date.now() - player.shield.pauseStartTime;
                        // 调整护盾开始时间，以补偿暂停期间的时间
                        player.shield.startTime += pauseDuration;
                        // 清除暂停时间记录
                        player.shield.pauseStartTime = null;
                        player.shield.pausedRemainingTime = null;
                    }
                    
                    // 恢复玩家的封锁时间
                    if (player.pausedLockTime) {
                        player.lockTime = Date.now() + player.pausedLockTime;
                        player.pausedLockTime = null;
                    }
                    
                    // 恢复夺旗模式回家倒计时
                    if (this.gameMode === 'capture') {
                        player.resumeHomeCountdown();
                    }
                });
            }
        }
    }

    endGame() {
        this.gameState = 'gameOver';

        if (this.gameMode === 'capture') {
            const result = this.flagManager.checkVictoryCondition(this.players, this.territory);
            if (result.isDraw) {
                this.showCaptureGameOver({ isDraw: true, players: result.winner }, result.scores, result.flagCounts);
                return;
            } else {
                this.showCaptureGameOver(result.winner, result.scores, result.flagCounts);
                return;
            }
        }

        const scores = this.players.map(player => ({
            id: player.id,
            score: this.territory.calculateScore(player.id, this.canvas.width, this.canvas.height),
            isAlive: player.isAlive
        }));

        const alivePlayers = scores.filter(p => p.isAlive);
        // 如果有玩家存活，他们就是潜在的获胜者；否则，所有（已死亡的）玩家都是。
        const potentialWinners = alivePlayers.length > 0 ? alivePlayers : scores;
        // 在潜在获胜者中找到最高分
        const maxScore = Math.max(...potentialWinners.map(p => p.score));
        // 找出所有达到最高分的玩家
        const winners = potentialWinners.filter(p => p.score === maxScore);
        // 根据获胜者数量，显示游戏结束界面
        if (winners.length === 1) {
            this.showGameOver(winners[0], scores);
        } else {
            this.showGameOver({ isDraw: true, players: winners }, scores);
        }
    }

    showGameOver(winner, scores) {
        const gameOverMenu = document.getElementById('gameOverMenu');
        const gameOverTitle = document.getElementById('gameOverTitle');
        const gameOverMessage = document.getElementById('gameOverMessage');

        if (winner.isDraw) {
            gameOverTitle.textContent = `平局`;
            gameOverMessage.textContent = `最终分数 - 玩家1: ${Math.round(scores[0].score)}%, 玩家2: ${Math.round(scores[1].score)}%`;
        } else {
            gameOverTitle.textContent = `玩家${winner.id}获胜！`;
            gameOverMessage.textContent = `最终分数 - 玩家1: ${Math.round(scores[0].score)}%, 玩家2: ${Math.round(scores[1].score)}%`;
        }
        gameOverMenu.classList.add('active');
    }

    showCaptureGameOver(winner, scores, flagCounts) {
        const gameOverMenu = document.getElementById('gameOverMenu');
        const gameOverTitle = document.getElementById('gameOverTitle');
        const gameOverMessage = document.getElementById('gameOverMessage');

        if (winner.isDraw) {
            gameOverTitle.textContent = `平局`;
            gameOverMessage.textContent = `最终分数 - 玩家1: ${Math.round(scores[0].score)}%, 玩家2: ${Math.round(scores[1].score)}%`;
        } else {
            gameOverTitle.textContent = `玩家${winner.id}获胜！`;
            gameOverMessage.textContent = `最终分数 - 玩家1: ${Math.round(scores[0].score)}%, 玩家2: ${Math.round(scores[1].score)}%`;
            gameOverMessage.textContent += `\n旗帜 - 玩家1: ${flagCounts[1]} 玩家2: ${flagCounts[2]}`;
        }
        gameOverMenu.classList.add('active');
    }
}

// 将游戏引擎实例暴露给全局，以便Player类可以访问
window.gameEngine = null;
