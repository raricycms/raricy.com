// 管理员控制管理类
class AdminControlsManager {
    constructor() {
        this.likersBtn = document.getElementById('admin-likers-btn');
        this.feedersBtn = document.getElementById('admin-feeders-btn');
        this.deleteBtn = document.getElementById('admin-delete-btn');

        this.init();
    }

    init() {
        // 绑定点赞者列表按钮事件
        if (this.likersBtn) {
            this.likersBtn.addEventListener('click', () => this.openLikersModal());
        }

        // 绑定投喂者列表按钮事件
        if (this.feedersBtn) {
            this.feedersBtn.addEventListener('click', () => this.openFeedersModal());
        }

        // 绑定删除按钮事件
        if (this.deleteBtn) {
            this.deleteBtn.addEventListener('click', () => this.openDeleteModal());
        }
    }

    // 打开点赞者列表模态框
    openLikersModal() {
        if (window.modalSystem) {
            window.modalSystem.openModalById('likersModal');
            this.loadLikers();
        } else {
            console.error('Modal system not initialized');
        }
    }

    // 加载点赞者列表
    async loadLikers(page = 1) {
        const likersList = document.getElementById('likers-list');
        const pageInfo = document.getElementById('likers-pageinfo');
        const prevBtn = document.getElementById('likers-prev');
        const nextBtn = document.getElementById('likers-next');

        if (!likersList || !this.likersBtn) return;

        likersList.innerHTML = '<div class="text-muted">加载中...</div>';

        try {
            // 后端API使用offset/limit参数，而不是page参数
            const limit = 20; // 每页显示20个点赞者
            const offset = (page - 1) * limit;
            const url = `${this.likersBtn.dataset.likersUrl}?offset=${offset}&limit=${limit}`;

            const response = await fetch(url, { credentials: 'same-origin' });
            const data = await response.json();

            if (data.code === 200) {
                // 后端API返回的数据结构：users数组，包含用户信息
                const likers = data.users || data.data?.users || [];
                const totalCount = data.total || data.data?.total || 0;
                const totalPages = Math.ceil(totalCount / limit);

                this.renderLikers(likers, { page, pages: totalPages, total: totalCount });

                // 更新分页信息
                if (pageInfo) {
                    pageInfo.textContent = `第 ${page} 页，共 ${totalPages} 页`;
                }

                // 绑定分页按钮事件
                if (prevBtn) {
                    prevBtn.onclick = () => this.loadLikers(page - 1);
                    prevBtn.disabled = page <= 1;
                }

                if (nextBtn) {
                    nextBtn.onclick = () => this.loadLikers(page + 1);
                    nextBtn.disabled = page >= totalPages;
                }
            } else {
                likersList.innerHTML = `<div class="text-danger">加载失败: ${data.message || '未知错误'}</div>`;
                console.error('点赞者列表加载失败:', data);
            }
        } catch (error) {
            likersList.innerHTML = '<div class="text-danger">网络错误，请稍后重试</div>';
            console.error('点赞者列表加载异常:', error);
        }
    }

    // 打开投喂者列表模态框
    openFeedersModal() {
        if (window.modalSystem) {
            window.modalSystem.openModalById('feedersModal');
            this.loadFeeders();
        } else {
            console.error('Modal system not initialized');
        }
    }

    // 加载投喂者列表
    async loadFeeders(page = 1) {
        const listEl = document.getElementById('feeders-list');
        const pageInfo = document.getElementById('feeders-pageinfo');
        const prevBtn = document.getElementById('feeders-prev');
        const nextBtn = document.getElementById('feeders-next');

        if (!listEl || !this.feedersBtn) return;

        listEl.innerHTML = '<div class="text-muted">加载中...</div>';

        try {
            const limit = 20;
            const offset = (page - 1) * limit;
            const url = `${this.feedersBtn.dataset.feedersUrl}?offset=${offset}&limit=${limit}`;

            const response = await fetch(url, { credentials: 'same-origin' });
            const data = await response.json();

            if (data.code === 200) {
                const feeders = data.feeders || [];
                const totalCount = data.total || 0;
                const totalPages = Math.ceil(totalCount / limit);

                this.renderFeeders(feeders);

                if (pageInfo) {
                    pageInfo.textContent = `第 ${page} 页，共 ${totalPages} 页`;
                }

                if (prevBtn) {
                    prevBtn.onclick = () => this.loadFeeders(page - 1);
                    prevBtn.disabled = page <= 1;
                }

                if (nextBtn) {
                    nextBtn.onclick = () => this.loadFeeders(page + 1);
                    nextBtn.disabled = page >= totalPages;
                }
            } else {
                listEl.innerHTML = `<div class="text-danger">加载失败: ${data.message || '未知错误'}</div>`;
            }
        } catch (error) {
            listEl.innerHTML = '<div class="text-danger">网络错误，请稍后重试</div>';
        }
    }

