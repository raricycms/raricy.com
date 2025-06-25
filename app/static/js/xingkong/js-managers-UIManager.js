/**
 * UI管理类
 * 负责管理游戏界面的显示和交互
 */
class UIManager {
    constructor() {
        this.bindDifficultyEvents();
        this.createMenuStars();
        this.loadHighScores();
	this.initScrollFeatures();
        this.ensureScrollable();
    }

    /**
     * 绑定难度选择事件
     */
    bindDifficultyEvents() {
        const difficultyCards = document.querySelectorAll('.difficulty-card');
        const startButton = document.getElementById('startWithDifficulty');

        difficultyCards.forEach(card => {
            card.addEventListener('click', () => {
                difficultyCards.forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                gameState.currentDifficulty = card.dataset.difficulty;
                startButton.disabled = false;
            });
        });

        startButton.addEventListener('click', () => {
            if (!startButton.disabled) {
                gameController.startGame();
            }
        });
    }

    /**
     * 创建菜单星空背景
     */
    createMenuStars() {
        const menuStarsContainer = document.getElementById('menuStars');
        if (!menuStarsContainer) return;
        
        menuStarsContainer.innerHTML = '';
        
        // 创建静态星星
        for (let i = 0; i < 150; i++) {
            const star = document.createElement('div');
            star.className = 'star';
            star.style.position = 'absolute';
            star.style.left = Math.random() * 100 + '%';
            star.style.top = Math.random() * 100 + '%';
            star.style.width = Math.random() * 3 + 1 + 'px';
            star.style.height = star.style.width;
            star.style.background = 'white';
            star.style.borderRadius = '50%';
            star.style.animationDelay = Math.random() * 2 + 's';
            menuStarsContainer.appendChild(star);
        }
        
        // 创建流星
        for (let i = 0; i < 5; i++) {
            const shootingStar = document.createElement('div');
            shootingStar.className = 'shooting-star';
            shootingStar.style.left = Math.random() * 100 + '%';
            shootingStar.style.top = Math.random() * 100 + '%';
            shootingStar.style.animationDelay = Math.random() * 3 + 's';
            shootingStar.style.animationDuration = (Math.random() * 2 + 2) + 's';
            menuStarsContainer.appendChild(shootingStar);
        }
        
        // 创建星云
        for (let i = 0; i < 3; i++) {
            const nebula = document.createElement('div');
            nebula.className = 'nebula';
            nebula.style.position = 'absolute';
            nebula.style.left = Math.random() * 100 + '%';
            nebula.style.top = Math.random() * 100 + '%';
            nebula.style.width = Math.random() * 200 + 100 + 'px';
            nebula.style.height = nebula.style.width;
            
            const colors = ['rgba(74, 144, 226, 0.3)', 'rgba(255, 100, 100, 0.3)', 'rgba(100, 255, 100, 0.3)', 'rgba(255, 100, 255, 0.3)'];
            nebula.style.background = colors[Math.floor(Math.random() * colors.length)];
            nebula.style.animationDelay = Math.random() * 8 + 's';
            nebula.style.animationDuration = (Math.random() * 4 + 6) + 's';
            menuStarsContainer.appendChild(nebula);
        }
    }

    /**
     * 加载历史最高分
     */
    loadHighScores() {
        try {
            const saved = localStorage.getItem('starFighterHighScores');
            if (saved) {
                gameState.highScores = JSON.parse(saved);
            }
        } catch (e) {
            console.log('无法加载历史最高分');
        }
        this.updateHighScoreDisplay();
    }

    /**
     * 保存历史最高分
     */
    saveHighScores() {
        try {
            localStorage.setItem('starFighterHighScores', JSON.stringify(gameState.highScores));
        } catch (e) {
            console.log('无法保存历史最高分');
        }
    }

    /**
     * 更新历史最高分显示
     */
    updateHighScoreDisplay() {
        document.getElementById('highScoreEasy').textContent = Math.floor(gameState.highScores.easy).toLocaleString();
        document.getElementById('highScoreNormal').textContent = Math.floor(gameState.highScores.normal).toLocaleString();
        document.getElementById('highScoreHard').textContent = Math.floor(gameState.highScores.hard).toLocaleString();
        document.getElementById('highScoreNightmare').textContent = Math.floor(gameState.highScores.nightmare).toLocaleString();
        document.getElementById('highScoreFun').textContent = Math.floor(gameState.highScores.fun).toLocaleString();
        document.getElementById('highScoreDual').textContent = Math.floor(gameState.highScores.dual).toLocaleString();
    }

