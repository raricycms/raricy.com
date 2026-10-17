class DayNightManager {
    constructor(gameWidth, gameHeight) {
        this.gameWidth = gameWidth;
        this.gameHeight = gameHeight;
        this.initialtime = Config.DAYNIGHT.initialTime;
        this.cycleTime = Config.DAYNIGHT.cycleTime;
        this.fadeTime = Config.DAYNIGHT.fadeTime;
        this.darkTime = Config.DAYNIGHT.darkTime;
        this.currentTime = 0;
        this.isNight = false;
        this.nightOpacity = 0;
        this.stars = [];
        this.moons = [];
        this.meteors = [];
        this.starTwinkleTime = 0;
        this.generateStars();
        this.generateMoons();
        this.gameMode = 'day';
        this.darkness = Config.DAYNIGHT.darkness;
        this.meteorSpawnTimer = 0;
        this.fireworks = [];
        this.fireworkSpawnTimer = 0;
    }

    init() {
        this.currentTime = 0;
        this.isNight = false;
        this.nightOpacity = 0;
    }

    generateStars() {
        this.stars = [];
        const starCount = 50;
        for (let i = 0; i < starCount; i++) {
            this.stars.push({
                x: Math.random() * this.gameWidth,
                y: Math.random() * this.gameHeight,
                size: Math.random() * 2 + 1,
                brightness: Math.random() * 0.5 + 0.5
            });
        }
    }

    generateMoons() {
        this.moons = [
            {
                x: 50,
                y: 50,
                size: 30
            },
            {
                x: this.gameWidth - 50,
                y: this.gameHeight - 50,
                size: 25
            }
        ];
    }

    update(deltaTime) {
        // 检查游戏是否处于暂停状态
        if (window.gameEngine && window.gameEngine.gameState === 'paused') {
            return;
        }

        // 联机模式：使用服务器同步的昼夜状态
        if (window.gameEngine && window.gameEngine.networkMode === 'online' && this.serverSynced) {
            this.gameMode = this.serverPhase;
            this.nightOpacity = this.serverDarkness;
        } else {
            this.currentTime += deltaTime;
            this.gameMode = this.getCurrentPhase();
        }

        if (this.gameMode !== 'day') {
            if (!this.serverSynced) {
                // 本地模式计算透明度
                if (this.gameMode === 'fadeToNight') {
                    const fadeProgress = this.getFadeProgress('fadeToNight');
                    this.nightOpacity = Math.min(this.darkness, fadeProgress * this.darkness);
                } else if (this.gameMode === 'fadeToDay') {
                    const fadeProgress = this.getFadeProgress('fadeToDay');
                    this.nightOpacity = Math.max(0, this.darkness - fadeProgress * this.darkness);
                } else {
                    this.nightOpacity = this.darkness;
                }
            }

            // 更新星星闪烁效果
            this.starTwinkleTime += deltaTime;

            // 更新流星
            this.updateMeteors(deltaTime);

            // 随机生成流星
            this.meteorSpawnTimer += deltaTime;
            if (this.meteorSpawnTimer > 1500 && this.nightOpacity > 0.5) { // 每1.5秒可能生成一个流星
                if (Math.random() < 0.5) { // 50%几率生成流星
                    this.spawnMeteor();
                }
                this.meteorSpawnTimer = 0;
            }

            // 随机生成烟花（左下角）
            this.fireworkSpawnTimer += deltaTime;
            if (this.fireworkSpawnTimer > 4000 && this.nightOpacity > 0.7) { // 每4秒可能生成烟花
                if (Math.random() < 0.7) { // 70%几率生成烟花
                    // 有概率同时生成2-3个不同颜色的烟花
                    const fireworkCount = Math.random() < 0.3 ? 3 : (Math.random() < 0.5 ? 2 : 1);
                    for (let i = 0; i < fireworkCount; i++) {
                        this.spawnFirework();
                    }
                }
                this.fireworkSpawnTimer = 0;
            }

            // 更新烟花
            this.updateFireworks(deltaTime);
        } else {
            this.isNight = false;
            this.nightOpacity = 0;
            this.meteors = []; // 白天清空流星
            this.fireworks = []; // 白天清空烟花
        }
    }

    render(ctx) {
        if (this.nightOpacity > 0) {
            // 绘制夜晚覆盖层
            ctx.save();
            ctx.fillStyle = `rgba(0, 0, 0, ${this.nightOpacity})`;
            ctx.fillRect(0, 0, this.gameWidth, this.gameHeight);

            // 绘制星星（带闪烁效果）
            if (this.nightOpacity > 0.3) {
                const starOpacity = Math.min(1, (this.nightOpacity - 0.3) / 0.5);
                this.stars.forEach(star => {
                    // 星星闪烁效果
                    const twinkleFactor = 0.2 * Math.sin(this.starTwinkleTime * 0.005 + star.x * 0.01) + 1;
                    const currentBrightness = star.brightness * twinkleFactor;

                    ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, currentBrightness) * starOpacity})`;
                    ctx.beginPath();
                    ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
                    ctx.fill();
                });
            }

            // 绘制流星
            this.renderMeteors(ctx);

            // 绘制烟花
            this.renderFireworks(ctx);

            // 绘制月亮
            if (this.nightOpacity > 0.2) {
                const moonOpacity = Math.min(1, (this.nightOpacity - 0.2) / 0.6);
                this.moons.forEach(moon => {
                    const moonImg = window.imageLoader && window.imageLoader.get('moon');
                    if (moonImg) {
                        // 精灵图内容（月亮盘+辉光）铺满，辉光外径对应原 2*size，绘制尺寸 = 2*size
                        const drawSize = moon.size * 2;
                        ctx.save();
                        ctx.globalAlpha = moonOpacity;
                        ctx.drawImage(moonImg, moon.x - drawSize / 2, moon.y - drawSize / 2, drawSize, drawSize);
                        ctx.restore();
                        return;
                    }

                    ctx.fillStyle = `rgba(255, 255, 200, ${moonOpacity})`;
                    ctx.beginPath();
                    ctx.arc(moon.x, moon.y, moon.size, 0, Math.PI * 2);
                    ctx.fill();

                    // 月亮光晕
                    const gradient = ctx.createRadialGradient(
                        moon.x, moon.y, moon.size,
                        moon.x, moon.y, moon.size * 2
                    );
                    gradient.addColorStop(0, `rgba(255, 255, 200, ${moonOpacity * 0.3})`);
                    gradient.addColorStop(1, 'rgba(255, 255, 200, 0)');
                    ctx.fillStyle = gradient;
                    ctx.beginPath();
                    ctx.arc(moon.x, moon.y, moon.size * 2, 0, Math.PI * 2);
                    ctx.fill();
                });
            }

            ctx.restore();
        }
    }

    reset() {
        this.currentTime = 0;
        this.isNight = false;
        this.nightOpacity = 0;
        this.serverSynced = false;
        this.serverPhase = null;
        this.serverElapsed = 0;
        this.serverDarkness = 0;
        this.serverSeed = 0;
    }

    // 联机模式：接收服务器权威昼夜状态
    applyServerState(dayNightData) {
        if (!dayNightData) return;
        this.serverSynced = true;
        this.serverPhase = dayNightData.phase;
        this.serverElapsed = dayNightData.elapsedInPhase;
        this.serverTotalElapsed = dayNightData.totalElapsed;
        this.serverDarkness = dayNightData.darkness;
        this.serverSeed = dayNightData.seed;
        // 同步 currentTime 使 getDayTimeRemaining / getNightTimeRemaining 能正确计算
        this.currentTime = dayNightData.totalElapsed;
    }

    getCurrentPhase() {

        const cyclingTime = this.currentTime - this.initialtime;
        const cyclingPosition = Math.floor(cyclingTime / this.cycleTime);
        const cyclingDarkPosition = cyclingTime % this.cycleTime;
        if (cyclingPosition % 2 === 1 || cyclingTime < 0) {
            return 'day';
        } else if (cyclingDarkPosition < this.fadeTime) {
            return 'fadeToNight';
        } else if (cyclingDarkPosition < this.fadeTime + this.darkTime){
            return 'night'
        } else {
            return 'fadeToDay';
        }
    }

    getFadeProgress(gameMode) {
        const cyclingTime = this.currentTime - this.initialtime;
        const cyclingDarkPosition = cyclingTime % this.cycleTime;
        if (gameMode === 'fadeToNight') {
            return (cyclingDarkPosition) / this.fadeTime;
        } else if (gameMode === 'fadeToDay') {
            return (cyclingDarkPosition - this.fadeTime - this.darkTime) / this.fadeTime;
        }
    }

    getDayTimeRemaining() {
        const cyclingTime = this.currentTime - this.initialtime;
        const cyclingPosition = Math.floor(cyclingTime / this.cycleTime);
        if (cyclingTime < 0) {
            return Math.floor((this.initialtime - this.currentTime) / 1000);
        } else if (cyclingPosition % 2 === 1) {
            return Math.floor(((cyclingPosition + 1) * this.cycleTime - cyclingTime) / 1000);
        } else {
            return -1;
        }
    }

    getNightTimeRemaining() {
        const cyclingTime = this.currentTime - this.initialtime;
        const cyclingPosition = Math.floor(cyclingTime / this.cycleTime);

        if (cyclingPosition % 2 === 0) {
            return Math.floor(((cyclingPosition + 1) * this.cycleTime - cyclingTime) / 1000);
        } else {
            return -1;
        }
    }

    // 生成流星
    spawnMeteor() {
        const startX = Math.random() * this.gameWidth;
        const angle = Math.random() * Math.PI / 4 + Math.PI / 8; // 22.5-67.5度角度
        const speed = 200 + Math.random() * 100; // 速度200-300

        this.meteors.push({
            x: startX,
            y: -20,
            angle: angle,
            speed: speed,
            length: 30 + Math.random() * 20,
            width: 2 + Math.random() * 2,
            life: 3.0, // 流星存在时间（秒）
            brightness: 0.8 + Math.random() * 0.2
        });
    }

    // 更新流星位置
    updateMeteors(deltaTime) {
        for (let i = this.meteors.length - 1; i >= 0; i--) {
            const meteor = this.meteors[i];
            meteor.x += Math.cos(meteor.angle) * meteor.speed * (deltaTime / 1000);
            meteor.y += Math.sin(meteor.angle) * meteor.speed * (deltaTime / 1000);
            meteor.life -= deltaTime / 1000;

            // 移除超出屏幕或生命周期结束的流星
            if (meteor.y > this.gameHeight || meteor.x > this.gameWidth || meteor.x < 0 || meteor.life <= 0) {
                this.meteors.splice(i, 1);
            }
        }
    }

    // 绘制流星
    renderMeteors(ctx) {
        if (this.meteors.length > 0) {
            ctx.save();

            this.meteors.forEach(meteor => {
                const progress = 1 - (meteor.life / 3.0); // 流星生命周期进度
                const alpha = Math.min(1, progress < 0.2 ? progress / 0.2 : (1 - progress) / 0.8) * meteor.brightness;

                if (alpha > 0) {
                    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
                    ctx.lineWidth = meteor.width;
                    ctx.lineCap = 'round';

                    ctx.beginPath();
                    ctx.moveTo(meteor.x, meteor.y);
                    ctx.lineTo(
                        meteor.x - Math.cos(meteor.angle) * meteor.length,
                        meteor.y - Math.sin(meteor.angle) * meteor.length
                    );
                    ctx.stroke();

                    // 流星尾迹光晕
                    const gradient = ctx.createLinearGradient(
                        meteor.x, meteor.y,
                        meteor.x - Math.cos(meteor.angle) * meteor.length,
                        meteor.y - Math.sin(meteor.angle) * meteor.length
                    );
                    gradient.addColorStop(0, `rgba(255, 255, 255, ${alpha * 0.3})`);
                    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');

                    ctx.strokeStyle = gradient;
                    ctx.lineWidth = meteor.width * 3;
                    ctx.stroke();
                }
            });

            ctx.restore();
        }
    }

    // 生成烟花（左下角）
    spawnFirework() {
        const baseX = this.gameWidth * 0.2; // 左下角区域
        const baseY = this.gameHeight * 0.9;

        this.fireworks.push({
            x: baseX + Math.random() * 100 - 50,
            y: baseY,
            targetY: this.gameHeight * 0.5 + Math.random() * 100 - 50,
            speed: 2 + Math.random() * 1,
            particles: [],
            state: 'rising', // rising, exploding, fading
            life: 3.0,
            color: `hsl(${Math.random() * 360}, 100%, 60%)`
        });
    }

    // 更新烟花
    updateFireworks(deltaTime) {
        for (let i = this.fireworks.length - 1; i >= 0; i--) {
            const firework = this.fireworks[i];
            firework.life -= deltaTime / 1000;

            if (firework.life <= 0) {
                this.fireworks.splice(i, 1);
                continue;
            }

            if (firework.state === 'rising') {
                firework.y -= firework.speed;

                // 到达目标高度时爆炸
                if (firework.y <= firework.targetY) {
                    firework.state = 'exploding';
                    this.createExplosionParticles(firework);
                }
            } else if (firework.state === 'exploding') {
                // 更新爆炸粒子
                for (let j = firework.particles.length - 1; j >= 0; j--) {
                    const particle = firework.particles[j];
                    particle.x += particle.vx;
                    particle.y += particle.vy;
                    particle.vy += 0.05; // 重力
                    particle.life -= deltaTime / 1000;

                    if (particle.life <= 0) {
                        firework.particles.splice(j, 1);
                    }
                }

                // 所有粒子消失后进入淡出状态
                if (firework.particles.length === 0) {
                    firework.state = 'fading';
                }
            }
        }
    }

    // 创建爆炸粒子
    createExplosionParticles(firework) {
        const particleCount = 30 + Math.floor(Math.random() * 20);

        for (let i = 0; i < particleCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 1 + Math.random() * 2;

            firework.particles.push({
                x: firework.x,
                y: firework.y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                size: 2 + Math.random() * 3,
                life: 1 + Math.random() * 0.5,
                color: firework.color
            });
        }
    }

    // 绘制烟花
    renderFireworks(ctx) {
        if (this.fireworks.length > 0) {
            ctx.save();

            this.fireworks.forEach(firework => {
                if (firework.state === 'rising') {
                    // 绘制上升的烟花
                    ctx.fillStyle = firework.color;
                    ctx.beginPath();
                    ctx.arc(firework.x, firework.y, 3, 0, Math.PI * 2);
                    ctx.fill();

                    // 烟花尾迹
                    ctx.strokeStyle = firework.color;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(firework.x, firework.y + 10);
                    ctx.lineTo(firework.x, firework.y);
                    ctx.stroke();
                } else if (firework.state === 'exploding') {
                    // 绘制爆炸粒子
                    firework.particles.forEach(particle => {
                        const alpha = Math.min(1, particle.life / 1.0);
                        ctx.fillStyle = `${particle.color.replace(')', `, ${alpha})`).replace('hsl', 'hsla')}`;
                        ctx.beginPath();
                        ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
                        ctx.fill();
                    });
                }
            });

            ctx.restore();
        }
    }
}

window.DayNightManager = DayNightManager;
