// ImageLoader — 预加载 /image 下的精灵图，供渲染器用 drawImage 替代程序化矢量绘制。
// 全局单例：window.ImageLoader。图片为 PNG 透明底，加载失败时 isLoaded(name) 返回 false，
// 调用方应回退到原程序化绘制。
class ImageLoader {
    constructor() {
        // 精灵图清单（与 plans/optimization-images.md 对应）
        this.imagePaths = {
            obstacle: '/static/quandi/image/obstacle.png',
            initial_barrier: '/static/quandi/image/initial_barrier.png',
            item_speed: '/static/quandi/image/item_speed.png',
            item_length: '/static/quandi/image/item_length.png',
            item_shield: '/static/quandi/image/item_shield.png',
            tank_template: '/static/quandi/image/tank_template.png',
            spawn_point_template: '/static/quandi/image/spawn_point_template.png',
            moon: '/static/quandi/image/moon.png',
            flag: '/static/quandi/image/flag.png',
            enemy_red: '/static/quandi/image/enemy_red.png',
            enemy_relax: '/static/quandi/image/enemy_relax.png',
            shield_ring: '/static/quandi/image/shield_ring.png'
        };

        this.images = {};       // name -> HTMLImageElement（未加载完为 null）
        this.loadedCount = 0;
        this.totalCount = Object.keys(this.imagePaths).length;
        this.loaded = false;    // 全部加载完成

        this._loadAll();
    }

    _loadAll() {
        for (const [name, path] of Object.entries(this.imagePaths)) {
            const img = new Image();
            img.onload = () => {
                this.images[name] = img;
                this.loadedCount++;
                if (this.loadedCount === this.totalCount) this.loaded = true;
            };
            img.onerror = () => {
                // 加载失败：标记为已计数，避免 loaded 永假；具体图片 isLoaded 为 false
                this.loadedCount++;
                if (this.loadedCount === this.totalCount) this.loaded = true;
            };
            img.src = path;
        }
    }

    isLoaded(name) {
        return !!this.images[name];
    }

    get(name) {
        return this.images[name] || null;
    }

    // 全部加载完成（含失败项）
    isReady() {
        return this.loaded;
    }
}

window.ImageLoader = ImageLoader;
window.imageLoader = new ImageLoader();
