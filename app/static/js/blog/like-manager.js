// 点赞系统管理类
class LikeManager {
    constructor() {
        this.likeBtn = document.getElementById('like-btn');
        if (!this.likeBtn) return;

        this.config = {
            isAuthenticated: this.likeBtn.dataset.auth === '1',
            loginUrl: this.likeBtn.dataset.loginUrl,
            likeUrl: this.likeBtn.dataset.likeUrl
        };

        this.elements = {
            icon: document.getElementById('like-icon'),
            text: document.getElementById('like-text'),
            count: document.getElementById('like-count')
        };

        this.init();
    }

    init() {
        if (!this.likeBtn) return;

        this.likeBtn.addEventListener('click', () => this.handleLike());
    }

    // 处理点赞操作
    async handleLike() {
        // 检查用户是否已登录
        if (!this.config.isAuthenticated) {
            if (typeof showToast === 'function') {
                showToast('请先登录后再点赞', 'info');
            }
            window.location.href = this.config.loginUrl;
            return;
        }

        // 禁用按钮防止重复点击
        this.likeBtn.disabled = true;

        try {
            const response = await fetch(this.config.likeUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin'
            });

            const data = await response.json();

            if (data.code === 200) {
                const liked = !!data.liked;

                // 更新UI状态
                this.updateLikeState(liked, data.likes_count);

                // 显示操作反馈
                if (typeof showToast === 'function') {
                    showToast(liked ? '已点赞' : '已取消点赞', liked ? 'success' : 'info');
                }
            } else {
                // 操作失败
                if (typeof showToast === 'function') {
                    showToast(data.message || '操作失败', 'error');
                }
            }
        } catch (error) {
            // 网络错误
            if (typeof showToast === 'function') {
                showToast('网络错误，请稍后重试', 'error');
            }
        } finally {
            // 重新启用按钮
            this.likeBtn.disabled = false;
        }
    }

    // 更新点赞状态
    updateLikeState(liked, likesCount) {
        // 更新点赞数
        if (this.elements.count) {
            this.elements.count.textContent = likesCount;
        }

        // 更新图标
        if (this.elements.icon) {
            this.elements.icon.className = 'bi ' + (liked ? 'bi-heart-fill' : 'bi-heart');
        }

        // 更新文本
        if (this.elements.text) {
            this.elements.text.textContent = liked ? '已点赞' : '点赞';
        }

        // 更新按钮样式
        this.likeBtn.classList.toggle('liked', liked);
    }
}

// 初始化点赞系统
document.addEventListener('DOMContentLoaded', function() {
    new LikeManager();
});