    /**
     * 检查并更新最高分
     * @returns {boolean} 是否创造新纪录
     */
    checkHighScore() {
        const currentScore = Math.floor(gameState.score);
        let isNewRecord = false;
        
        if (currentScore > gameState.highScores[gameState.currentDifficulty]) {
            gameState.highScores[gameState.currentDifficulty] = currentScore;
            this.saveHighScores();
            this.updateHighScoreDisplay();
            isNewRecord = true;
        }
        
        return isNewRecord;
    }

    /**
     * 更新游戏UI
     */
    updateGameUI() {
        document.getElementById('score').textContent = Math.floor(gameState.score).toLocaleString();
        document.getElementById('kills').textContent = gameState.kills;
        document.getElementById('bossKills').textContent = gameState.bossKills;
        document.getElementById('bombCount').textContent = gameState.bombCount;
        document.getElementById('time').textContent = gameState.getGameTime();
        document.getElementById('crowns').textContent = gameState.crowns;
        document.getElementById('currentDifficulty').textContent = gameConfig.getDifficultyConfig(gameState.currentDifficulty).name;
        
        this.updateHealthBars();
    }

    /**
     * 更新血条显示
     */
    updateHealthBars() {
        if (gameState.isDualMode) {
            // 双人模式血条更新
            const healthPercent1 = Math.max(0, gameState.playerHealth) / 120 * 100;
            const healthPercent2 = Math.max(0, gameState.player2Health) / 120 * 100;
            document.getElementById('healthFillP1').style.width = healthPercent1 + '%';
            document.getElementById('healthFillP2').style.width = healthPercent2 + '%';
        } else {
            // 单人模式血条更新
            const healthPercent = Math.max(0, gameState.playerHealth) / 120 * 100;
            document.getElementById('healthFill').style.width = healthPercent + '%';
        }
    }

    /**
     * 显示难度选择界面
     */
    showDifficulty() {
        document.getElementById('introScreen').style.display = 'none';
        document.getElementById('gameOverScreen').style.display = 'none';
        document.getElementById('pauseScreen').style.display = 'none';
        document.getElementById('difficultyScreen').style.display = 'grid';
        this.updateHighScoreDisplay();
        this.createMenuStars();
    }

    /**
     * 显示游戏介绍界面
     */
    showIntro() {
        document.getElementById('difficultyScreen').style.display = 'none';
        document.getElementById('introScreen').style.display = 'flex';
    }

    /**
     * 显示游戏结束界面
     */
    showGameOver() {
        const isNewRecord = this.checkHighScore();
        
        document.getElementById('finalScore').textContent = Math.floor(gameState.score).toLocaleString();
        document.getElementById('finalKills').textContent = gameState.kills;
        document.getElementById('finalTime').textContent = gameState.getGameTime();
        document.getElementById('finalCrowns').textContent = gameState.crowns;
        document.getElementById('finalBossKills').textContent = gameState.bossKills;
        document.getElementById('finalDifficulty').textContent = gameConfig.getDifficultyConfig(gameState.currentDifficulty).name;
        
        if (isNewRecord) {
            document.getElementById('newRecordDisplay').style.display = 'flex';
        } else {
            document.getElementById('newRecordDisplay').style.display = 'none';
        }
        
        document.getElementById('gameOverScreen').style.display = 'flex';
    }

    /**
     * 退出游戏
     */
    exitGame() {
        if (confirm('确定要退出游戏吗？')) {
            window.close();
            setTimeout(() => {
                window.location.href = 'about:blank';
            }, 100);
        }
    }
 ensureScrollable() {
        const difficultyScreen = document.getElementById('difficultyScreen');
        const difficultyMain = difficultyScreen.querySelector('.difficulty-main');
        
        // 动态调整内容高度
        const adjustHeight = () => {
            const windowHeight = window.innerHeight;
            const contentHeight = difficultyMain.scrollHeight;
            
            // 如果内容高度小于窗口高度，强制增加高度
            if (contentHeight <= windowHeight) {
                difficultyMain.style.minHeight = `${windowHeight + 300}px`;
            }
        };

        // 初始调整
        adjustHeight();
        
        // 窗口大小改变时重新调整
        window.addEventListener('resize', adjustHeight);
        
        // 内容加载完成后调整
        setTimeout(adjustHeight, 100);
    }

