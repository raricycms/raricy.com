class Territory {
    constructor() {
        this.areas = new Map(); // playerId -> areas[]
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

        if (distanceToStart < 40) {
            // 形成封闭区域
            const area = [...trail, currentPos, startArea]; // 闭合路径
            this.addTerritory(player.id, area);
            
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

    calculateScore(playerId, canvasWidth, canvasHeight) {
        const territories = this.getPlayerTerritories(playerId);
        if (territories.length === 0) return 0;

        const offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = canvasWidth;
        offscreenCanvas.height = canvasHeight;
        const ctx = offscreenCanvas.getContext('2d', { willReadFrequently: true });

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

        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 0) { // Check alpha channel for non-transparent pixels
                totalArea++;
            }
        }

        const maxArea = canvasWidth * canvasHeight;
        return Math.min(100, (totalArea / maxArea) * 100);
    }

    reset() {
        this.areas.clear();
    }
}
