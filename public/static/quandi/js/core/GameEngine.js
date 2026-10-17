class GameEngine {
    constructor() {
        this.width = Config.CANVAS.canvas.width;
        this.height = Config.CANVAS.canvas.height;
        this.players = [];
        this.territory = new Territory();
        this.gameState = 'menu';
        this.gameMode = 'explore';
        this.difficulty = 'medium';
        this.gameTime = 0;
        this.maxGameTime = Config.DIFFICULTY_LEVELS.medium.maxTime;
        this.lastUpdate = 0;
        this.P1_startX = Config.CANVAS.P1_startpoint.x * this.width;
        this.P1_startY = Config.CANVAS.P1_startpoint.y * this.height;
        this.P2_startX = Config.CANVAS.P2_startpoint.x * this.width;
        this.P2_startY = Config.CANVAS.P2_startpoint.y * this.height;

        // 倒计时相关
        this.countdown = 0;
        this.countdownActive = false;

        // 物理帧相关设置
        this.PHYSICS_FPS = Config.PHYSICS_SETTINGS.FPS; // 固定物理帧率
        this.PHYSICS_TIMESTEP = 1000 / this.PHYSICS_FPS;
        this.MAX_FRAME_SKIP = Config.PHYSICS_SETTINGS.MAX_FRAME_SKIP;
        this.accumulator = 0;
        this.currentTime = 0;
        this.frameCount = 0;
        this.lastFpsUpdate = 0;
        this.lastCacheCleanup = 0; // 上次清理渲染缓存的时间戳（墙上时钟）
        this.fps = 0;

        // 渲染优化相关(静态)
        this.renderFrameCount = 0;
        this.shouldRenderStatic = true;
        this.staticCanvas = null;
        this.staticCtx = null;
        this.staticNeedsUpdate = true;
        this.territoryChanged = false;

        // 渲染优化相关(动态)
        this.dynamicCanvas = null;
        this.dynamicCtx = null;
        this.dynamicNeedsUpdate = true;

        // 其他相关
        this.flagManager = new FlagManager(this.width, this.height);
        this.survivalManager = new SurvivalManager(this.width, this.height);
        this.dayNightManager = new DayNightManager(this.width, this.height);
        this.uiUpdater = new UIManager(this);

        // ─── 联机模式相关 ─────────────────────────────────
        this.networkMode = 'local';       // 'local' | 'online'
        this.networkManager = null;       // NetworkManager 实例
        this.localPlayerId = null;        // 本地玩家在房间中的 playerId
        this.localPlayer = null;          // 本地玩家引用 (Player)
        this.remotePlayers = new Map();   // playerId → RemotePlayer
        this.isServerAuthoritative = false;
        this.serverFrame = 0;
        this.lastInputTime = 0;
        this.stopGameLoop = false;        // 停止游戏循环标志
    }

    init(canvas) {
        this.canvas = canvas;
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.ctx = canvas.getContext('2d');
        this.renderer = new Renderer(canvas);
        this.itemManager = new ItemManager(canvas, this.flagManager);
        this.itemManager.init();

        // 创建领土渲染的离屏画布
        this.territoryCanvas = document.createElement('canvas');
        this.territoryCanvas.width = this.width;
        this.territoryCanvas.height = this.height;
        this.territoryCtx = this.territoryCanvas.getContext('2d');
        this.territoryRenderer = new Renderer(this.territoryCanvas);

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
            new Player(1, this.P1_startX, this.P1_startY, Config.UI_STYLES.playerColors.player1, {
                up: Config.KEY_BINDINGS.player1.up,
                down: Config.KEY_BINDINGS.player1.down,
                left: Config.KEY_BINDINGS.player1.left,
                right: Config.KEY_BINDINGS.player1.right,
                startX: this.P1_startX
            }, this.canvas),
            new Player(2, this.P2_startX, this.P2_startY, Config.UI_STYLES.playerColors.player2, {
                up: Config.KEY_BINDINGS.player2.up,
                down: Config.KEY_BINDINGS.player2.down,
                left: Config.KEY_BINDINGS.player2.left,
                right: Config.KEY_BINDINGS.player2.right,
                startX: this.P2_startX
            }, this.canvas)
        ];

        this.setDifficulty(this.difficulty);

    }

    // ─── 联机模式初始化 ────────────────────────────────────
    initOnline(canvas, networkManager, localPlayerId) {
        this.canvas = canvas;
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        this.ctx = canvas.getContext('2d');
        this.renderer = new Renderer(canvas);
        this.itemManager = new ItemManager(canvas, this.flagManager);
        this.itemManager.init();

        // 创建离屏画布
        this.territoryCanvas = document.createElement('canvas');
        this.territoryCanvas.width = this.width;
        this.territoryCanvas.height = this.height;
        this.territoryCtx = this.territoryCanvas.getContext('2d');
        this.territoryRenderer = new Renderer(this.territoryCanvas);

        this.staticCanvas = document.createElement('canvas');
        this.staticCanvas.width = this.width;
        this.staticCanvas.height = this.height;
        this.staticCtx = this.staticCanvas.getContext('2d');
        this.staticRenderer = new Renderer(this.staticCanvas);

        this.dynamicCanvas = document.createElement('canvas');
        this.dynamicCanvas.width = this.width;
        this.dynamicCanvas.height = this.height;
        this.dynamicCtx = this.dynamicCanvas.getContext('2d');
        this.dynamicRenderer = new Renderer(this.dynamicCanvas);

        // 设置联机模式
        this.networkMode = 'online';
        this.networkManager = networkManager;
        this.localPlayerId = localPlayerId;
        this.isServerAuthoritative = true;

        // 联机模式默认使用对战模式的碰撞规则
        this.gameMode = 'fight';

        // 创建输入处理器（联机单玩家模式）
        this.inputHandler = new InputHandler(this);
    }

    // ─── 联机模式：设置本地玩家 ──────────────────────────────
    setupOnlinePlayers(gameStartData) {
        const players = gameStartData.players;
        const gameConfig = gameStartData.gameConfig;

        this.difficulty = gameConfig.difficulty;
        this.maxGameTime = Config.DIFFICULTY_LEVELS[this.difficulty].maxTime;

        // 设置难度参数
        const diffSettings = Config.DIFFICULTY_LEVELS[this.difficulty];

        // 创建本地玩家
        const myData = players.find(p => p.id === this.localPlayerId);
        if (myData) {
            const spawnX = myData.slotIndex === 0 ? this.P1_startX :
                           myData.slotIndex === 1 ? this.P2_startX :
                           myData.slotIndex === 2 ? 0.5 * this.width :
                           0.5 * this.height;
            const spawnY = myData.slotIndex === 0 ? this.P1_startY :
                           myData.slotIndex === 1 ? this.P2_startY :
                           myData.slotIndex === 2 ? 0.15 * this.height :
                           0.85 * this.height;

            // 为本地玩家使用默认 WASD 按键
            const keyConfig = Config.KEY_BINDINGS.player1;
            this.localPlayer = new Player(
                myData.slotIndex + 1,
                spawnX,
                spawnY,
                myData.color,
                { ...keyConfig, startX: spawnX },
                this.canvas
            );
            this.localPlayer.speed = diffSettings.speed;
            this.localPlayer.trailLength = diffSettings.Length;
            this.localPlayer.id = myData.id; // Override id with server id
            this.localPlayer.lives = Config.GAME_MODES[gameConfig.mode].lives;
            this.localPlayer.playerName = myData.name;

            // Replace players array: only local player
            this.players = [this.localPlayer];
        }

        // Create RemotePlayers for other players
        for (const pData of players) {
            if (pData.id === this.localPlayerId) continue;
            const rp = new RemotePlayer(pData);
            this.remotePlayers.set(pData.id, rp);
        }
    }

    setgamemode(mode) {
        this.gameMode = mode;
        const settings = Config.GAME_MODES;
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
        } else if (mode === 'daynight') {
            this.dayNightManager.init();
        }
        this.staticNeedsUpdate = true; // 模式改变时需要更新静态元素
    }

    setDifficulty(level) {
        this.difficulty = level;

        const settings = Config.DIFFICULTY_LEVELS;
        const setting = settings[level];
        this.maxGameTime = setting.maxTime;

        if (this.players) {
            this.players.forEach(player => {
                player.speed = setting.speed;
                player.trailLength = setting.Length;
                player.standarddistance = Config.PLAYER_DEFAULTS.standarddistance;
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

        // 重置模式特定的管理器
        if (this.gameMode === 'survival' && this.survivalManager) {
            this.survivalManager.reset();
        } else if (this.gameMode === 'capture' && this.flagManager) {
            this.flagManager.init();
        } else if (this.gameMode === 'daynight' && this.dayNightManager) {
            this.dayNightManager.reset();
        }

        this.timer = 0;

        // 清空领土离屏画布
        if (this.territoryCtx) {
            this.territoryCtx.clearRect(0, 0, this.width, this.height);
        }
        this.territoryChanged = true;

        this.gameLoop();
    }

    restart() {
        // 联机模式下不允许本地重启，直接返回
        if (this.networkMode === 'online') {
            console.log('[GameEngine] 联机模式下不支持本地重启');
            return;
        }
        this.gameState = 'menu';
        setTimeout(() => {
            this.start();
        }, 100);
    }

    gameLoop() {
        if (this.stopGameLoop) return;  // 已被外部停止
        if (this.gameState !== 'playing' && this.gameState !== 'countdown' && this.gameState !== 'paused') return;

        const newTime = performance.now();
        const frameTime = Math.min(newTime - this.currentTime, 250); // 限制最大帧时间为250ms
        this.currentTime = newTime;

        // ─── 联机模式：每帧必须处理服务器状态，否则会死锁 ───
        if (this.networkMode === 'online') {
            this.processOnlineState();

            // 倒计时阶段：本地递减（服务器在此期间不广播状态）
            if (this.gameState === 'countdown') {
                this.countdown -= frameTime / 1000;
                if (this.countdown < 0) this.countdown = 0;
            }

            // 检查是否已从 countdown 过渡到 playing
            if (this.gameState === 'playing') {
                this.accumulator += frameTime;
                let updateCount = 0;
                while (this.accumulator >= this.PHYSICS_TIMESTEP && updateCount < this.MAX_FRAME_SKIP) {
                    this.fixedUpdate(this.PHYSICS_TIMESTEP);
                    this.accumulator -= this.PHYSICS_TIMESTEP;
                    updateCount++;
                }
            }

            // 联机模式下每帧都需要重绘动态层（远程玩家插值位置随时变化）
            this.dynamicNeedsUpdate = true;

            this.render(0);
            this.updateFPS();
            requestAnimationFrame(() => this.gameLoop());
            return;
        }

        // ─── 本地模式：原有逻辑不变 ───────────────────────
        // 只有在非暂停状态下才累积时间
        if (this.gameState !== 'paused') {
            this.accumulator += frameTime;
        }

        // 处理倒计时逻辑
        if (this.gameState === 'countdown') {
            this.countdown -= frameTime / 1000;
            if (this.countdown <= 0) {
                this.countdownActive = false;
                this.gameState = 'playing';
                this.accumulator = 0; // 重置accumulator以避免速度异常
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

        const interpolation = this.accumulator / this.PHYSICS_TIMESTEP;// 计算插值因子（用于平滑渲染）
        this.render(interpolation);// 渲染（可变帧率）
        this.updateFPS(); // 更新FPS计数（内部自增 frameCount）

        // 按墙上时钟每 1 秒清理一次过期渲染缓存（不依赖 frameCount，避免低帧率下缓存无限增长）
        const now = performance.now();
        if (now - this.lastCacheCleanup >= 1000) {
            this.renderer.cleanupExpiredCaches();
            this.lastCacheCleanup = now;
        }

        requestAnimationFrame(() => this.gameLoop());
    }

    // 固定时间步长的更新函数
    fixedUpdate(deltaTime) {
        // ─── 联机模式分支 ─────────────────────────────────
        if (this.networkMode === 'online') {
            this.updateOnline(deltaTime);
            return;
        }

        this.timer += 1;
        if (this.timer % (2 * this.PHYSICS_FPS) === 0) {
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
        } else if (this.gameMode === 'daynight' && this.dayNightManager) {
            this.dayNightManager.update(deltaTime);
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
        if (this.gameMode !== "survival") {
            this.checkCollisions();
        }

        // 检测圈地
        this.players.forEach(player => {
            const newTerritory = this.territory.detectEnclosure(player);
            if (newTerritory) {
                this.territoryChanged = true;
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

        // 检查游戏结束条件
        const alivePlayers = this.players.filter(p => p.isAlive);
        if (alivePlayers.length <= 1) {
            this.endGame();
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 联机模式方法
    // ═══════════════════════════════════════════════════════════

    // 每帧处理服务器状态（必须在 gameLoop 中每帧调用，不依赖 fixedUpdate）
    processOnlineState() {
        if (!this.networkManager) return;
        while (this.networkManager.stateBuffer.length > 0) {
            const serverState = this.networkManager.stateBuffer.shift();
            this.applyServerState(serverState);
        }
    }

    // 联机模式每帧物理更新（由 fixedUpdate 调用）
    updateOnline(deltaTime) {
        const now = Date.now();

        // 1. 发送本地输入到服务器 (60Hz) + 驱动本地方向
        if (this.localPlayer && this.localPlayer.isAlive && now - this.lastInputTime >= 33) {
            const input = this.inputHandler.getCurrentInput();
            if (input && input.direction && this.networkManager) {
                this.networkManager.sendInput(input.direction);
                // 设置方向以驱动客户端预测移动
                if (input.direction.x !== 0 || input.direction.y !== 0) {
                    this.localPlayer.setDirection(input.direction.x, input.direction.y);
                }
            }
            this.lastInputTime = now;
        }

        // 2. 客户端预测：移动本地玩家，保持 x/y 始终在轨迹最前端
        this._predictLocalPlayer(deltaTime);

        // 3. 更新本地玩家 UI 相关状态 (护盾计时器等)
        if (this.localPlayer && this.localPlayer.shield) {
            this.localPlayer.shield.update(deltaTime);
            if (!this.localPlayer.shield.isActive()) {
                this.localPlayer.shield = null;
            }
        }

        // 4. 驱动远程玩家自适应插值
        if (this.networkManager) {
            const quality = this.networkManager.getNetworkQuality();
            this.remotePlayers.forEach(rp => {
                rp.updateInterpolationDelay(quality);
                rp.smoothDelay();
            });
        }

        // 5. 昼夜模式本地更新（联机模式下也需要运行视觉效果）
        if (this.gameMode === 'daynight' && this.dayNightManager) {
            this.dayNightManager.update(deltaTime);
        }
    }

    // 客户端预测：仅处理本地玩家移动 + 轨迹采样（不含服务器权威逻辑）
    _predictLocalPlayer(deltaTime) {
        const player = this.localPlayer;
        if (!player || !player.isAlive) return;

        // 检查封锁时间
        if (player.lockTime && Date.now() < player.lockTime) return;

        // 检查速度提升是否结束
        if (player.speedBoostEndTime && Date.now() > player.speedBoostEndTime) {
            player.speedMultiplier = 1;
            player.speedBoostEndTime = null;
        }

        // 更新碰撞视觉效果
        if (player.collisionEffect && player.collisionEffect.active) {
            player.collisionEffect.elapsed = (player.collisionEffect.elapsed || 0) + deltaTime;
            if (player.collisionEffect.elapsed >= player.collisionEffect.duration) {
                player.collisionEffect.active = false;
            }
        }

        const currentSpeed = player.speed * (player.speedMultiplier || 1);

        // 确保轨迹有初始点
        if (player.trail.length === 0) {
            player.trail.push({ x: player.x, y: player.y, timestamp: Date.now() });
        }

        // 应用移动 + 轨迹采样
        if (player.direction.x !== 0 || player.direction.y !== 0) {
            const deltaSeconds = deltaTime / 1000;
            const displacement = currentSpeed * deltaSeconds * 60;

            let prevX = player.x;
            let prevY = player.y;

            player.x += player.direction.x * displacement;
            player.y += player.direction.y * displacement;

            // 边界检查
            player.x = Math.max(player.size, Math.min(this.canvas.width - player.size, player.x));
            player.y = Math.max(player.size, Math.min(this.canvas.height - player.size, player.y));

            // 轨迹插值采样（与 Player.fixedUpdate 保持一致）
            const lastPos = player.trail[player.trail.length - 1] || { x: prevX, y: prevY };
            let dx = player.x - lastPos.x;
            let dy = player.y - lastPos.y;
            let dist = Math.sqrt(dx * dx + dy * dy);

            while (dist >= player.standarddistance) {
                const ratio = player.standarddistance / dist;
                const newX = lastPos.x + dx * ratio;
                const newY = lastPos.y + dy * ratio;

                player.trail.push({ x: newX, y: newY, timestamp: Date.now() });

                dx = player.x - newX;
                dy = player.y - newY;
                dist = Math.sqrt(dx * dx + dy * dy);
                lastPos.x = newX;
                lastPos.y = newY;
            }
        }

        // 限制轨迹长度（批量裁剪，避免逐点 shift() 的 O(n²) 开销）
        if (player.trail.length > player.trailLength) {
            player.trail.splice(0, player.trail.length - player.trailLength);
        }

        // 同步 x/y 到轨迹最前端
        if (player.trail.length > 0) {
            const front = player.trail[player.trail.length - 1];
            player.x = front.x;
            player.y = front.y;
        }
    }

    // 应用服务器权威状态
    applyServerState(serverState) {
        if (!serverState || !serverState.players) return;

        // Delta 模式：分派到专门的处理方法
        if (serverState.isDelta) {
            this._applyDeltaState(serverState);
            return;
        }

        // 全量模式：原有的完整处理逻辑（首次或偶尔完整同步）
        this._applyFullState(serverState);
    }

    // Delta 状态合并
    _applyDeltaState(delta) {
        this.serverFrame = delta.frame;
        this.gameTime = delta.gameTime;
        if (delta.gameState) {
            this.gameState = delta.gameState === 'countdown' ? 'countdown' :
                             delta.gameState === 'playing' ? 'playing' : this.gameState;
        }
        this.countdown = delta.countdown || 0;

        // 合并玩家状态
        for (const dp of delta.players) {
            const isLocal = dp.id === this.localPlayerId;
            let player = isLocal ? this.localPlayer : this.remotePlayers.get(dp.id);

            if (!player) {
                // 新远程玩家
                if (!isLocal) {
                    const rp = new RemotePlayer({ id: dp.id, name: dp.name || '玩家', color: dp.color || '#888', slotIndex: dp.slotIndex || 0 });
                    this.remotePlayers.set(dp.id, rp);
                    player = rp;
                } else {
                    continue;
                }
            }

            // 本地玩家：服务器权威位置（柔和校正，避免客户端预测抖动）
            if (isLocal) {
                if (dp.x !== undefined && dp.y !== undefined) {
                    const errX = dp.x - player.x;
                    const errY = dp.y - player.y;
                    const error = Math.sqrt(errX * errX + errY * errY);
                    // 误差 > 10px 时强制校正；否则保留预测位置（更平滑）
                    if (error > 10) {
                        player.x = dp.x;
                        player.y = dp.y;
                    }
                }

                // 清理已确认输入
                if (this.networkManager && dp.lastProcessedInputSeq !== undefined) {
                    const nm = this.networkManager;
                    const serverSeq = dp.lastProcessedInputSeq;
                    nm.pendingInputs = nm.pendingInputs.filter(inp => inp.seq > serverSeq);
                    if (serverSeq > nm.lastAckedSeq) nm.lastAckedSeq = serverSeq;
                }
            } else {
                // 远程玩家：更新位置插值数据
                if (dp.x !== undefined && dp.y !== undefined) {
                    player.applyServerState(dp);
                }
                // Delta 字段覆盖（不论位置是否变化都需要处理）
                if (dp.isAlive !== undefined) player.isAlive = dp.isAlive;
                if (dp.lives !== undefined) player.lives = dp.lives;
                if (dp.score !== undefined) player.score = dp.score;
                if (dp.hasShield !== undefined) player.hasShield = dp.hasShield;
                if (dp.direction) player.direction = dp.direction;
                if (dp.homeTimeRemaining !== undefined) player.homeTimeRemaining = dp.homeTimeRemaining;
                // 轨迹：服务器始终发完整数据
                if (dp.trail !== undefined) {
                    player.renderTrail = player.isAlive ? dp.trail : [];
                }
            }

            // 共同字段合并 — 本地玩家
            if (isLocal) {
                if (dp.isAlive !== undefined) player.isAlive = dp.isAlive;
                if (dp.lives !== undefined) player.lives = dp.lives;
                if (dp.score !== undefined) player.score = dp.score;
                if (dp.direction && (dp.direction.x !== 0 || dp.direction.y !== 0)) player.direction = dp.direction;
                if (dp.trailMaxLength) player.trailLength = dp.trailMaxLength;
                if (dp.trail !== undefined) {
                    player.trail = player.isAlive ? dp.trail : [];
                // 同步 x/y 到轨迹最前端
                if (player.trail && player.trail.length > 0) {
                    player.x = player.trail[player.trail.length - 1].x;
                    player.y = player.trail[player.trail.length - 1].y;
                }
                }
                if (dp.lockTime !== undefined) {
                    player.lockTime = dp.lockTime > 0 ? Date.now() + dp.lockTime * 1000 : null;
                }
                if (dp.homeTimeRemaining !== undefined) {
                    player.homeTimeRemaining = dp.homeTimeRemaining;
                }
                if (dp.hasShield !== undefined) {
                    if (dp.hasShield && dp.shieldRemaining > 0) {
                        const remainingMs = dp.shieldRemaining * 1000;
                        if (!player.shield || !player.shield.active) {
                            player.shield = {
                                active: true, duration: remainingMs, startTime: Date.now(), pulsePhase: 0,
                                isActive() { return this.active; },
                                getRemainingTime() { return Math.max(0, this.duration - (Date.now() - this.startTime)); },
                                update(dt) { this.pulsePhase += dt * 0.01; }
                            };
                        }
                    } else if (player.shield) {
                        player.shield.active = false;
                    }
                }
                if (dp.speedActive !== undefined) {
                    if (dp.speedActive && dp.speedRemaining > 0) {
                        player.speedMultiplier = 1.5;
                        player.speedBoostEndTime = Date.now() + dp.speedRemaining * 1000;
                    } else {
                        player.speedMultiplier = 1;
                        player.speedBoostEndTime = null;
                    }
                }
            }
        }

        // 领土/道具：仅当 delta 包含时才更新
        if (delta.territories && this.territory) {
            this.territory.areas.clear();
            for (const [playerId, polygons] of Object.entries(delta.territories)) {
                this.territory.areas.set(playerId, polygons);
            }
            this.territoryChanged = true;
        }
        if (delta.items && this.itemManager) {
            this._applyItemState(delta.items);
        }

        // 模式特定状态
        if (delta.modeState) {
            this._applyModeState(delta.modeState);
        }
    }

    // 全量状态处理（与原有逻辑相同，提取为独立方法）
    _applyFullState(serverState) {
        this.serverFrame = serverState.frame;
        this.gameTime = serverState.gameTime;
        this.gameState = serverState.gameState === 'countdown' ? 'countdown' :
                        serverState.gameState === 'playing' ? 'playing' : this.gameState;
        this.countdown = serverState.countdown || 0;

        // 同步游戏模式（服务器权威）
        if (serverState.gameMode) {
            this.gameMode = serverState.gameMode;
        }

        // 处理每个玩家
        for (const pData of serverState.players) {
            if (pData.id === this.localPlayerId) {
                // ─── 本地玩家：服务器权威位置（柔和校正） ───
                if (this.localPlayer) {
                    const errX = pData.x - this.localPlayer.x;
                    const errY = pData.y - this.localPlayer.y;
                    const error = Math.sqrt(errX * errX + errY * errY);
                    // 误差 > 10px 时强制校正；否则保留预测位置
                    if (error > 10) {
                        this.localPlayer.x = pData.x;
                        this.localPlayer.y = pData.y;
                    }

                    // 清理已确认的输入
                    if (this.networkManager && pData.lastProcessedInputSeq !== undefined) {
                        const nm = this.networkManager;
                        const serverSeq = pData.lastProcessedInputSeq;
                        nm.pendingInputs = nm.pendingInputs.filter(inp => inp.seq > serverSeq);
                        if (serverSeq > nm.lastAckedSeq) nm.lastAckedSeq = serverSeq;
                    }
                    this.localPlayer.isAlive = pData.isAlive;
                    this.localPlayer.lives = pData.lives;
                    this.localPlayer.score = pData.score;
                    // 仅在服务器方向非零时覆盖（避免中断客户端预测）
                    if (pData.direction && (pData.direction.x !== 0 || pData.direction.y !== 0)) {
                        this.localPlayer.direction = pData.direction;
                    }

                    // 同步 max trail length（可能因道具而改变）
                    if (pData.trailMaxLength) {
                        this.localPlayer.trailLength = pData.trailMaxLength;
                    }

                    // 同步封锁时间（infinite模式）
                    if (pData.lockTime > 0) {
                        this.localPlayer.lockTime = Date.now() + pData.lockTime * 1000;
                    } else if (pData.lockTime === 0) {
                        this.localPlayer.lockTime = null;
                    }

                    // 同步回家倒计时（capture模式）
                    if (pData.homeTimeRemaining !== undefined) {
                        this.localPlayer.homeTimeRemaining = pData.homeTimeRemaining;
                    }

                    // 同步轨迹：服务器发完整轨迹切片，直接替换
                    if (pData.trail) {
                        if (pData.isAlive) {
                            this.localPlayer.trail = pData.trail;
                        } else {
                            this.localPlayer.trail = [];
                        }
                    }

                    // 同步 x/y 到轨迹最前端
                    if (this.localPlayer.trail && this.localPlayer.trail.length > 0) {
                        this.localPlayer.x = this.localPlayer.trail[this.localPlayer.trail.length - 1].x;
                        this.localPlayer.y = this.localPlayer.trail[this.localPlayer.trail.length - 1].y;
                    } else if (pData.x !== undefined && pData.y !== undefined) {
                        // fallback: no trail yet, use server position
                        this.localPlayer.x = pData.x;
                        this.localPlayer.y = pData.y;
                    }

                    // 同步护盾状态
                    if (pData.hasShield && pData.shieldRemaining > 0) {
                        const remainingMs = pData.shieldRemaining * 1000;
                        if (!this.localPlayer.shield || !this.localPlayer.shield.active) {
                            this.localPlayer.shield = {
                                active: true,
                                duration: remainingMs,
                                startTime: Date.now(),
                                pulsePhase: 0,
                                isActive() { return this.active; },
                                getRemainingTime() {
                                    return Math.max(0, this.duration - (Date.now() - this.startTime));
                                },
                                update(dt) { this.pulsePhase += dt * 0.01; }
                            };
                        }
                    } else {
                        if (this.localPlayer.shield) {
                            this.localPlayer.shield.active = false;
                        }
                    }

                    // 同步速度加速状态
                    if (pData.speedActive && pData.speedRemaining > 0) {
                        this.localPlayer.speedMultiplier = 1.5;
                        this.localPlayer.speedBoostEndTime = Date.now() + pData.speedRemaining * 1000;
                    } else if (!pData.speedActive) {
                        this.localPlayer.speedMultiplier = 1;
                        this.localPlayer.speedBoostEndTime = null;
                    }
                }
            } else {
                // 远程玩家：更新插值数据
                let rp = this.remotePlayers.get(pData.id);
                if (!rp) {
                    rp = new RemotePlayer({
                        id: pData.id,
                        name: pData.name || '玩家',
                        color: pData.color || '#888888',
                        slotIndex: pData.slotIndex || 0
                    });
                    this.remotePlayers.set(pData.id, rp);
                }
                // 同步服务器发来的名称（可能已更新）
                if (pData.name) {
                    rp.name = pData.name;
                }
                rp.applyServerState(pData);
            }
        }

        // 同步领土数据
        if (serverState.territories && this.territory) {
            this.territory.areas.clear();
            for (const [playerId, polygons] of Object.entries(serverState.territories)) {
                this.territory.areas.set(playerId, polygons);
            }
            this.territoryChanged = true;
        }

        // 同步道具数据
        if (serverState.items && this.itemManager) {
            this._applyItemState(serverState.items);
        }

        // 模式特定状态
        if (serverState.modeState) {
            this._applyModeState(serverState.modeState);
        }
    }

    // 共享的模式状态处理
    _applyModeState(modeState) {
        if (modeState.survival && this.survivalManager) {
            this.survivalManager.applyServerState(modeState.survival);
        }
        if (modeState.capture && this.flagManager) {
            this.flagManager.applyServerState(modeState.capture);
        }
        if (modeState.dayNight && this.dayNightManager) {
            this.dayNightManager.applyServerState(modeState.dayNight);
        }
    }

    // 共享的道具状态解析逻辑
    _applyItemState(itemsData) {
        const cfg = Config.ITEM_MANAGER_SETTINGS.powerUp;
        this.itemManager.items = (itemsData.items || []).map(i => {
            const typeConfig = cfg[i.type] || cfg.speed;
            return {
                id: i.id || ('item_' + Math.random()),
                x: i.x, y: i.y, type: i.type,
                radius: cfg.radius,
                color: typeConfig.color,
                pulseScale: 1,
                pulseTimer: 0,
                spawnTime: Date.now(),
                update(deltaTime) {
                    this.pulseTimer += deltaTime;
                    this.pulseScale = 1 + Math.sin(this.pulseTimer * 0.005) * 0.2;
                }
            };
        });
        this.itemManager.obstacles = (itemsData.obstacles || []).map((o, idx) => ({
            id: 'obs_' + idx,
            x: o.x, y: o.y,
            width: o.w || Config.ITEM_MANAGER_SETTINGS.barrier.width,
            height: o.h || Config.ITEM_MANAGER_SETTINGS.barrier.height,
            spawnTime: Date.now()
        }));
        if (itemsData.initialBarriers !== undefined) {
            if (itemsData.initialBarriers.length > 0) {
                this.itemManager.initialBarriers = itemsData.initialBarriers.map((b, idx) => ({
                    id: 'initBarrier_' + idx,
                    x: b.x, y: b.y,
                    width: b.w || Config.ITEM_MANAGER_SETTINGS.barrier.width,
                    height: b.h || Config.ITEM_MANAGER_SETTINGS.barrier.height
                }));
            } else {
                this.itemManager.initialBarriers = [];
            }
        }
        this.staticNeedsUpdate = true;
    }

    checkCollisions() {
        for (let i = 0; i < this.players.length; i++) {
            const player = this.players[i];
            if (!player.isAlive) continue;

            // 检查与其他玩家轨迹的碰撞
            for (let j = 0; j < this.players.length; j++) {
                if (i === j) continue;
                const otherPlayer = this.players[j];

                // 只扫描一次对方轨迹，再按碰撞类型分发（原实现重复调用了两次全轨迹扫描）
                const collisionType = player.checkCollisionWithTrail(otherPlayer.trail, otherPlayer);

                if (collisionType === 'head-collision') {
                    if (this.gameMode === 'explore') {
                        player.die('与玩家头部碰撞');
                        otherPlayer.die('与玩家头部碰撞');
                        break;
                    } else if (this.gameMode === 'fight' || this.gameMode === 'infinite' || this.gameMode === 'daynight') {
                        otherPlayer.die('与玩家头部碰撞');
                        player.die('与玩家头部碰撞');
                        break;
                    }
                } else if (collisionType === 'trail-collision') {
                    if (this.gameMode === 'explore') {
                        player.die('碰撞到玩家轨迹');
                        break
                    } else if (this.gameMode === 'fight' || this.gameMode === 'infinite' || this.gameMode === 'daynight') {
                        otherPlayer.die('碰撞到玩家轨迹');
                        break;
                    }
                }

                // 检查与其他玩家领土的碰撞
                const otherTerritories = this.territory.getPlayerTerritories(otherPlayer.id);
                if (!player.canEnterEnemyTerritory()) {
                    if (player.checkCollisionWithTerritory(otherTerritories)) {
                        player.die('碰撞到玩家领土');
                        break;
                    }
                }
            }
        }
    }

    // 渲染领土
    renderTerritory() {
        if (!this.territoryChanged) return;
        this.territoryCtx.clearRect(0, 0, this.width, this.height);

        // 渲染本地玩家领土
        this.players.forEach(player => {
            const territories = this.territory.getPlayerTerritories(player.id);
            if (territories && territories.length > 0) {
                this.territoryRenderer.drawTerritories(territories, player.id, player.color);
            }
        });

        // 渲染远程玩家领土
        if (this.networkMode === 'online') {
            this.remotePlayers.forEach((rp, playerId) => {
                const territories = this.territory.getPlayerTerritories(playerId);
                if (territories && territories.length > 0) {
                    this.territoryRenderer.drawTerritories(territories, playerId, rp.color);
                }
            });
        }

        this.territoryChanged = false;
    }

    // 渲染静态元素到离屏画布
    renderStaticElements() {
        // 清空静态画布
        this.staticCtx.clearRect(0, 0, this.width, this.height);

        // 绘制生成点
        this.players.forEach(player => {
            this.staticRenderer.drawSpawnPoint(player.startX, player.startY, player.color);
        });

        // 联机模式：绘制远程玩家生成点
        if (this.networkMode === 'online') {
            this.remotePlayers.forEach(rp => {
                const spawnX = rp.slotIndex === 0 ? this.P1_startX : this.P2_startX;
                const spawnY = rp.slotIndex === 0 ? this.P1_startY : this.P2_startY;
                this.staticRenderer.drawSpawnPoint(spawnX, spawnY, rp.color);
            });
        }

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

        // 渲染远程玩家轨迹
        if (this.networkMode === 'online') {
            this.remotePlayers.forEach(rp => {
                if (rp.renderTrail && rp.renderTrail.length > 0) {
                    this.dynamicRenderer.drawTrail(rp.renderTrail, rp.color);
                }
            });
        }

        // 渲染玩家（在轨迹上方）
        this.players.forEach(player => {
            this.dynamicRenderer.drawPlayer(player);
        });

        // 渲染远程玩家
        if (this.networkMode === 'online') {
            this.remotePlayers.forEach(rp => {
                this.dynamicRenderer.drawRemotePlayer(rp);
            });
        }

        // 渲染AI敌人
        if (this.gameMode === 'survival') {
            this.survivalManager.render(this.dynamicCtx);
        }

        this.dynamicNeedsUpdate = false;
    }

    render(interpolation = 0) {
        // 先更新各层画布内容
        this.renderFrameCount++;
        this.shouldRenderStatic = (this.renderFrameCount % 3 === 0) || this.staticNeedsUpdate;
        this.shouldRenderDynamic = this.dynamicNeedsUpdate;

        // 更新领土层
        this.renderTerritory();
        // 更新动态层
        if (this.shouldRenderDynamic) {
            this.renderDynamicElements(interpolation);
        }
        // 更新静态层
        if (this.shouldRenderStatic) {
            this.renderStaticElements();
        }

        // 将各层合成到主画布
        this.renderer.clear();
        this.ctx.drawImage(this.territoryCanvas, 0, 0); // 第一层：绘制领土
        this.ctx.drawImage(this.staticCanvas, 0, 0);    // 第二层：绘制出生点/道具/障碍物/旗帜
        this.ctx.drawImage(this.dynamicCanvas, 0, 0);   // 第三层：绘制动态元素（轨迹+坦克+AI，位于出生点/旗帜上方）

        // 如果处于倒计时状态，绘制倒计时界面
        if (this.gameState === 'countdown') {
            if (this.countdownActive) {
                this.renderer.drawCountdown(this.countdown);
            } else if (this.networkMode === 'online') {
                // 联机模式：显示服务器同步的倒计时
                this.renderer.drawCountdown(this.countdown);
            }
        }

        // 更新UI（每帧都更新，因为包含实时信息）
        if (this.uiUpdater) {
            this.uiUpdater.updateUI();
        }

        // 渲染昼夜循环效果（最上层）
        if (this.gameMode === 'daynight' && this.dayNightManager) {
            this.dayNightManager.render(this.ctx);
        }
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

    pause() {
        // 联机模式：禁止暂停
        if (this.networkMode === 'online') return;
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
