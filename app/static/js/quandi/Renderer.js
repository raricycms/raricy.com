class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
    }

    clear() {
        // 清空画布
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.fillStyle = '#f8f9fa';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // 绘制网格
        this.drawGrid();
    }

    drawGrid() {
        this.ctx.save();
        this.ctx.strokeStyle = '#e9ecef';
        this.ctx.lineWidth = 1;
        this.ctx.globalAlpha = 0.5;
        
        // 垂直线
        for (let x = 0; x <= this.canvas.width; x += 40) {
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, this.canvas.height);
            this.ctx.stroke();
        }
        
        // 水平线
        for (let y = 0; y <= this.canvas.height; y += 40) {
            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(this.canvas.width, y);
            this.ctx.stroke();
        }
        
        this.ctx.restore();
    }

    drawTerritories(territories, playerId, color) {
        if (!territories || territories.length === 0) return;

        this.ctx.save();
        
        territories.forEach(territory => {
            if (!territory || territory.length < 3) return;
            
            // 填充区域
            this.ctx.fillStyle = color + '30'; // 半透明
            this.ctx.beginPath();
            territory.forEach((point, index) => {
                if (index === 0) {
                    this.ctx.moveTo(point.x, point.y);
                } else {
                    this.ctx.lineTo(point.x, point.y);
                }
            });
            this.ctx.closePath();
            this.ctx.fill();
            
            // 边框
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth = 2;
            this.ctx.stroke();
        });
        
        this.ctx.restore();
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
        trail.forEach((point, index) => {
            if (index === 0) {
                this.ctx.moveTo(point.x, point.y);
            } else {
                this.ctx.lineTo(point.x, point.y);
            }
        });
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
        
        // 玩家阴影
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
        this.ctx.beginPath();
        this.ctx.arc(player.x + 2, player.y + 2, player.size, 0, Math.PI * 2);
        this.ctx.fill();

        // 玩家主体
        const gradient = this.ctx.createRadialGradient(
            player.x - 3, player.y - 3, 0,
            player.x, player.y, player.size
        );
        gradient.addColorStop(0, this.lightenColor(player.color, 40));
        gradient.addColorStop(1, player.color);
        
        this.ctx.fillStyle = gradient;
        this.ctx.beginPath();
        this.ctx.arc(player.x, player.y, player.size, 0, Math.PI * 2);
        this.ctx.fill();

        // 玩家边框
        this.ctx.strokeStyle = '#333';
        this.ctx.lineWidth = 3;
        this.ctx.beginPath();
        this.ctx.arc(player.x, player.y, player.size, 0, Math.PI * 2);
        this.ctx.stroke();

        // 玩家ID
        this.ctx.fillStyle = '#fff';
        this.ctx.font = 'bold 14px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.fillText(player.id.toString(), player.x, player.y);

        // 移动方向指示器
        if (player.direction.x !== 0 || player.direction.y !== 0) {
            const arrowX = player.x + player.direction.x * (player.size + 10);
            const arrowY = player.y + player.direction.y * (player.size + 10);
            
            this.ctx.fillStyle = player.color;
            this.ctx.beginPath();
            this.ctx.arc(arrowX, arrowY, 4, 0, Math.PI * 2);
            this.ctx.fill();
        }

        // 如果有碰撞效果，添加闪烁效果
        if (player.collisionEffect && player.collisionEffect.active) {
            const elapsed = Date.now() - player.collisionEffect.startTime;
            const flashInterval = 50; // 每50毫秒闪烁一次
            const shouldFlash = Math.floor(elapsed / flashInterval) % 2 === 0;
        
            if (shouldFlash) {
                this.ctx.shadowColor = '#FF0000';
                this.ctx.shadowBlur = 10;
            }
        }
        
        // 绘制护盾效果
        if (player.hasShield()) {
            player.shield.render(this, player.x, player.y);
        }

        this.ctx.restore();
        
    }
    
    drawSpawnPoint(x, y, color) {
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
}
