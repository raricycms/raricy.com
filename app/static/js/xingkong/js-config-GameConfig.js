/**
 * 游戏配置管理类
 * 负责管理游戏的各种配置参数
 */
class GameConfig {
    constructor() {
        // 难度配置
        this.difficultyConfig = {
            easy: {
                name: '简单',
                enemySpeed: { min: 2, max: 4 },
                enemyBulletSpeed: 5,
                enemyFireRate: 0.010,
                enemySpawnRate: 0.025,
                scoreMultiplier: 1.0,
                bossHealth: 150,
                bossSpeed: 1.2,
                bossFireRate: 600,
                bossBulletDamage: 25,
                bossRamDamage: 60,
                maxEnemies: 10,
                randomPowerupChance: 0.0005,
                maxBallEnemies: 0
            },
            normal: {
                name: '普通',
                enemySpeed: { min: 2.5, max: 5 },
                enemyBulletSpeed: 6,
                enemyFireRate: 0.020,
                enemySpawnRate: 0.030,
                scoreMultiplier: 1.5,
                bossHealth: 200,
                bossSpeed: 1.5,
                bossFireRate: 400,
                bossBulletDamage: 25,
                bossRamDamage: 70,
                maxEnemies: 12,
                randomPowerupChance: 0.0003,
                maxBallEnemies: 1
            },
            hard: {
                name: '困难',
                enemySpeed: { min: 3, max: 6 },
                enemyBulletSpeed: 7,
                enemyFireRate: 0.025,
                enemySpawnRate: 0.040,
                scoreMultiplier: 2.0,
                bossHealth: 300,
                bossSpeed: 2.0,
                bossFireRate: 300,
                bossBulletDamage: 30,
                bossRamDamage: 80,
                maxEnemies: 20,
                randomPowerupChance: 0.0001,
                maxBallEnemies: 2
            },
            nightmare: {
                name: '噩梦',
                enemySpeed: { min: 4, max: 8 },
                enemyBulletSpeed: 9,
                enemyFireRate: 0.030,
                enemySpawnRate: 0.045,
                scoreMultiplier: 2.5,
                bossHealth: 450,
                bossSpeed: 2.5,
                bossFireRate: 200,
                bossBulletDamage: 35,
                bossRamDamage: 100,
                maxEnemies: 30,
                randomPowerupChance: 0.00005,
                maxBallEnemies: 3
            },
            fun: {
                name: '趣味',
                enemySpeed: { min: 3, max: 6 },
                enemyBulletSpeed: 7,
                enemyFireRate: 0.025,
                enemySpawnRate: 0.040,
                scoreMultiplier: 2.0,
                bossHealth: 300,
                bossSpeed: 2.0,
                bossFireRate: 300,
                bossBulletDamage: 30,
                bossRamDamage: 80,
                maxEnemies: 20,
                randomPowerupChance: 0.0001,
                maxBallEnemies: 1,
                blackholeSpawnRate: 0.2,
                meteorSpawnRate: 0.2
            },
            dual: {
                name: '双人',
                enemySpeed: { min: 3, max: 6 },
                enemyBulletSpeed: 7,
                enemyFireRate: 0.025,
                enemySpawnRate: 0.040,
                scoreMultiplier: 2.0,
                bossHealth: 600,
                bossSpeed: 2.0,
                bossFireRate: 300,
                bossBulletDamage: 30,
                bossRamDamage: 80,
                maxEnemies: 50,
                randomPowerupChance: 0.0001,
                maxBallEnemies: 4
            }
        };

        // Boss类型配置
        this.bossTypes = {
            destroyer: {
                name: '毁灭者',
                icon: 'skull',
                color: '#ff4444',
                secondaryColor: '#cc0000',
                coreColor: '#ff8888',
                eyeColor: '#ffff00',
                specialFeature: 'heavy_armor',
                subtitle: '重装甲战舰'
            },
            watcher: {
                name: '监视者',
                icon: 'eye',
                color: '#ffaa00',
                secondaryColor: '#cc8800',
                coreColor: '#ffdd88',
                eyeColor: '#ff0000',
                specialFeature: 'laser_sweep',
                subtitle: '全视野激光'
            },
            spider: {
                name: '蛛网王',
                icon: 'spider',
                color: '#aa00ff',
                secondaryColor: '#8800cc',
                coreColor: '#dd88ff',
                eyeColor: '#ff00ff',
                specialFeature: 'tentacles',
                subtitle: '多触手攻击'
            },
            crystal: {
                name: '水晶核心',
                icon: 'gem',
                color: '#00ffff',
                secondaryColor: '#00cccc',
                coreColor: '#88ffff',
                eyeColor: '#ffffff',
                specialFeature: 'energy_shield',
                subtitle: '能量护盾'
            },
            flame: {
                name: '烈焰君主',
                icon: 'fire',
                color: '#ff6600',
                secondaryColor: '#cc4400',
                coreColor: '#ffaa88',
                eyeColor: '#ffff00',
                specialFeature: 'fire_burst',
                subtitle: '火焰风暴'
            }
        };

        // 敌机类型配置
        this.enemyTypes = {
            basic: {
                width: 40,
                height: 40,
                health: 1,
                score: 400,
                color: '#ff4444',
                secondaryColor: '#cc3333',
                movementType: 'straight',
                powerDropChance: 0.08,
                shieldDropChance: 0.05,
                healthDropChance: 0.1,
                bombDropChance: 0.03
            },
            fast: {
                width: 30,
                height: 30,
                health: 1,
                score: 400,
                color: '#ff8844',
                secondaryColor: '#cc6633',
                speedMultiplier: 2,
                movementType: 'straight',
                powerDropChance: 0.12,
                shieldDropChance: 0.08,
                healthDropChance: 0.12,
                bombDropChance: 0.05
            },
            heavy: {
                width: 50,
                height: 50,
                health: 10,
                score: 1000,
                color: '#8844ff',
                secondaryColor: '#6633cc',
                speedMultiplier: 0.5,
                movementType: 'straight',
                powerDropChance: 0.20,
                shieldDropChance: 0.15,
                healthDropChance: 0.25,
                bombDropChance: 0.12
            },
            sniper: {
                width: 35,
                height: 45,
                health: 3,
                score: 1000,
                color: '#44ff88',
                secondaryColor: '#33cc66',
                fireRateMultiplier: 0.5,
                bulletSpeedMultiplier: 3,
                movementType: 'hover',
                powerDropChance: 0.15,
                shieldDropChance: 0.12,
                healthDropChance: 0.18,
                bombDropChance: 0.08
            },
            patrol: {
                width: 45,
                height: 40,
                health: 4,
                score: 1000,
                color: '#ff44ff',
                secondaryColor: '#cc33cc',
                movementType: 'patrol',
                fireRateMultiplier: 2,
                powerDropChance: 0.25,
                shieldDropChance: 0.18,
                healthDropChance: 0.20,
                bombDropChance: 0.10
            },
            ball: {
                width: 35,
                height: 35,
                health: 6,
                score: 1500,
                color: '#00ffff',
                secondaryColor: '#00cccc',
                speedMultiplier: 0.8,
                movementType: 'float',
                fireRateMultiplier: 1,
                powerDropChance: 0.30,
                shieldDropChance: 0.20,
                healthDropChance: 0.25,
                bombDropChance: 0.15,
                specialAttack: 'radial_burst'
            }
        };
    }

    /**
     * 获取难度配置
     * @param {string} difficulty - 难度名称
     * @returns {Object} 难度配置对象
     */
    getDifficultyConfig(difficulty) {
        return this.difficultyConfig[difficulty] || this.difficultyConfig.normal;
    }

    /**
     * 获取Boss类型配置
     * @param {string} bossType - Boss类型名称
     * @returns {Object} Boss配置对象
     */
    getBossConfig(bossType) {
        return this.bossTypes[bossType] || this.bossTypes.destroyer;
    }

    /**
     * 获取敌机类型配置
     * @param {string} enemyType - 敌机类型名称
     * @returns {Object} 敌机配置对象
     */
    getEnemyConfig(enemyType) {
        return this.enemyTypes[enemyType] || this.enemyTypes.basic;
    }
}
