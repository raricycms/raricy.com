class UIManager {
    constructor(gameEngine) {
        this.gameEngine = gameEngine;
    }

    // 重置所有模式专属 UI 元素（每帧先全部隐藏，再由各模式逻辑按需显示）
    _resetAllModeUI(allPlayers) {
        // 封锁时间（infinite 模式）
        allPlayers.forEach(({ id }) => {
            const lockEl = document.getElementById(`player${id}Lock`);
            if (lockEl) {
                lockEl.classList.remove('active');
                lockEl.style.display = 'none';
            }
        });
        // 回家倒计时（capture 模式）
        allPlayers.forEach(({ id }) => {
            const homeEl = document.getElementById(`player${id}Home`);
            if (homeEl) {
                homeEl.classList.remove('active');
                homeEl.style.display = 'none';
            }
        });
        // 昼夜时间（daynight 模式）
        const dayEl = document.getElementById('dayTimeDisplay');
        const nightEl = document.getElementById('nightTimeDisplay');
        if (dayEl) { dayEl.classList.remove('active'); dayEl.style.display = 'none'; }
        if (nightEl) { nightEl.classList.remove('active'); nightEl.style.display = 'none'; }
    }

    updateUI() {
        const engine = this.gameEngine;

        // 构建统一的"虚拟玩家列表" — 联机模式合并本地+远程，本地模式直接使用 players
        let allPlayers;
        if (engine.networkMode === 'online') {
            allPlayers = [];
            // Player 1 slot: 本地玩家
            if (engine.localPlayer) {
                allPlayers.push({
                    isLocal: true,
                    player: engine.localPlayer,
                    id: 1  // 映射到 player1 UI 元素
                });
            }
            // Player 2 slot: 第一个远程玩家
            const rpArray = Array.from(engine.remotePlayers.values());
            if (rpArray.length > 0) {
                allPlayers.push({
                    isLocal: false,
                    player: rpArray[0],
                    id: 2  // 映射到 player2 UI 元素
                });
            }
        } else {
            allPlayers = engine.players.map(p => ({
                isLocal: true,
                player: p,
                id: p.id
            }));
        }

        // 每帧先重置所有模式专属 UI，再由各模式逻辑按需显示
        this._resetAllModeUI(allPlayers);

        // 更新分数
        allPlayers.forEach(({ player, id }) => {
            const score = (engine.networkMode === 'online' && !player.score && player.score !== 0)
                ? engine.territory.calculateScore(player.id || id, engine.canvas.width, engine.canvas.height)
                : (player.score || 0);
            const scoreElement = document.getElementById(`player${id}Score`);
            const scoreTextElement = document.getElementById(`player${id}ScoreText`);
            if (scoreElement && scoreTextElement) {
                scoreElement.style.width = Math.round(score) + '%';
                scoreTextElement.textContent = Math.round(score) + '%';
            }
        });

        // 更新生命值显示
        if (engine.gameMode === 'fight' || engine.gameMode === 'survival' || engine.gameMode === 'daynight') {
            allPlayers.forEach(({ player, id }) => {
                const livesElement = document.getElementById(`player${id}Lives`);
                const livesCountElement = document.getElementById(`player${id}LivesCount`);
                if (livesElement && livesCountElement) {
                    livesElement.style.display = 'block';
                    livesCountElement.textContent = player.lives;
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
            allPlayers.forEach(({ id }) => {
                const livesElement = document.getElementById(`player${id}Lives`);
                if (livesElement) livesElement.style.display = 'none';
            });
        }

        // 更新护盾倒计时
        allPlayers.forEach(({ player, id }) => {
            const shieldElement = document.getElementById(`player${id}Shield`);
            if (shieldElement) {
                const hasShield = typeof player.hasShield === 'function'
                    ? player.hasShield()
                    : (player.shield && player.shield.active);
                if (hasShield) {
                    let remaining;
                    if (typeof player.getShieldTimeRemaining === 'function') {
                        remaining = player.getShieldTimeRemaining();
                    } else if (player.shield && typeof player.shield.getRemainingTime === 'function') {
                        remaining = Math.ceil(player.shield.getRemainingTime() / 1000);
                    } else {
                        remaining = '?';
                    }
                    shieldElement.textContent = `护盾: ${remaining}s`;
                    shieldElement.classList.add('active');
                    shieldElement.style.display = 'block';
                } else {
                    shieldElement.classList.remove('active');
                    shieldElement.style.display = 'none';
                }
            }
        });

        // 更新玩家名称显示
        allPlayers.forEach(({ player, id }) => {
            const nameElement = document.getElementById(`player${id}Name`);
            if (nameElement) {
                const displayName = player.playerName || player.name || `玩家${id}`;
                nameElement.textContent = displayName;
            }
        });

        // 更新初始栏杆倒计时
        const barrierElement = document.getElementById('initialBarrier');
        if (barrierElement) {
            if (engine.itemManager.hasInitialBarriers()) {
                const remainingTime = Math.ceil(engine.itemManager.getInitialBarrierRemainingTime() / 1000);
                barrierElement.textContent = `初始栏杆: ${remainingTime}s`;
                barrierElement.classList.add('active');
                barrierElement.style.display = 'block';
            } else {
                barrierElement.classList.remove('active');
                barrierElement.style.display = 'none';
            }
        }

        // 更新封锁时间显示（仅在infinite模式下显示）
        if (engine.gameMode === 'infinite') {
            allPlayers.forEach(({ player, id }) => {
                const lockElement = document.getElementById(`player${id}Lock`);
                if (lockElement) {
                    if (player.lockTime && Date.now() < player.lockTime) {
                        const remainingTime = Math.ceil((player.lockTime - Date.now()) / 1000);
                        lockElement.textContent = `封锁: ${remainingTime}s`;
                        lockElement.classList.add('active');
                        lockElement.style.display = 'block';
                    }
                }
            });
        }

        // 更新夺旗模式回家倒计时显示（仅在capture模式下显示）
        if (engine.gameMode === 'capture') {
            allPlayers.forEach(({ player, id }) => {
                const homeElement = document.getElementById(`player${id}Home`);
                if (homeElement) {
                    let remainingTime = 0;
                    if (engine.networkMode === 'online') {
                        // 联机模式：从服务器同步的 homeTimeRemaining 读取
                        remainingTime = player.homeTimeRemaining || 0;
                    } else if (typeof player.getHomeCountdownRemaining === 'function') {
                        remainingTime = player.getHomeCountdownRemaining();
                    }
                    if (remainingTime > 0) {
                        homeElement.textContent = `回家: ${remainingTime}s`;
                        homeElement.classList.add('active');
                        homeElement.style.display = 'block';
                    }
                }
            });
        }

        // 更新昼夜时间显示（仅在daynight模式下显示，支持联机模式）
        if (engine.gameMode === 'daynight') {
            const dayTimeElement = document.getElementById('dayTimeDisplay');
            const nightTimeElement = document.getElementById('nightTimeDisplay');
            if (dayTimeElement && nightTimeElement && engine.dayNightManager) {
                const dm = engine.dayNightManager;
                // 联机模式下 currentTime 已从服务器同步，本地方法可正常工作
                const dayTimeRemaining = dm.getDayTimeRemaining();
                const nightTimeRemaining = dm.getNightTimeRemaining();
                if (dayTimeRemaining >= 0) {
                    dayTimeElement.textContent = `白天: ${Math.floor(dayTimeRemaining)}s`;
                    dayTimeElement.classList.add('active');
                    dayTimeElement.style.display = 'block';
                } else {
                    dayTimeElement.classList.remove('active');
                    dayTimeElement.style.display = 'none';
                }
                if (nightTimeRemaining >= 0) {
                    nightTimeElement.textContent = `夜晚: ${Math.floor(nightTimeRemaining)}s`;
                    nightTimeElement.classList.add('active');
                    nightTimeElement.style.display = 'block';
                } else {
                    nightTimeElement.classList.remove('active');
                    nightTimeElement.style.display = 'none';
                }
            }
        }

        // 更新游戏状态
        const statusElement = document.getElementById('gameStatus');
        if (statusElement) {
            if (engine.networkMode === 'online') {
                const remaining = Math.max(0, engine.maxGameTime - engine.gameTime);
                const mins = Math.floor(remaining / 60000);
                const secs = Math.floor((remaining % 60000) / 1000);
                const ping = engine.networkManager ? engine.networkManager.getPing() : 0;
                statusElement.textContent = `联机对战 - 剩余: ${mins}:${String(secs).padStart(2, '0')} | 延迟: ${ping}ms`;
            } else if (engine.gameMode === 'infinite') {
                statusElement.textContent = `无限模式 - 目标:60%领土`;
            } else {
                const remainingTime = Math.max(0, engine.maxGameTime - engine.gameTime);
                const minutes = Math.floor(remainingTime / 60000);
                const seconds = Math.floor((remainingTime % 60000) / 1000);
                if (engine.gameMode === 'fight') {
                    statusElement.textContent = `对战模式 - 剩余时间: ${minutes}:${seconds.toString().padStart(2, '0')}`;
                } else if (engine.gameMode === 'explore') {
                    statusElement.textContent = `探索模式 - 剩余时间: ${minutes}:${seconds.toString().padStart(2, '0')}`;
                } else if (engine.gameMode === 'survival') {
                    const enemyCount = engine.survivalManager.getEnemyCount();
                    statusElement.textContent = `生存模式 - 敌人数量:${enemyCount} - 剩余时间: ${minutes}:${seconds.toString().padStart(2, '0')}`;
                } else if (engine.gameMode === 'capture') {
                    const flagCounts = engine.flagManager.getFlagCounts();
                    statusElement.textContent = `夺旗模式 - P1旗帜:${flagCounts[1]} P2旗帜:${flagCounts[2]} - 剩余时间: ${minutes}:${seconds.toString().padStart(2, '0')}`;
                } else if (engine.gameMode === 'daynight') {
                    const dayNightPhase = engine.dayNightManager.getCurrentPhase();
                    const phaseText = {
                        'day': '白天', 'night': '夜晚', 'fadeToNight': '渐变夜晚', 'fadeToDay': '渐变白天'
                    }[dayNightPhase] || '未知';
                    statusElement.textContent = `昼夜模式 - 当前阶段:${phaseText} - 剩余时间: ${minutes}:${seconds.toString().padStart(2, '0')}`;
                }
            }
        }

        // FPS
        const fpsElement = document.getElementById('fpsDisplay');
        if (fpsElement) {
            fpsElement.textContent = `FPS: ${engine.fps}`;
        }
    }
}
