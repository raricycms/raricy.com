// 投票嵌入组件
class VoteEmbed {
    constructor() {
        this.initialized = false;
    }

    init() {
        if (this.initialized) return;
        const embeds = document.querySelectorAll('.vote-embed[data-vote-id]');
        if (embeds.length === 0) return;
        embeds.forEach(el => this.renderEmbed(el));
        this.initialized = true;
    }

    async renderEmbed(container) {
        const voteId = container.getAttribute('data-vote-id');
        try {
            const resp = await fetch(`/vote/${voteId}?raw`);
            if (!resp.ok) throw new Error('fetch failed');
            const json = await resp.json();
            const data = json.data;
            container.innerHTML = this.buildWidget(voteId, data);
            this.attachHandlers(container, voteId, data);
        } catch (e) {
            container.innerHTML = '<a href="/vote/' + voteId + '" class="vote-embed-fallback">[查看投票]</a>';
        }
    }

    buildWidget(voteId, data) {
        const total = data.total_votes || 0;
        const canVote = !data.is_locked && !data.user_voted;
        let html = '<div class="vote-embed-widget">';
        html += '<div class="vote-embed-title">' + this.escapeHtml(data.title) + '</div>';
        if (data.is_locked) {
            html += '<span class="vote-embed-badge badge-locked">已锁定</span>';
        }

        if (!canVote) {
            html += '<div class="vote-embed-total">共 ' + total + ' 票</div>';
        }

        for (const opt of data.options) {
            const pct = opt.percentage || 0;
            const isVoted = data.user_voted === opt.id;
            if (canVote) {
                html += '<div class="vote-embed-option" data-option-id="' + opt.id + '">';
                html += '<div class="vote-embed-option-content">';
                html += '<span class="vote-embed-option-label">' + this.escapeHtml(opt.label) + '</span>';
                html += '</div></div>';
            } else {
                html += '<div class="vote-embed-option vote-embed-option--result' + (isVoted ? ' vote-embed-option--voted' : '') + '">';
                html += '<div class="vote-embed-bar" style="width:' + pct + '%"></div>';
                html += '<div class="vote-embed-option-content">';
                html += '<span class="vote-embed-option-label">' + this.escapeHtml(opt.label) + '</span>';
                html += '<span class="vote-embed-option-stats">' + opt.count + ' 票 ' + pct + '%</span>';
                html += '</div></div>';
            }
        }

        if (canVote) {
            html += '<button class="vote-embed-submit" disabled>投票</button>';
        }

        html += '<a class="vote-embed-link" href="/vote/' + voteId + '" target="_blank">查看详情</a>';
        html += '</div>';
        return html;
    }

    attachHandlers(container, voteId, data) {
        if (data.is_locked || data.user_voted) return;
        const options = container.querySelectorAll('.vote-embed-option[data-option-id]');
        const submitBtn = container.querySelector('.vote-embed-submit');
        let selectedOptionId = null;

        options.forEach(opt => {
            opt.addEventListener('click', () => {
                options.forEach(o => o.classList.remove('vote-embed-option--selected'));
                opt.classList.add('vote-embed-option--selected');
                selectedOptionId = parseInt(opt.getAttribute('data-option-id'));
                submitBtn.disabled = false;
            });
        });

        submitBtn.addEventListener('click', async () => {
            if (!selectedOptionId) return;
            submitBtn.disabled = true;
            submitBtn.textContent = '投票中……';
            try {
                const resp = await fetch('/vote/' + voteId + '/cast', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ option_id: selectedOptionId })
                });
                const result = await resp.json();
                if (resp.ok && result.code === 200) {
                    await this.renderEmbed(container);
                } else {
                    alert('投票失败：' + (result.message || '未知错误'));
                    submitBtn.disabled = false;
                    submitBtn.textContent = '投票';
                }
            } catch (e) {
                alert('出错了，请稍后再试');
                submitBtn.disabled = false;
                submitBtn.textContent = '投票';
            }
        });
    }

    escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

window.VoteEmbed = VoteEmbed;