    // 渲染投喂者列表
    renderFeeders(feeders) {
        const listEl = document.getElementById('feeders-list');
        if (!listEl) return;

        if (feeders.length === 0) {
            listEl.innerHTML = '<div class="text-muted">暂无投喂者</div>';
            return;
        }

        const fragment = document.createDocumentFragment();

        feeders.forEach(f => {
            const item = document.createElement('div');
            item.className = 'list-group-item';

            const username = f.username || '未知用户';
            const avatarUrl = f.avatar_path
                ? `/auth/avatar/${f.user_id}`
                : '/static/img/default-avatar.png';

            item.innerHTML = `
                <div class="d-flex align-items-center justify-content-between">
                    <div class="d-flex align-items-center">
                        <img src="${avatarUrl}" alt="${username}"
                             style="width: 32px; height: 32px; border-radius: 4px; margin-right: 10px;">
                        <strong>${username}</strong>
                    </div>
                    <span class="badge" style="background: var(--color-brand-secondary); color: var(--color-brand-primary); font-size: 0.9rem;">
                        🐟 ${f.amount}
                    </span>
                </div>
            `;

            fragment.appendChild(item);
        });

        listEl.innerHTML = '';
        listEl.appendChild(fragment);
    }

    // 渲染点赞者列表
    renderLikers(likers, pagination) {
        const likersList = document.getElementById('likers-list');
        if (!likersList) return;

        if (likers.length === 0) {
            likersList.innerHTML = '<div class="text-muted">暂无点赞者</div>';
            return;
        }

        const fragment = document.createDocumentFragment();

        likers.forEach(liker => {
            const item = document.createElement('div');
            item.className = 'list-group-item';

            // 后端API返回的用户信息字段：id, username, avatar_url, liked_at
            const username = liker.username || '匿名用户';
            const avatarUrl = liker.avatar_url || `/auth/avatar/${liker.id}`;
            const likedAt = liker.liked_at || '';

            const content = `
                <div class="d-flex align-items-center">
                    <img src="${avatarUrl}" alt="${username}"
                         style="width: 32px; height: 32px; border-radius: 4px; margin-right: 10px;">
                    <div class="d-flex align-items-center">
                        <strong>${username}</strong>
                    </div>
                </div>
            `;

            item.innerHTML = content;
            fragment.appendChild(item);
        });

        likersList.innerHTML = '';
        likersList.appendChild(fragment);
    }

    // 打开删除确认模态框
    openDeleteModal() {
        if (window.modalSystem) {
            window.modalSystem.openModalById('deleteConfirmModal');
        } else {
            console.error('Modal system not initialized');
        }
    }

    // 执行文章删除
    async performDelete() {
        const confirmBtn = document.getElementById('confirm-delete-btn');
        const reasonInput = document.getElementById('delete-reason');

        if (!this.deleteBtn || !confirmBtn) return;

        // 检查是否需要填写删除原因
        let payload = undefined;
        if (reasonInput && reasonInput.style.display !== 'none') {
            const reason = reasonInput.value.trim();
            if (!reason) {
                if (typeof showToast === 'function') {
                    showToast('请填写删除原因', 'warning');
                }
                return;
            }
            payload = JSON.stringify({ reason });
        }

        confirmBtn.disabled = true;

        try {
            const response = await fetch(this.deleteBtn.dataset.deleteUrl, {
                method: 'DELETE',
                headers: payload ? { 'Content-Type': 'application/json' } : undefined,
                credentials: 'same-origin',
                body: payload
            });

            const data = await response.json();

            if (data.code === 200) {
                if (typeof showToast === 'function') {
                    showToast('文章已删除', 'success');
                }

                // 跳转到指定页面
                const redirectUrl = this.deleteBtn.dataset.redirectUrl || '/blog';
                window.location.href = redirectUrl;
            } else {
                if (typeof showToast === 'function') {
                    showToast(data.message || '删除失败', 'error');
                }
            }
        } catch (error) {
            if (typeof showToast === 'function') {
                showToast('网络错误，请稍后重试', 'error');
            }
        } finally {
            confirmBtn.disabled = false;
        }
    }

    // 时间格式化
    formatTime(isoString) {
        if (!isoString) return '';
        try {
            const date = new Date(isoString);
            return date.toLocaleString();
        } catch {
            return isoString;
        }
    }
}

// 初始化管理员控制
document.addEventListener('DOMContentLoaded', function() {
    window.adminControlsManager = new AdminControlsManager();
});
