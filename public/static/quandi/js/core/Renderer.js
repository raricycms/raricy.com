class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // 创建离屏canvas缓存网格
        this.gridCanvas = document.createElement('canvas');
        this.gridCanvas.width = canvas.width;
        this.gridCanvas.height = canvas.height;
        this.gridCtx = this.gridCanvas.getContext('2d');

        this.initGrid(); // 初始化时绘制一次网格

        this.offscreenCanvas = null;
        this.offscreenCtx = null;
        // 渲染缓存，存储 { canvas: offscreenCanvas, timestamp: Date.now() }
        this.itemRenderCache = new Map();
        this.obstacleRenderCache = new Map();
        this.barrierRenderCache = new Map();
        this.shieldRenderCache = new Map();

        this.cacheLifespan = 60 * 1000; // 缓存生命周期，例如60秒

        // 状态哈希缓存
        this.lastItemStates = new Map();
        this.lastObstacleStates = new Map();
        this.lastBarrierStates = new Map();
        this.lastShieldState = null;

        // 灰阶模板上色缓存：color -> tintedCanvas（坦克/出生点/护盾）
        this.tintCache = new Map();

    }

    initGrid() {
        // 在离屏canvas上绘制网格
        this.gridCtx.fillStyle = '#f8f9fa';
        this.gridCtx.fillRect(0, 0, this.gridCanvas.width, this.gridCanvas.height);
        this.drawGridToContext(this.gridCtx);
    }

    clear() {
        // 网格画布是完全不透明的（背景色已填充），直接绘制即可覆盖整个画布，无需先 clearRect
        this.ctx.drawImage(this.gridCanvas, 0, 0);
    }

    drawGridToContext(context) {
        this.drawGrid(context);
    }

    // 窗口大小改变时重新生成网格缓存
    resize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.gridCanvas.width = width;
        this.gridCanvas.height = height;
        this.initGrid();
    }

    drawGrid(context = this.ctx) {
        context.save();

        const gridSize = 40;

        // 背景暗网格
        context.strokeStyle = '#1a1a2e';
        context.lineWidth = 1;
        context.globalAlpha = 0.1;
        this.drawBasicGrid(gridSize, context);

        // 主要霓虹网格
        context.strokeStyle = '#00ffff';
        context.lineWidth = 1;
        context.globalAlpha = 0.05;
        this.drawBasicGrid(gridSize, context);

        // 重点线条（每5条线加强）
        context.strokeStyle = '#FFE119';
        context.lineWidth = 2;
        context.globalAlpha = 0.1;
        this.drawBasicGrid(gridSize * 5, context);

        // 交叉点高亮
        this.drawGridIntersections(gridSize, context);

        context.restore();
    }

    drawBasicGrid(size, context = this.ctx) {
        // 垂直线
        for (let x = 0; x <= this.canvas.width; x += size) {
            context.beginPath();
            context.moveTo(x, 0);
            context.lineTo(x, this.canvas.height);
            context.stroke();
        }

        // 水平线
        for (let y = 0; y <= this.canvas.height; y += size) {
            context.beginPath();
            context.moveTo(0, y);
            context.lineTo(this.canvas.width, y);
            context.stroke();
        }
    }

    drawGridIntersections(gridSize, context = this.ctx) {
        context.fillStyle = '#008b8b';
        context.globalAlpha = 0.5;

        for (let x = 0; x <= this.canvas.width; x += gridSize) {
            for (let y = 0; y <= this.canvas.height; y += gridSize) {
                context.beginPath();
                context.arc(x, y, 1, 0, Math.PI * 2);
                context.fill();
            }
        }
    }

    drawTerritories(territories, playerId, color) {
        if (!territories || territories.length === 0) return;

        const mainCtx = this.ctx;
        const canvas = mainCtx.canvas;

        // 复用离屏画布，只在尺寸变化时重新创建
        if (!this.offscreenCanvas ||
            this.offscreenCanvas.width !== canvas.width ||
            this.offscreenCanvas.height !== canvas.height) {
            this.offscreenCanvas = document.createElement('canvas');
            this.offscreenCanvas.width = canvas.width;
            this.offscreenCanvas.height = canvas.height;
            this.offscreenCtx = this.offscreenCanvas.getContext('2d');
        }

        const offscreenCtx = this.offscreenCtx;

        // 清空离屏画布
        offscreenCtx.clearRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);

        offscreenCtx.fillStyle = '#000';
        offscreenCtx.beginPath();
        territories.forEach(territory => {
            if (!territory || territory.length < 3) return;
            territory.forEach((point, index) => {
                if (index === 0) {
                    offscreenCtx.moveTo(point.x, point.y);
                } else {
                    offscreenCtx.lineTo(point.x, point.y);
                }
            });
            offscreenCtx.closePath();
            offscreenCtx.fill();
        });

        // 应用颜色
        offscreenCtx.globalCompositeOperation = 'source-in';
        offscreenCtx.fillStyle = color + '65';
        offscreenCtx.fillRect(0, 0, this.offscreenCanvas.width, this.offscreenCanvas.height);

        // 重置混合模式
        offscreenCtx.globalCompositeOperation = 'source-over';

        // 绘制到主画布
        mainCtx.save();
        mainCtx.drawImage(this.offscreenCanvas, 0, 0);
        mainCtx.restore();
    }


    drawTrail(trail, color) {
        if (!trail || trail.length < 2) return;

        this.ctx.save();

        // 绘制轨迹主体
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 6;
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';

        this.ctx.beginPath();

        // 使用贝塞尔曲线绘制更平滑的轨迹
        for (let i = 0; i < trail.length - 1; i++) {
            const currentPoint = trail[i];
            const nextPoint = trail[i + 1];

            if (i === 0) {
                this.ctx.moveTo(currentPoint.x, currentPoint.y);
            }

            // 如果有控制点，使用二次贝塞尔曲线
            if (nextPoint.controlX !== undefined && nextPoint.controlY !== undefined) {
                this.ctx.quadraticCurveTo(
                    nextPoint.controlX,
                    nextPoint.controlY,
                    nextPoint.x,
                    nextPoint.y
                );
            } else {
                // 否则使用直线连接
                this.ctx.lineTo(nextPoint.x, nextPoint.y);
            }
        }

        this.ctx.stroke();

        // 绘制轨迹边框
        this.ctx.strokeStyle = '#333';
        this.ctx.lineWidth = 2;
        this.ctx.stroke();

        this.ctx.restore();
    }

    drawPlayer(player) {
        if (!player || !player.isAlive) return;

        this.ctx.save();

        // 如果有碰撞效果，添加闪烁效果和光晕
        if (player.collisionEffect && player.collisionEffect.active) {
            const elapsed = Date.now() - player.collisionEffect.startTime;
            const flashInterval = 50; // 每50毫秒闪烁一次，恢复到之前的设置
            const shouldFlash = Math.floor(elapsed / flashInterval) % 2 === 0;

            if (shouldFlash) {
                this.ctx.shadowColor = player.collisionEffect.glowColor || '#FF0000'; // 使用glowColor或默认红色
                this.ctx.shadowBlur = 8;
            } else {
                this.ctx.shadowColor = 'transparent';
                this.ctx.shadowBlur = 0;
            }
        } else {
            // 如果没有碰撞效果，确保移除阴影，避免影响其他绘制
            this.ctx.shadowColor = 'transparent';
            this.ctx.shadowBlur = 0;
        }

        // 计算坦克朝向角度 - 只在移动时更新
        if (player.direction.x !== 0 || player.direction.y !== 0) {
            player.tankAngle = Math.atan2(player.direction.y, player.direction.x);
        }
        // 如果没有设置过角度，默认朝右
        if (player.tankAngle === undefined) {
            player.tankAngle = 0;
        }

        // 保存当前变换状态
        this.ctx.save();

        // 移动到玩家位置并旋转
        this.ctx.translate(player.x, player.y);
        this.ctx.rotate(player.tankAngle);

        // 绘制坦克主体
        this.drawTank(player);

        // 恢复变换状态
        this.ctx.restore();

        // 玩家名称 (不旋转)
        const displayName = player.playerName || `玩家${player.id}`;
        this.ctx.fillStyle = '#fff';
        this.ctx.font = 'bold 12px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.strokeStyle = '#000';
        this.ctx.lineWidth = 2;
        this.ctx.strokeText(displayName, player.x, player.y - player.size - 15);
        this.ctx.fillText(displayName, player.x, player.y - player.size - 15);

        // 绘制护盾效果
        if (player.hasShield()) {
            this.drawShieldCached(player.shield, player.x, player.y);
        }

        this.ctx.restore(); // 恢复到保存的绘图状态，包括阴影设置
    }

    // 绘制远程玩家（使用与本地玩家完全相同的坦克绘制）
    drawRemotePlayer(remotePlayer) {
        if (!remotePlayer || !remotePlayer.isAlive) return;

        // 直接使用 x/y（已同步到轨迹最前端），不再使用延迟插值位置
        // 保证坦克始终在轨迹末端，与本地 Player 行为一致
        const pos = { x: remotePlayer.x, y: remotePlayer.y };
        if (pos.x === 0 && pos.y === 0 && (!remotePlayer.renderTrail || remotePlayer.renderTrail.length === 0)) return;

        const size = remotePlayer.size || 8;
        const color = remotePlayer.color || '#888888';
        const name = remotePlayer.name || '玩家';

        this.ctx.save();
        this.ctx.translate(pos.x, pos.y);

        // 计算朝向角度
        const angle = Math.atan2(remotePlayer.direction.y || 0, remotePlayer.direction.x || 0);
        this.ctx.rotate(angle);

        // 使用和本地玩家完全相同的 drawTank 方法
        const savedColor = { color };
        // 构造一个临时对象，提供 Player 相同的属性给 drawTankShape
        const tempPlayer = { size, color, direction: remotePlayer.direction };
        this.drawTank(tempPlayer);

        this.ctx.restore();

        // 名称标签（不旋转）
        this.ctx.fillStyle = '#fff';
        this.ctx.font = 'bold 11px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.strokeStyle = '#000';
        this.ctx.lineWidth = 2;
        this.ctx.strokeText(name, pos.x, pos.y - size - 15);
        this.ctx.fillText(name, pos.x, pos.y - size - 15);

        // 护盾光圈
        if (remotePlayer.hasShield) {
            this.ctx.beginPath();
            this.ctx.arc(pos.x, pos.y, size + 6, 0, Math.PI * 2);
            this.ctx.strokeStyle = 'rgba(0, 255, 255, 0.6)';
            this.ctx.lineWidth = 2;
            this.ctx.stroke();
        }
    }

    // 绘制坦克形状的辅助方法
    drawTankShape(size) {
        const tankWidth = size * 1.6;
        const tankHeight = size * 1.2;
        const turretSize = size * 0.7;
        const barrelLength = size * 1.5;
        const barrelWidth = size * 0.2;

        // 坦克履带
        this.ctx.fillRect(-tankWidth / 2 - 2, -tankHeight / 2 - 2, tankWidth + 4, tankHeight + 4);

        // 坦克主体
        this.ctx.fillRect(-tankWidth / 2, -tankHeight / 2, tankWidth, tankHeight);

        // 炮塔
        this.ctx.beginPath();
        this.ctx.arc(0, 0, turretSize, 0, Math.PI * 2);
        this.ctx.fill();

        // 炮管
        this.ctx.fillRect(0, -barrelWidth / 2, barrelLength, barrelWidth);
    }

    // 绘制简化坦克的方法
    drawTank(player) {
        const size = player.size;

        // 优先使用精灵图（灰阶模板 + multiply 上色）。模板朝右，与 player.tankAngle 一致。
        // 上色区域限定为车体矩形（模板 48×32，炮管在 x≥43，只给主体 0..42 上色，炮管保持灰阶）
        const tinted = this.getTintedSprite('tank_template', player.color, { shape: 'rect', x: 0, y: 0, w: 43, h: 32 });
        if (tinted) {
            // 内容覆盖车体+炮管（原坦克在局部坐标系约 20×14），绘制尺寸与程序化绘制一致
            const drawWidth = size * 2.5 * 1.5; // 放大50%
            const drawHeight = size * 1.75 * 1.5;
            this.ctx.drawImage(tinted, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
            return;
        }

        const tankWidth = size * 1.6;
        const tankHeight = size * 1.2;
        const turretSize = size * 0.5;
        const barrelLength = size * 1.5;
        const barrelWidth = size * 0.2;

        // 履带颜色（深色）
        const trackColor = this.darkenColor(player.color, 20);
        // 主体颜色
        const bodyColor = player.color;
        // 炮塔颜色（稍微亮一点）
        const turretColor = this.lightenColor(player.color, 20);

        // 绘制履带
        this.ctx.fillStyle = trackColor;
        this.ctx.fillRect(-tankWidth / 2 - 2, -tankHeight / 2 - 2, tankWidth + 4, tankHeight + 4);

        // 履带边框
        this.ctx.strokeStyle = '#222';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(-tankWidth / 2 - 2, -tankHeight / 2 - 2, tankWidth + 4, tankHeight + 4);

        // 坦克主体 - 使用纯色代替渐变
        this.ctx.fillStyle = bodyColor;
        this.ctx.fillRect(-tankWidth / 2, -tankHeight / 2, tankWidth, tankHeight);

        // 主体边框
        this.ctx.strokeStyle = '#333';
        this.ctx.lineWidth = 0.5;
        this.ctx.strokeRect(-tankWidth / 2, -tankHeight / 2, tankWidth, tankHeight);

        // 炮塔 - 使用纯色代替渐变
        this.ctx.fillStyle = turretColor;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, turretSize, 0, Math.PI * 2);
        this.ctx.fill();

        // 炮塔边框
        this.ctx.strokeStyle = '#333';
        this.ctx.lineWidth = 0.5;
        this.ctx.beginPath();
        this.ctx.arc(0, 0, turretSize, 0, Math.PI * 2);
        this.ctx.stroke();

        // 炮管 - 使用纯色代替渐变
        this.ctx.fillStyle = turretColor;
        this.ctx.fillRect(0, -barrelWidth / 2, barrelLength, barrelWidth);

        // 炮管边框
        this.ctx.strokeStyle = '#333';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(0, -barrelWidth / 2, barrelLength, barrelWidth);
    }

    // 灰阶精灵模板上色：用 multiply 把单色叠加到灰阶图上，层次（深/中/浅）自然保留。
    // region 限定上色区域：
    //   {shape:'circle', radius} — 以画布中心为圆心、radius 为半径的圆形区域（出生点/旗帜）
    //   {shape:'rect', x, y, w, h} — 矩形区域（坦克：排除炮管，只给车体上色）
    // 结果按 (name, color, region) 缓存，避免每帧重复创建离屏 canvas。
    getTintedSprite(name, color, region = null) {
        const regionKey = region ? JSON.stringify(region) : '';
        const cacheKey = name + '_' + color + '_' + regionKey;
        if (this.tintCache.has(cacheKey)) {
            return this.tintCache.get(cacheKey);
        }

        const src = window.imageLoader && window.imageLoader.get(name);
        if (!src) return null;

        const canvas = document.createElement('canvas');
        canvas.width = src.width;
        canvas.height = src.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(src, 0, 0);

        ctx.save();
        if (region) {
            if (region.shape === 'circle') {
                // 圆形上色：以画布中心为圆心
                ctx.beginPath();
                ctx.arc(canvas.width / 2, canvas.height / 2, region.radius, 0, Math.PI * 2);
                ctx.clip();
            } else if (region.shape === 'rect') {
                // 矩形上色：限定在指定矩形内
                ctx.beginPath();
                ctx.rect(region.x, region.y, region.w, region.h);
                ctx.clip();
            }
        }
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = 0.6; // 降低上色强度，避免全饱和纯色过重
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.restore();

        // 缓存大小限制：颜色数量有限（预设7色+自定义），合理保留
        if (this.tintCache.size > 50) {
            this.tintCache.delete(this.tintCache.keys().next().value);
        }
        this.tintCache.set(cacheKey, canvas);
        return canvas;
    }

    // 颜色处理辅助方法
    lightenColor(color, percent) {
        const num = parseInt(color.replace("#", ""), 16);
        const amt = Math.round(2.55 * percent);
        const R = (num >> 16) + amt;
        const G = (num >> 8 & 0x00FF) + amt;
        const B = (num & 0x0000FF) + amt;
        return "#" + (0x1000000 + (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 +
            (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 +
            (B < 255 ? B < 1 ? 0 : B : 255)).toString(16).slice(1);
    }

    darkenColor(color, percent) {
        const num = parseInt(color.replace("#", ""), 16);
        const amt = Math.round(2.55 * percent);
        const R = (num >> 16) - amt;
        const G = (num >> 8 & 0x00FF) - amt;
        const B = (num & 0x0000FF) - amt;
        return "#" + (0x1000000 + (R > 255 ? 255 : R < 0 ? 0 : R) * 0x10000 +
            (G > 255 ? 255 : G < 0 ? 0 : G) * 0x100 +
            (B > 255 ? 255 : B < 0 ? 0 : B)).toString(16).slice(1);
    }


    drawSpawnPoint(x, y, color) {
        // 出生点为圆形靶标（模板 48×48，圆盘直径约 47），按圆形区域上色
        const tinted = this.getTintedSprite('spawn_point_template', color, { shape: 'circle', radius: 24 });
        if (tinted) {
            // 模板为同心圆靶标，外圈直径约 40（r=20），与程序化绘制尺寸一致
            const drawSize = 40;
            this.ctx.drawImage(tinted, x - drawSize / 2, y - drawSize / 2, drawSize, drawSize);
            return;
        }

        this.ctx.save();

        // 外圈
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 3;
        this.ctx.beginPath();
        this.ctx.arc(x, y, 20, 0, Math.PI * 2);
        this.ctx.stroke();

        // 内圈
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.arc(x, y, 12, 0, Math.PI * 2);
        this.ctx.stroke();

        // 中心点
        this.ctx.fillStyle = color;
        this.ctx.beginPath();
        this.ctx.arc(x, y, 4, 0, Math.PI * 2);
        this.ctx.fill();

        this.ctx.restore();
    }

    drawItems(itemManager) {
        // 渲染道具
        itemManager.items.forEach(item => {
            this.drawPowerUpItemCached(item);
        });

        // 渲染障碍物
        itemManager.obstacles.forEach(obstacle => {
            this.drawBarrierCached(obstacle);
        });

        // 渲染初始栏杆
        itemManager.initialBarriers.forEach(barrier => {
            this.drawInitialBarrierCached(barrier);
        });
    }

    // ==================== 道具相关方法 ====================

    drawPowerUpItemCached(item) {
        const img = window.imageLoader && window.imageLoader.get(this.getItemImageName(item.type));
        if (img) {
            // 图片为 48×48，内容圆直径约 30（=2*radius）。脉冲时按内容尺寸缩放，保持居中
            const drawSize = item.radius * 2 * item.pulseScale;
            this.ctx.drawImage(img, item.x - drawSize / 2, item.y - drawSize / 2, drawSize, drawSize);
            return;
        }

        const stateHash = this.getItemStateHash(item);
        const cacheKey = `${item.id}_${stateHash}`;

        // 检查状态是否变化
        const lastState = this.lastItemStates.get(item.id);
        if (lastState === stateHash && this.itemRenderCache.has(cacheKey)) {
            // 直接使用缓存的canvas
            const cached = this.itemRenderCache.get(cacheKey);
            const cachedCanvas = cached.canvas;
            const size = cachedCanvas.width;
            this.ctx.drawImage(cachedCanvas, item.x - size / 2, item.y - size / 2);
            cached.timestamp = Date.now(); // 更新时间戳
            return;
        }

        // 创建离屏canvas进行绘制
        const size = Math.ceil(item.radius * 2 * item.pulseScale + 10); // 留一些边距
        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = size;
        offscreenCanvas.height = size;
        const offCtx = offscreenCanvas.getContext('2d');

        // 在离屏canvas上绘制
        this.drawPowerUpItemToCanvas(offCtx, item, size / 2, size / 2);

        // 缓存结果
        this.itemRenderCache.set(cacheKey, { canvas: offscreenCanvas, timestamp: Date.now() });
        this.lastItemStates.set(item.id, stateHash);

        // 清理旧缓存
        this.cleanupItemCache(item.id, cacheKey);

        // 绘制到主canvas
        this.ctx.drawImage(offscreenCanvas, item.x - size / 2, item.y - size / 2);
    }

    // 道具类型 -> 精灵图名
    getItemImageName(type) {
        switch (type) {
            case 'speed': return 'item_speed';
            case 'length': return 'item_length';
            case 'shield': return 'item_shield';
            default: return 'item_speed';
        }
    }

    // 生成道具状态哈希
    getItemStateHash(item) {
        return `${item.type}_${item.color}_${Math.round(item.pulseScale * 100)}_${item.radius}`;
    }

    // 在指定canvas上绘制道具
    drawPowerUpItemToCanvas(ctx, item, centerX, centerY) {
        ctx.save();
        ctx.translate(centerX, centerY);
        ctx.scale(item.pulseScale, item.pulseScale);

        // 绘制道具背景
        ctx.fillStyle = item.color;
        ctx.beginPath();
        ctx.arc(0, 0, item.radius, 0, Math.PI * 2);
        ctx.fill();

        // 绘制道具边框
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.stroke();

        // 绘制道具图标
        ctx.fillStyle = '#000000';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        let symbol = this.getItemSymbol(item.type);
        ctx.fillText(symbol, 0, 0);
        ctx.restore();
    }

    // 获取道具符号
    getItemSymbol(type) {
        const symbols = {
            'speed': '⚡',
            'length': '📏',
            'shield': '🛡️'
        };
        return symbols[type] || '';
    }

    // 清理道具缓存
    cleanupItemCache(itemId, currentKey) {
        for (const [key] of this.itemRenderCache) {
            if (key.startsWith(`${itemId}_`) && key !== currentKey) {
                this.itemRenderCache.delete(key);
            }
        }
    }

    // ==================== 障碍物相关方法 ====================

    // 缓存版本的障碍物绘制
    drawBarrierCached(barrier) {
        const img = window.imageLoader && window.imageLoader.get('obstacle');
        if (img) {
            // 精灵图为 60×60（内容 40×40 圆牌被 trim 后铺满），绘制尺寸 = 内容尺寸，居中于障碍物矩形中心
            const drawSize = Math.max(barrier.width, barrier.height);
            const cx = barrier.x + barrier.width / 2;
            const cy = barrier.y + barrier.height / 2;
            this.ctx.drawImage(img, cx - drawSize / 2, cy - drawSize / 2, drawSize, drawSize);
            return;
        }

        const stateHash = this.getBarrierStateHash(barrier);
        const cacheKey = `${barrier.id}_${stateHash}`;
        const padding = 10; // 留边距用于阴影和高光效果

        // 检查状态是否变化
        const lastState = this.lastObstacleStates.get(barrier.id);
        if (lastState === stateHash && this.obstacleRenderCache.has(cacheKey)) {
            // 直接使用缓存的canvas
            const cached = this.obstacleRenderCache.get(cacheKey);
            this.ctx.drawImage(cached.canvas, barrier.x - padding, barrier.y - padding);
            cached.timestamp = Date.now(); // 更新时间戳
            return;
        }

        // 创建离屏canvas进行绘制
        const canvasWidth = barrier.width + padding * 2;
        const canvasHeight = barrier.height + padding * 2;

        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = canvasWidth;
        offscreenCanvas.height = canvasHeight;
        const offCtx = offscreenCanvas.getContext('2d');

        // 在离屏canvas上绘制（调整坐标以适应padding）
        this.drawBarrierToCanvas(offCtx, {
            ...barrier,
            x: padding,
            y: padding
        });

        // 缓存结果
        this.obstacleRenderCache.set(cacheKey, { canvas: offscreenCanvas, timestamp: Date.now() });
        this.lastObstacleStates.set(barrier.id, stateHash);

        // 清理旧缓存
        this.cleanupObstacleCache(barrier.id, cacheKey);

        // 绘制到主canvas（调整位置以补偿padding）
        this.ctx.drawImage(offscreenCanvas, barrier.x - padding, barrier.y - padding);
    }

    // 生成障碍物状态哈希
    getBarrierStateHash(barrier) {
        return `${barrier.width}_${barrier.height}`;
    }

    // 在指定canvas上绘制障碍物
    drawBarrierToCanvas(ctx, barrier) {
        ctx.save();

        const centerX = barrier.x + barrier.width / 2;
        const centerY = barrier.y + barrier.height / 2;
        const radius = Math.min(barrier.width, barrier.height) / 2;

        // 绘制圆形背景
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);

        // 创建径向渐变
        const gradient = ctx.createRadialGradient(
            centerX - radius * 0.3, centerY - radius * 0.3, 0,
            centerX, centerY, radius
        );
        gradient.addColorStop(0, '#A0522D');
        gradient.addColorStop(0.7, '#8B4513');
        gradient.addColorStop(1, '#654321');

        ctx.fillStyle = gradient;
        ctx.fill();

        // 绘制山的形状
        const mountainScale = 0.6;
        const mountainWidth = radius * mountainScale;
        const mountainHeight = radius * mountainScale;

        ctx.beginPath();
        // 山峰1 (左边的山)
        ctx.moveTo(centerX - mountainWidth * 0.8, centerY + mountainHeight * 0.3);
        ctx.lineTo(centerX - mountainWidth * 0.3, centerY - mountainHeight * 0.5);
        ctx.lineTo(centerX - mountainWidth * 0.1, centerY + mountainHeight * 0.1);

        // 山峰2 (中间的山，最高)
        ctx.lineTo(centerX, centerY - mountainHeight * 0.8);
        ctx.lineTo(centerX + mountainWidth * 0.2, centerY - mountainHeight * 0.1);

        // 山峰3 (右边的山)
        ctx.lineTo(centerX + mountainWidth * 0.4, centerY - mountainHeight * 0.4);
        ctx.lineTo(centerX + mountainWidth * 0.8, centerY + mountainHeight * 0.3);

        // 连接底部
        ctx.lineTo(centerX - mountainWidth * 0.8, centerY + mountainHeight * 0.3);
        ctx.closePath();

        // 山的渐变色
        const mountainGradient = ctx.createLinearGradient(
            centerX, centerY - mountainHeight * 0.8,
            centerX, centerY + mountainHeight * 0.3
        );
        mountainGradient.addColorStop(0, '#E6E6FA');  // 山顶雪白色
        mountainGradient.addColorStop(0.3, '#D3D3D3'); // 浅灰色
        mountainGradient.addColorStop(0.7, '#696969'); // 深灰色
        mountainGradient.addColorStop(1, '#2F4F4F');   // 山脚深色

        ctx.fillStyle = mountainGradient;
        ctx.fill();

        // 添加山的阴影效果
        ctx.strokeStyle = '#2F2F2F';
        ctx.lineWidth = 1;
        ctx.stroke();

        // 绘制圆形边框
        ctx.beginPath();
        const borderWidth = 2;
        // 将半径向内收缩线宽的一半
        ctx.arc(centerX, centerY, radius - borderWidth / 2, 0, Math.PI * 2);
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = borderWidth;
        ctx.stroke();

        // 添加高光效果
        ctx.beginPath();
        ctx.arc(
            centerX - radius * 0.3,
            centerY - radius * 0.3,
            radius * 0.2,
            0, Math.PI * 2
        );
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.fill();

        ctx.restore();
    }

    // 清理障碍物缓存
    cleanupObstacleCache(barrierId, currentKey) {
        for (const [key] of this.obstacleRenderCache) {
            if (key.startsWith(`${barrierId}_`) && key !== currentKey) {
                this.obstacleRenderCache.delete(key);
            }
        }
    }

    // ==================== 初始栏杆相关方法 ====================

    // 缓存版本的初始栏杆绘制
    drawInitialBarrierCached(barrier) {
        const img = window.imageLoader && window.imageLoader.get('initial_barrier');
        if (img) {
            // 精灵图内容铺满，绘制尺寸 = 内容尺寸（40×40 方块），居中于矩形中心
            const drawSize = Math.max(barrier.width, barrier.height);
            const cx = barrier.x + barrier.width / 2;
            const cy = barrier.y + barrier.height / 2;
            this.ctx.drawImage(img, cx - drawSize / 2, cy - drawSize / 2, drawSize, drawSize);
            return;
        }

        const stateHash = this.getInitialBarrierStateHash(barrier);
        const cacheKey = `${barrier.id}_${stateHash}`;
        const padding = 10;

        // 检查状态是否变化
        const lastState = this.lastBarrierStates.get(barrier.id);
        if (lastState === stateHash && this.barrierRenderCache.has(cacheKey)) {
            // 直接使用缓存的canvas
            const cached = this.barrierRenderCache.get(cacheKey);
            this.ctx.drawImage(cached.canvas, barrier.x - padding, barrier.y - padding);
            cached.timestamp = Date.now(); // 更新时间戳
            return;
        }

        // 创建离屏canvas进行绘制
        const canvasWidth = barrier.width + padding * 2;
        const canvasHeight = barrier.height + padding * 2;

        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = canvasWidth;
        offscreenCanvas.height = canvasHeight;
        const offCtx = offscreenCanvas.getContext('2d');

        // 在离屏canvas上绘制
        this.drawInitialBarrierToCanvas(offCtx, {
            ...barrier,
            x: padding,
            y: padding
        });

        // 缓存结果
        this.barrierRenderCache.set(cacheKey, { canvas: offscreenCanvas, timestamp: Date.now() });
        this.lastBarrierStates.set(barrier.id, stateHash);

        // 清理旧缓存
        this.cleanupBarrierCache(barrier.id, cacheKey);

        // 绘制到主canvas
        this.ctx.drawImage(offscreenCanvas, barrier.x - padding, barrier.y - padding);
    }


    // 生成初始栏杆状态哈希
    getInitialBarrierStateHash(barrier) {
        // 初始栏杆通常状态不变，主要基于尺寸
        return `${barrier.width}_${barrier.height}`;
    }

    // 在指定canvas上绘制初始栏杆
    drawInitialBarrierToCanvas(ctx, barrier) {
        ctx.save();

        // 创建渐变背景
        const gradient = ctx.createLinearGradient(barrier.x, barrier.y, barrier.x, barrier.y + barrier.height);
        gradient.addColorStop(0, '#D2B48C'); // 浅棕色
        gradient.addColorStop(0.5, '#A0522D'); // 中棕色
        gradient.addColorStop(1, '#8B4513'); // 深棕色

        // 绘制主体栏杆
        ctx.fillStyle = gradient;
        ctx.fillRect(barrier.x, barrier.y, barrier.width, barrier.height);

        // 添加木纹纹理效果
        ctx.strokeStyle = 'rgba(139, 69, 19, 0.3)';
        ctx.lineWidth = 1;
        for (let i = 0; i < barrier.height; i += 8) {
            ctx.beginPath();
            ctx.moveTo(barrier.x, barrier.y + i);
            ctx.lineTo(barrier.x + barrier.width, barrier.y + i + 2);
            ctx.stroke();
        }

        // 绘制装饰性垂直支柱
        const pillarWidth = 8;
        const pillarCount = 3;
        ctx.fillStyle = '#654321';

        for (let i = 0; i < pillarCount; i++) {
            const pillarX = barrier.x + (barrier.width / (pillarCount + 1)) * (i + 1) - pillarWidth / 2;
            ctx.fillRect(pillarX, barrier.y, pillarWidth, barrier.height);

            // 支柱高光
            ctx.fillStyle = 'rgba(210, 180, 140, 0.5)';
            ctx.fillRect(pillarX, barrier.y, 2, barrier.height);
            ctx.fillStyle = '#654321';
        }

        // 绘制顶部和底部横梁
        const beamHeight = 6;
        ctx.fillStyle = '#5D4037';

        // 顶部横梁
        ctx.fillRect(barrier.x, barrier.y, barrier.width, beamHeight);
        // 底部横梁
        ctx.fillRect(barrier.x, barrier.y + barrier.height - beamHeight, barrier.width, beamHeight);

        // 横梁高光
        ctx.fillStyle = 'rgba(210, 180, 140, 0.6)';
        ctx.fillRect(barrier.x, barrier.y, barrier.width, 2);
        ctx.fillRect(barrier.x, barrier.y + barrier.height - beamHeight, barrier.width, 2);

        // 绘制装饰性铁艺元素
        ctx.strokeStyle = '#2C1810';
        ctx.lineWidth = 2;

        // 主边框
        ctx.strokeStyle = '#2C1810';
        ctx.lineWidth = 2;
        ctx.strokeRect(barrier.x, barrier.y, barrier.width, barrier.height);

        // 临时状态的魔法光效
        ctx.strokeStyle = 'rgba(255, 215, 0, 0.8)';
        ctx.lineWidth = 2;

        // 外发光边框
        ctx.strokeRect(barrier.x - 2, barrier.y - 2, barrier.width + 4, barrier.height + 4);

        // 内发光效果
        ctx.shadowBlur = 4;
        ctx.strokeStyle = 'rgba(255, 215, 0, 0.4)';
        ctx.lineWidth = 1;
        ctx.strokeRect(barrier.x + 2, barrier.y + 2, barrier.width - 4, barrier.height - 4);

        ctx.restore();
    }

    // 清理初始栏杆缓存
    cleanupBarrierCache(barrierId, currentKey) {
        for (const [key] of this.barrierRenderCache) {
            if (key.startsWith(`${barrierId}_`) && key !== currentKey) {
                this.barrierRenderCache.delete(key);
            }
        }
    }

    // ==================== 护盾相关方法 ====================

    // 缓存版本的护盾绘制
    drawShieldCached(shield, playerX, playerY) {
        if (!shield.active) return;

        const img = window.imageLoader && window.imageLoader.get('shield_ring');
        if (img) {
            // 用精灵图替代矢量绘制：脉冲缩放 + 透明度模拟动画（与原 alpha=pulse 一致）
            const pulse = Math.sin(shield.pulsePhase) * 0.3 + 0.7;
            const shieldRadius = 15 * pulse;
            const drawSize = shieldRadius * 2;
            this.ctx.save();
            this.ctx.globalAlpha = pulse;
            this.ctx.drawImage(img, playerX - drawSize / 2, playerY - drawSize / 2, drawSize, drawSize);
            this.ctx.restore();
            return;
        }

        const stateHash = this.getShieldStateHash(shield);
        const cacheKey = `shield_${stateHash}`;

        // 检查状态是否变化
        if (this.lastShieldState === stateHash && this.shieldRenderCache.has(cacheKey)) {
            // 直接使用缓存的canvas
            const cached = this.shieldRenderCache.get(cacheKey);
            const cachedCanvas = cached.canvas;
            const size = cachedCanvas.width;
            this.ctx.drawImage(cachedCanvas, playerX - size / 2, playerY - size / 2);
            cached.timestamp = Date.now(); // 更新时间戳
            return;
        }

        // 创建离屏canvas进行绘制
        const pulse = Math.sin(shield.pulsePhase) * 0.3 + 0.7;
        const shieldRadius = 15 * pulse;
        const size = Math.ceil((shieldRadius + 10) * 2); // 留边距

        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = size;
        offscreenCanvas.height = size;
        const offCtx = offscreenCanvas.getContext('2d');

        // 在离屏canvas上绘制
        this.drawShieldToCanvas(offCtx, shield, size / 2, size / 2);

        // 缓存结果
        this.shieldRenderCache.set(cacheKey, { canvas: offscreenCanvas, timestamp: Date.now() });
        this.lastShieldState = stateHash;

        // 清理旧缓存（护盾缓存数量有限，可以保留更多）
        if (this.shieldRenderCache.size > 20) {
            const firstKey = this.shieldRenderCache.keys().next().value;
            this.shieldRenderCache.delete(firstKey);
        }

        // 绘制到主canvas
        this.ctx.drawImage(offscreenCanvas, playerX - size / 2, playerY - size / 2);
    }
    // 生成护盾状态哈希
    getShieldStateHash(shield) {
        // 将脉冲相位量化以减少缓存数量
        const quantizedPhase = Math.round(shield.pulsePhase * 10) / 10;
        return `${quantizedPhase}`;
    }

    // 在指定canvas上绘制护盾
    drawShieldToCanvas(ctx, shield, centerX, centerY) {
        ctx.save();

        // 护盾视觉效果
        const pulse = Math.sin(shield.pulsePhase) * 0.3 + 0.7;
        const shieldRadius = 15 * pulse;

        // 护盾圆环
        ctx.strokeStyle = `rgba(0, 255, 255, ${pulse})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(centerX, centerY, shieldRadius, 0, Math.PI * 2);
        ctx.stroke();

        // 内层护盾
        ctx.strokeStyle = `rgba(255, 255, 255, ${pulse * 0.5})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(centerX, centerY, shieldRadius - 3, 0, Math.PI * 2);
        ctx.stroke();

        // 护盾粒子效果
        for (let i = 0; i < 8; i++) {
            const angle = (shield.pulsePhase + i * Math.PI / 4) % (Math.PI * 2);
            const particleX = centerX + Math.cos(angle) * shieldRadius;
            const particleY = centerY + Math.sin(angle) * shieldRadius;

            ctx.fillStyle = `rgba(0, 255, 255, ${pulse})`;
            ctx.beginPath();
            ctx.arc(particleX, particleY, 2, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }

    // ==================== 缓存管理方法 ====================

    // 清理所有缓存
    clearAllCaches() {
        this.itemRenderCache.clear();
        this.obstacleRenderCache.clear();
        this.barrierRenderCache.clear();
        this.shieldRenderCache.clear();

        this.lastItemStates.clear();
        this.lastObstacleStates.clear();
        this.lastBarrierStates.clear();
        this.lastShieldState = null;
    }

    // 清理过期缓存
    cleanupExpiredCaches() {
        const now = Date.now();
        const caches = [
            this.itemRenderCache,
            this.obstacleRenderCache,
            this.barrierRenderCache,
            this.shieldRenderCache
        ];

        caches.forEach(cache => {
            for (const [key, value] of cache.entries()) {
                if (now - value.timestamp > this.cacheLifespan) {
                    cache.delete(key);
                }
            }
        });
    }

    // 清理特定对象的缓存
    clearObjectCache(objectId, type) {
        switch (type) {
            case 'item':
                this.cleanupItemCache(objectId, '');
                this.lastItemStates.delete(objectId);
                break;
            case 'obstacle':
                this.cleanupObstacleCache(objectId, '');
                this.lastObstacleStates.delete(objectId);
                break;
            case 'barrier':
                this.cleanupBarrierCache(objectId, '');
                this.lastBarrierStates.delete(objectId);
                break;
        }
    }

    // 获取缓存统计信息
    getCacheStats() {
        return {
            items: this.itemRenderCache.size,
            obstacles: this.obstacleRenderCache.size,
            barriers: this.barrierRenderCache.size,
            shields: this.shieldRenderCache.size,
            total: this.itemRenderCache.size + this.obstacleRenderCache.size +
                this.barrierRenderCache.size + this.shieldRenderCache.size
        };
    }

    // 绘制倒计时界面
    drawCountdown(countdown) {
        // 保存当前绘图状态
        this.ctx.save();

        // 添加全屏阴影效果
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)'; // 半透明黑色遮罩
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        // 设置字体和对齐方式
        this.ctx.font = 'bold 200px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';

        // 设置文本样式为红色
        this.ctx.fillStyle = '#ff0000';
        this.ctx.strokeStyle = '#ffffff';
        this.ctx.lineWidth = 3;

        // 添加阴影效果
        this.ctx.shadowColor = 'rgba(255, 0, 0, 0.8)';
        this.ctx.shadowBlur = 20;
        this.ctx.shadowOffsetX = 0;
        this.ctx.shadowOffsetY = 0;

        // 绘制倒计时数字
        const text = Math.ceil(countdown).toString();
        const x = this.canvas.width / 2;
        const y = this.canvas.height / 2;

        // 先绘制描边，再绘制填充以确保文字清晰
        this.ctx.strokeText(text, x, y);
        this.ctx.fillText(text, x, y);

        // 恢复绘图状态
        this.ctx.restore();
    }

    // 联机模式等待文本
    drawCountdownText(message) {
        this.ctx.save();
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.font = 'bold 32px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillStyle = '#00d4ff';
        this.ctx.strokeStyle = '#000';
        this.ctx.lineWidth = 2;
        const x = this.canvas.width / 2;
        const y = this.canvas.height / 2;
        this.ctx.strokeText(message, x, y);
        this.ctx.fillText(message, x, y);
        this.ctx.restore();
    }
}