    initScrollFeatures() {
        const difficultyScreen = document.getElementById('difficultyScreen');
        
        // 强制设置滚动容器
        difficultyScreen.style.height = '100vh';
        difficultyScreen.style.overflowY = 'auto';
        difficultyScreen.style.overflowX = 'hidden';
        
        let startY = 0;
        let scrollTop = 0;
        let isScrolling = false;

        // 触摸事件
        difficultyScreen.addEventListener('touchstart', (e) => {
            startY = e.touches[0].pageY;
            scrollTop = difficultyScreen.scrollTop;
            isScrolling = true;
        }, { passive: true });

        difficultyScreen.addEventListener('touchmove', (e) => {
            if (!isScrolling) return;
            
            const currentY = e.touches[0].pageY;
            const deltaY = startY - currentY;
            
            difficultyScreen.scrollTop = scrollTop + deltaY;
        }, { passive: true });

        difficultyScreen.addEventListener('touchend', () => {
            isScrolling = false;
        }, { passive: true });

        // 鼠标滚轮
        difficultyScreen.addEventListener('wheel', (e) => {
            e.preventDefault();
            difficultyScreen.scrollTop += e.deltaY;
        }, { passive: false });

        // 键盘支持
        document.addEventListener('keydown', (e) => {
            if (this.isScreenVisible('difficultyScreen')) {
                switch(e.key) {
                    case 'ArrowUp':
                        e.preventDefault();
                        this.smoothScroll(difficultyScreen, -100);
                        break;
                    case 'ArrowDown':
                        e.preventDefault();
                        this.smoothScroll(difficultyScreen, 100);
                        break;
                    case 'PageUp':
                        e.preventDefault();
                        this.smoothScroll(difficultyScreen, -window.innerHeight * 0.8);
                        break;
                    case 'PageDown':
                        e.preventDefault();
                        this.smoothScroll(difficultyScreen, window.innerHeight * 0.8);
                        break;
                }
            }
        });

        // 添加调试信息
        this.addScrollDebugInfo(difficultyScreen);
    }

    // 检查屏幕是否可见
    isScreenVisible(screenId) {
        const screen = document.getElementById(screenId);
        return screen && screen.style.display !== 'none';
    }

    // 添加调试信息（可选，用于测试）
    addScrollDebugInfo(container) {
        const debugInfo = document.createElement('div');
        debugInfo.style.cssText = `
            position: fixed;
            top: 10px;
            left: 10px;
            background: rgba(0,0,0,0.8);
            color: white;
            padding: 10px;
            border-radius: 5px;
            font-size: 12px;
            z-index: 9999;
            display: none;
        `;
        
        const updateDebugInfo = () => {
            debugInfo.innerHTML = `
                容器高度: ${container.clientHeight}px<br>
                内容高度: ${container.scrollHeight}px<br>
                滚动位置: ${container.scrollTop}px<br>
                可滚动: ${container.scrollHeight > container.clientHeight ? '是' : '否'}
            `;
        };

        container.addEventListener('scroll', updateDebugInfo);
        window.addEventListener('resize', updateDebugInfo);
        updateDebugInfo();

        document.body.appendChild(debugInfo);

        // 按F12显示/隐藏调试信息
        document.addEventListener('keydown', (e) => {
            if (e.key === 'F12') {
                e.preventDefault();
                debugInfo.style.display = debugInfo.style.display === 'none' ? 'block' : 'none';
            }
        });
    }

    smoothScroll(element, deltaY) {
        const start = element.scrollTop;
        const target = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, start + deltaY));
        const duration = 300;
        const startTime = performance.now();

        const animateScroll = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            const easeInOutCubic = progress < 0.5 
                ? 4 * progress * progress * progress 
                : 1 - Math.pow(-2 * progress + 2, 3) / 2;
            
            element.scrollTop = start + (target - start) * easeInOutCubic;
            
            if (progress < 1) {
                requestAnimationFrame(animateScroll);
            }
        };

        requestAnimationFrame(animateScroll);
    }

}
