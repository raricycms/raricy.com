class Config {
    // 游戏难度设置
    static DIFFICULTY_LEVELS = {
        slow: { speed: 2.5, maxTime: 120000, Length: 400 },
        medium: { speed: 3.5, maxTime: 100000, Length: 350 },
        fast: { speed: 4, maxTime: 80000, Length: 300 },
        ultra: { speed: 6, maxTime: 80000, Length: 250 }
    };

    // 玩家默认设置
    static PLAYER_DEFAULTS = {
        size: 8,
        locktime: 5000, // 无限模式封锁时间
        addlocktime: 2000, // 无限模式增加封锁时间
        homeTimeLimit: 15000, // 15秒时间限制
        lives: {
            explore: 1,
            fight: 3,
            infinite: 2,
            survival: 3,
            capture: 1,
            daynight: 3
        },
        standarddistance: 2, // 轨迹插值距离
        pushdistance: 6, // 碰撞反弹距离
        AIspeed: 1.5, // AI移动速度倍率
        deathshieldtime: 3000, // 死亡后护盾时间
        detectionRadius: 150, // AI检测玩家的半径
    };

    // 敌人AI默认设置
    static AI_DEFAULTS = {
        slow: { multiplier: 0.9, count: 2, maxEnemies: 6, interval: 30000 },
        medium: { multiplier: 1.2, count: 3, maxEnemies: 7, interval: 20000 },
        fast: { multiplier: 1.4, count: 4, maxEnemies: 8, interval: 15000 },
        ultra: { multiplier: 2.0, count: 5, maxEnemies: 10, interval: 10000 }
    }

    // 旗帜默认设置
    static FLAG_DEFAULTS = {
        size: 25,
        ditance_from_player: 300, // 旗帜距离玩家出发点的最小距离
        ditance_between_flags: 100, // 旗帜之间的最小距离
        color: '#FFD700'
    }

    static DAYNIGHT = {
        darkness: 0.98,
        fadeTime: 5000,
        darkTime: 10000,
        cycleTime: 20000,
        initialTime: 10000
    }



    // 按键控制映射
    static KEY_BINDINGS = {
        player1: {
            up: 'KeyW',
            down: 'KeyS',
            left: 'KeyA',
            right: 'KeyD'
        },
        player2: {
            up: 'ArrowUp',
            down: 'ArrowDown',
            left: 'ArrowLeft',
            right: 'ArrowRight'
        }
    };

    // UI颜色、字体等样式常量
    static UI_STYLES = {
        playerColors: {
            player1: '#E6194B',
            player2: '#0047AB'
        },
        collisionEffect: {
            glowColor: 'rgba(255, 0, 0, 0.7)',
            duration: 200
        },
        homeRadius: 20
    }

    // 画布相关设置
    static CANVAS ={
        canvas: {
            width: 1200,
            height: 600
        },
        P1_startpoint: {
            x: 0.15,
            y: 0.5
        },
        P2_startpoint: {
            x: 0.85,
            y: 0.5
        }
    };

    // 游戏模式生命设置
    static GAME_MODES = {
        explore: { lives: 1 },
        fight: { lives: 3 },
        infinite: { lives: 2 },
        survival: { lives: 3 },
        capture: { lives: 1 },
        daynight: { lives: 3 }
    };

    // 物理帧相关设置
    static PHYSICS_SETTINGS = {
        FPS: 60,
        MAX_FRAME_SKIP: 5
    };

    // 道具管理器相关设置
    static ITEM_MANAGER_SETTINGS = {
        itemSpawnInterval: 2000, // 2秒生成一个道具
        obstacleSpawnInterval: 5000, // 5秒生成一个障碍物
        initialBarrierDuration: 12000, // 12秒
        itemTimeout: 10000, // 道具10秒后消失
        maxObstacles: 30, // 最多30个障碍物
        initialBarrierX: 0.35,
        initialBarrierY: 0.65,
        powerUp: {
            radius: 15,
            speed: {
                color: '#00ff00',
                duration: 5000,
                weight: 40

            },
            length: {
                color: '#ffff00',
                duration: 8000,
                addLength: 100,
                weight: 30
            },
            shield: {
                color: '#00ffff',
                duration: 10000,
                weight: 30
            }
        },
        barrier: {
            width: 40,
            height: 40
        }
    };
}

window.Config = Config;
