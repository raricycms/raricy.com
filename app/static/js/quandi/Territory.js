class Territory {
    constructor() {
        this.canvasWidth = 1200;
        this.canvasHeight = 600;
        this.areas = new Map(); // playerId -> areas[]
        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCanvas.width = this.canvasWidth;
        this.offscreenCanvas.height = this.canvasHeight;
        this.ctx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true });
        this.maxArea = this.canvasWidth * this.canvasHeight * 0.95;
    }

    calculateSignedArea(polygon) {
        let area = 0;
        for (let i = 0; i < polygon.length; i++) {
            const p1 = polygon[i];
            const p2 = polygon[(i + 1) % polygon.length]; // 获取下一个点，最后一个点连接回第一个点
            area += (p1.x * p2.y - p2.x * p1.y);
        }
        return area / 2; // 完整的鞋带公式结果是面积的一半
    }

    detectEnclosure(player) {
        if (player.trail.length < 20) return null; // 需要足够的点形成区域

        // 检查是否回到起始区域附近
        const trail = player.trail;
        const startArea = { x: player.startX, y: player.startY };
        const currentPos = { x: player.x, y: player.y };

        // 检查当前位置是否接近起始位置
        const distanceToStart = Math.sqrt(
            Math.pow(startArea.x - currentPos.x, 2) + Math.pow(startArea.y - currentPos.y, 2)
        );

        if (distanceToStart < 20) {
            // 形成封闭区域
            const area = [...trail, currentPos, startArea];
            const windingorder = this.calculateSignedArea(area);
            let clockwisearea = area;
            if (windingorder > 0) {
                clockwisearea = [...area].reverse();
            }
            this.addTerritory(player.id, clockwisearea);

            // 重置玩家状态
            player.trail = [];

            return area;
        }

        return null;
    }

    addTerritory(playerId, area) {
        if (!this.areas.has(playerId)) {
            this.areas.set(playerId, []);
        }
        this.areas.get(playerId).push(area);
    }

    getPlayerTerritories(playerId) {
        return this.areas.get(playerId) || [];
    }

    calculateTotalArea(playerId) {
        const territories = this.getPlayerTerritories(playerId);

        if (territories.length === 0) {
            return []; // 如果没有领地，返回空数组
        }
        const total_area = territories.flatMap(area => area);
        const total_area2 = [];
        total_area2.push(total_area)

        return total_area2;
    }

    calculateScore(playerId, canvasWidth, canvasHeight) {
        const territories = this.getPlayerTerritories(playerId);
        if (territories.length === 0) return 0;

        // 生成territories的哈希值作为缓存键
        const territoriesHash = this.generateTerritoriesHash(territories, canvasWidth, canvasHeight);
        const cacheKey = `${playerId}_${territoriesHash}`;

        // 检查缓存
        if (this.scoreCache && this.scoreCache[cacheKey] !== undefined) {
            return this.scoreCache[cacheKey];
        }

        // 执行计算
        const score = this.computeScore(territories, canvasWidth, canvasHeight);

        // 缓存结果
        if (!this.scoreCache) this.scoreCache = {};
        this.scoreCache[cacheKey] = score;

        return score;
    }

    // 生成territories的哈希值
    generateTerritoriesHash(territories, canvasWidth, canvasHeight) {
        const str = JSON.stringify({
            territories: territories.map(territory =>
                territory.map(point => `${point.x},${point.y}`).join('|')
            ).join(';'),
            canvas: `${canvasWidth}x${canvasHeight}`
        });

        // 简单哈希函数
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 转换为32位整数
        }
        return hash.toString();
    }

    // 将原来的计算逻辑提取到单独的方法
    computeScore(territories, canvasWidth, canvasHeight) {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
        ctx.fillStyle = 'black';

        for (const territory of territories) {
            if (territory.length < 3) continue;

            ctx.beginPath();
            ctx.moveTo(territory[0].x, territory[0].y);
            for (let i = 1; i < territory.length; i++) {
                ctx.lineTo(territory[i].x, territory[i].y);
            }
            ctx.closePath();
            ctx.fill();
        }

        const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
        const data = imageData.data;
        let totalArea = 0;
        const step = 2; // 采样精度

        for (let y = 0; y < this.canvasHeight; y += step) {
            for (let x = 0; x < this.canvasWidth; x += step) {
                const index = ((y * this.canvasWidth) + x) * 4 + 3;
                if (data[index] > 0) totalArea += step * step;
            }
        }

        return Math.min(100, (totalArea / this.maxArea) * 100);
    }

    reset() {
        this.areas.clear();
    }
}
