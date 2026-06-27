/**
 * FeedFishManager — 两步投喂：先选数量，再确认。
 */
class FeedFishManager {
    constructor() {
        this.btn = document.getElementById('feed-fish-btn');
        if (!this.btn) return;

        this.config = {
            isAuth: this.btn.dataset.auth === '1',
            isCore: this.btn.dataset.isCore === '1',
            loginUrl: this.btn.dataset.loginUrl,
            feedUrl: this.btn.dataset.feedUrl,
            statusUrl: this.btn.dataset.statusUrl,
        };

        this.countEl = document.getElementById('fish-count');
        this.modal = document.getElementById('feedModal');
        this.statusEl = document.getElementById('feedModalStatus');
        this.buttonsEl = document.getElementById('feedButtons');
        this.confirmBtn = document.getElementById('feedConfirmBtn');

        this.fed = 0;
        this.remaining = 5;
        this.selectedAmount = 0;

        this.init();
    }

    init() {
        this.fetchStatus().then(() => this.updateButton());
        this.btn.addEventListener('click', () => this.openModal());

        // 选择数量
        this.buttonsEl.addEventListener('click', (e) => {
            const b = e.target.closest('.feed-modal__amount-btn');
            if (b && !b.disabled) this.selectAmount(parseInt(b.dataset.amount));
        });

        // 确认投喂
        this.confirmBtn.addEventListener('click', () => {
            if (this.selectedAmount > 0) this.doFeed(this.selectedAmount);
        });

        // 关闭
        document.getElementById('feedCancelBtn').addEventListener('click', () => this.closeModal());
        if (this.modal) {
            this.modal.querySelector('.feed-modal__backdrop').addEventListener('click', () => this.closeModal());
        }
    }

    async fetchStatus() {
        try {
            const resp = await fetch(this.config.statusUrl, { credentials: 'same-origin' });
            const data = await resp.json();
            if (data.code === 200) {
                this.fed = data.fed ?? 0;
                this.remaining = data.remaining ?? 5;
            }
        } catch (e) {
            console.error('FeedFishManager: fetch status failed', e);
        }
    }

    updateButton() {
        if (!this.config.isAuth) return;
        if (this.fed >= 5) this.btn.disabled = true;
        if (this.fed > 0) this.btn.classList.add('fish-btn--fed');
    }

    updateCount(count) {
        if (this.countEl) this.countEl.textContent = count;
        if (this.btn && this.fed > 0) this.btn.classList.add('fish-btn--fed');
    }

    openModal() {
        if (!this.config.isAuth) {
            window.location.href = this.config.loginUrl;
            return;
        }
        if (!this.config.isCore) {
            window.showToast('仅核心用户可投喂小鱼干', 'warning');
            return;
        }
        if (this.fed >= 5) {
            window.showToast('已投满 5 条，不能再投了', 'info');
            return;
        }

        this.fetchStatus().then(() => {
            this.statusEl.textContent = `已投 ${this.fed}/5，还可投喂 ${this.remaining} 条`;
            this.selectedAmount = 0;
            this.confirmBtn.disabled = true;

            const btns = this.buttonsEl.querySelectorAll('.feed-modal__amount-btn');
            btns.forEach(b => {
                b.classList.remove('feed-modal__amount-btn--selected');
                b.disabled = parseInt(b.dataset.amount) > this.remaining;
            });

            this.modal.classList.add('feed-modal--open');
        });
    }

    selectAmount(n) {
        this.selectedAmount = n;
        this.statusEl.textContent = `已投 ${this.fed}/5，投喂 ${n} 条`;
        this.confirmBtn.disabled = false;

        this.buttonsEl.querySelectorAll('.feed-modal__amount-btn').forEach(b => {
            b.classList.toggle('feed-modal__amount-btn--selected', parseInt(b.dataset.amount) === n);
        });
    }

    closeModal() {
        this.modal.classList.remove('feed-modal--open');
        this.selectedAmount = 0;
    }

    async doFeed(amount) {
        try {
            const btns = this.buttonsEl.querySelectorAll('.feed-modal__amount-btn');
            btns.forEach(b => b.disabled = true);
            this.confirmBtn.disabled = true;
            this.statusEl.textContent = '投喂中...';

            const resp = await fetch(this.config.feedUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ amount }),
            });
            const data = await resp.json();

            if (data.code === 200) {
                this.fed = data.fed_total;
                this.remaining = data.remaining;
                this.updateButton();
                this.updateCount(data.fish_count);
                this.closeModal();
                window.showToast(`投喂成功！消耗 ${amount} 条小鱼干`, 'success');
            } else {
                window.showToast(data.message || '投喂失败', 'error');
                // 恢复选择状态
                this.confirmBtn.disabled = false;
                btns.forEach(b => {
                    b.disabled = parseInt(b.dataset.amount) > this.remaining;
                });
            }
        } catch (e) {
            console.error('FeedFishManager: feed failed', e);
            window.showToast('网络错误，请重试', 'error');
        }
    }
}


document.addEventListener('DOMContentLoaded', () => {
    new FeedFishManager();
});
