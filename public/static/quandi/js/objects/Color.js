class ColorManager {
    constructor() {
        this.selectedColors = {
            player1: Config.UI_STYLES.playerColors.player1,
            player2: Config.UI_STYLES.playerColors.player2
        };
        this.colorHistory = {
            player1: [],
            player2: []
        };
        this.MAX_HISTORY = 6;
    }

    setupColorSelection() {
        if (this.selectionBound) { this.updateColorHarmony(); return; }
        this.selectionBound = true;
        // 为每个玩家设置颜色选择器
        [1, 2].forEach(playerId => {
            const playerSection = document.querySelector(`.player-color-section[data-player="${playerId}"]`);
            if (!playerSection) return;

            // 预设颜色选择
            playerSection.querySelectorAll('.color-option').forEach(option => {
                option.addEventListener('click', () => {
                    this.selectColor(playerId, option.dataset.color, option);
                    this.addToColorHistory(playerId, option.dataset.color);
                    this.updateCustomColorPicker(playerId, option.dataset.color);
                    this.updateColorHarmony();
                });
            });

            // 自定义颜色选择器
            const customColorInput = document.getElementById(`player${playerId}CustomColor`);
            if (customColorInput) {
                customColorInput.addEventListener('input', () => {
                    this.selectColor(playerId, customColorInput.value);
                    this.addToColorHistory(playerId, customColorInput.value);
                    this.updateHSLSliders(playerId, customColorInput.value);
                    this.updateColorHarmony();
                });
            }

            // HSL滑块
            const hueSlider = document.getElementById(`player${playerId}Hue`);
            const saturationSlider = document.getElementById(`player${playerId}Saturation`);
            const lightnessSlider = document.getElementById(`player${playerId}Lightness`);

            if (hueSlider && saturationSlider && lightnessSlider) {
                [hueSlider, saturationSlider, lightnessSlider].forEach(slider => {
                    slider.addEventListener('input', () => {
                        const hsl = {
                            h: parseInt(hueSlider.value),
                            s: parseInt(saturationSlider.value),
                            l: parseInt(lightnessSlider.value)
                        };
                        const hex = this.hslToHex(hsl.h, hsl.s, hsl.l);
                        this.selectColor(playerId, hex);
                        this.addToColorHistory(playerId, hex);
                        customColorInput.value = hex;
                        this.updateColorHarmony();
                    });
                });
            }
        });

        // 只更新颜色和谐度显示
        this.updateColorHarmony();
    }

    selectColor(playerId, color, element = null) {
        // 移除该玩家所有颜色选项的选中状态
        const playerSection = document.querySelector(`.player-color-section[data-player="${playerId}"]`);
        playerSection.querySelectorAll('.color-option').forEach(opt => opt.classList.remove('selected'));

        // 如果是通过点击预设颜色选择的，添加选中状态
        if (element) {
            element.classList.add('selected');
        }

        // 更新选中的颜色
        this.selectedColors[`player${playerId}`] = color;

        // 添加视觉反馈
        this.addColorSelectionFeedback(playerId, color);
    }

    addColorSelectionFeedback(playerId, color) {
        const playerSection = document.querySelector(`.player-color-section[data-player="${playerId}"]`);

        // 创建临时的高亮效果
        const feedback = document.createElement('div');
        feedback.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: ${color}22;
            border: 2px solid ${color};
            border-radius: 15px;
            pointer-events: none;
            z-index: 10;
            animation: colorSelectionPulse 0.6s ease-out;
        `;

        playerSection.appendChild(feedback);

        // 添加动画样式
        if (!document.getElementById('colorSelectionAnimation')) {
            const style = document.createElement('style');
            style.id = 'colorSelectionAnimation';
            style.textContent = `
                @keyframes colorSelectionPulse {
                    0% { opacity: 0; transform: scale(0.95); }
                    50% { opacity: 1; transform: scale(1.02); }
                    100% { opacity: 0; transform: scale(1); }
                }
            `;
            document.head.appendChild(style);
        }

        setTimeout(() => feedback.remove(), 600);
    }

    addToColorHistory(playerId, color) {
        const history = this.colorHistory[`player${playerId}`];

        // 移除重复的颜色
        const index = history.indexOf(color);
        if (index > -1) {
            history.splice(index, 1);
        }

        // 添加到历史记录开头
        history.unshift(color);

        // 限制历史记录长度
        if (history.length > this.MAX_HISTORY) {
            history.pop();
        }

        // 这里可以添加显示历史记录的UI更新逻辑
    }

    updateCustomColorPicker(playerId, color) {
        const customColorInput = document.getElementById(`player${playerId}CustomColor`);
        if (customColorInput) {
            customColorInput.value = color || '#000000';
            this.updateHSLSliders(playerId, color || '#000000');
        }
    }

    updateHSLSliders(playerId, color) {
        if (!color) {
            // 如果颜色为空，设置默认HSL值
            document.getElementById(`player${playerId}Hue`).value = 0;
            document.getElementById(`player${playerId}Saturation`).value = 100;
            document.getElementById(`player${playerId}Lightness`).value = 50;
            return;
        }

        const hsl = this.hexToHsl(color);
        if (hsl) {
            const hueSlider = document.getElementById(`player${playerId}Hue`);
            const saturationSlider = document.getElementById(`player${playerId}Saturation`);
            const lightnessSlider = document.getElementById(`player${playerId}Lightness`);

            if (hueSlider) hueSlider.value = hsl.h;
            if (saturationSlider) saturationSlider.value = hsl.s;
            if (lightnessSlider) lightnessSlider.value = hsl.l;
        }
    }

    updateColorHarmony() {
        const color1 = this.selectedColors.player1;
        const color2 = this.selectedColors.player2;
        const harmonyFill = document.querySelector('.harmony-fill');
        const harmonyStatus = document.querySelector('.harmony-status');

        // 如果任一玩家没有选择颜色，显示提示信息
        if (!color1 || !color2) {
            harmonyFill.style.width = '0%';
            harmonyFill.style.background = 'linear-gradient(90deg, #ddd, #bbb)';
            harmonyStatus.textContent = '请先选择两个玩家的颜色';
            return;
        }

        const harmony = this.calculateColorHarmony(color1, color2);
        harmonyFill.style.width = harmony.score + '%';

        // 根据颜色区分度显示不同的状态文本
        let statusText = '颜色区分度: ';
        if (harmony.score >= 80) {
            statusText += '极佳';
            harmonyFill.style.background = 'linear-gradient(90deg, #4ecdc4, #44a08d)';
        } else if (harmony.score >= 60) {
            statusText += '良好';
            harmonyFill.style.background = 'linear-gradient(90deg, #ffd89b, #19547b)';
        } else if (harmony.score >= 40) {
            statusText += '一般';
            harmonyFill.style.background = 'linear-gradient(90deg, #ff9a9e, #fecfef)';
        } else if (harmony.score >= 20) {
            statusText += '较差';
            harmonyFill.style.background = 'linear-gradient(90deg, #ff6b6b, #ee5a24)';
        } else {
            statusText += '极差';
            harmonyFill.style.background = 'linear-gradient(90deg, #ff3b3b, #cc2929)';
        }

        harmonyStatus.textContent = statusText;
    }

    calculateColorHarmony(color1, color2) {
        // 如果任一颜色为空，返回0分
        if (!color1 || !color2) {
            return {
                score: 0,
                distance: 0,
                hueDiff: 0
            };
        }

        const rgb1 = this.hexToRgb(color1);
        const rgb2 = this.hexToRgb(color2);

        // 如果颜色转换失败，返回0分
        if (!rgb1 || !rgb2) {
            return {
                score: 0,
                distance: 0,
                hueDiff: 0
            };
        }

        // 计算颜色距离
        const distance = Math.sqrt(
            Math.pow(rgb1.r - rgb2.r, 2) +
            Math.pow(rgb1.g - rgb2.g, 2) +
            Math.pow(rgb1.b - rgb2.b, 2)
        );

        // 计算色相差异
        const hsl1 = this.hexToHsl(color1);
        const hsl2 = this.hexToHsl(color2);
        let hueDiff = 0;

        if (hsl1 && hsl2) {
            hueDiff = Math.abs(hsl1.h - hsl2.h);
            hueDiff = Math.min(hueDiff, 360 - hueDiff);
        }

        // 综合评分 (0-100) - 颜色差异越大得分越高，因为在对战时更容易看清
        const distanceScore = Math.min(100, distance / 4.41); // 距离越大得分越高
        const hueScore = Math.min(100, hueDiff / 3.6); // 色相差异越大得分越高（最大360度）

        const finalScore = (distanceScore * 0.5 + hueScore * 0.5);

        return {
            score: Math.round(finalScore),
            distance: distance,
            hueDiff: hueDiff
        };
    }

    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    }

    rgbToHsl(r, g, b) {
        r /= 255;
        g /= 255;
        b /= 255;

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;

        if (max === min) {
            h = s = 0;
        } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }

        return {
            h: Math.round(h * 360),
            s: Math.round(s * 100),
            l: Math.round(l * 100)
        };
    }

    hexToHsl(hex) {
        const rgb = this.hexToRgb(hex);
        return this.rgbToHsl(rgb.r, rgb.g, rgb.b);
    }

    hslToHex(h, s, l) {
        h /= 360;
        s /= 100;
        l /= 100;

        let r, g, b;

        if (s === 0) {
            r = g = b = l;
        } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            };

            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1/3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1/3);
        }

        const toHex = x => {
            const hex = Math.round(x * 255).toString(16);
            return hex.length === 1 ? '0' + hex : hex;
        };

        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }

    getPlayerColor(playerId) {
        const color = this.selectedColors[`player${playerId}`];
        // 如果没有选择颜色，返回默认颜色
        return color || (playerId === 1 ? '#E6194B' : '#4363D8');
    }

    setPlayerColor(playerId, color) {
        this.selectedColors[`player${playerId}`] = color;
    }
}

// 创建全局颜色管理器实例
const colorManager = new ColorManager();

// 为了向后兼容，将一些函数暴露到全局作用域
window.setupColorSelection = () => colorManager.setupColorSelection();
window.selectColor = (playerId, color, element) => colorManager.selectColor(playerId, color, element);
window.updateColorHarmony = () => colorManager.updateColorHarmony();
window.addToColorHistory = (playerId, color) => colorManager.addToColorHistory(playerId, color);
window.updateCustomColorPicker = (playerId, color) => colorManager.updateCustomColorPicker(playerId, color);
window.updateHSLSliders = (playerId, color) => colorManager.updateHSLSliders(playerId, color);
window.hexToRgb = (hex) => colorManager.hexToRgb(hex);
window.rgbToHsl = (r, g, b) => colorManager.rgbToHsl(r, g, b);
window.hexToHsl = (hex) => colorManager.hexToHsl(hex);
window.hslToHex = (h, s, l) => colorManager.hslToHex(h, s, l);
window.calculateColorHarmony = (color1, color2) => colorManager.calculateColorHarmony(color1, color2);
