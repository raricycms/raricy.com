// Core site JavaScript — loaded on every page via base.html

// 从meta标签读取服务器端数据
const userAuthenticatedMeta = document.querySelector('meta[name="user-authenticated"]');
const notificationApiUrlMeta = document.querySelector('meta[name="notification-api-url"]');
const checkinApiUrlMeta = document.querySelector('meta[name="checkin-api-url"]');
const logoutUrlMeta = document.querySelector('meta[name="logout-url"]');

// 安全地解析JSON
function safeJsonParse(jsonString, defaultValue) {
    try {
        return JSON.parse(jsonString);
    } catch (e) {
        console.error('JSON解析错误:', e, '原始内容:', jsonString);
        return defaultValue;
    }
}

window.isUserAuthenticated = userAuthenticatedMeta ? (userAuthenticatedMeta.content === 'true') : false;
window.notificationApiUrl = notificationApiUrlMeta ? notificationApiUrlMeta.content : null;
window.checkinApiUrl = checkinApiUrlMeta ? checkinApiUrlMeta.content : null;

console.log('用户认证状态:', window.isUserAuthenticated);
console.log('通知API URL:', window.notificationApiUrl);
console.log('user-authenticated meta内容:', userAuthenticatedMeta ? userAuthenticatedMeta.content : '不存在');
console.log('notification-api-url meta内容:', notificationApiUrlMeta ? notificationApiUrlMeta.content : '不存在');

// 平滑滚动
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const href = this.getAttribute('href');
        if (!href || href === '#') return;
        const target = document.querySelector(href);
        if (!target) {
            console.warn('Target element not found:', href);
            return;
        }
        target.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
        });
    });
});

// 登出功能
function logout() {
    if (confirm('确定要退出登录吗？')) {
        const logoutUrl = logoutUrlMeta ? logoutUrlMeta.content : '/api/auth/logout';
        fetch(logoutUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            credentials: 'same-origin',
        })
        .then(response => response.json())
        .then(data => {
            if (data.code === 200) {
                // 显示成功消息
                showToast('已成功退出登录', 'success');
                // 刷新页面
                setTimeout(() => {
                    window.location.href = '/';
                }, 800);
            } else {
                showToast('退出登录失败', 'error');
            }
        })
        .catch(error => {
            console.error('退出登录请求失败:', error);
            showToast('网络错误，请稍后重试', 'error');
        });
    }
}

window.logout = logout;

// 显示消息提示（原生实现，无Bootstrap）
function showToast(message, type = 'info') {
    const toastContainer = document.getElementById('toast-container') || createToastContainer();
    const toast = document.createElement('div');
    const resolvedType = (type === 'success' || type === 'error' || type === 'info' || type === 'warning') ? type : 'info';
    toast.className = `toast toast--${resolvedType}`;
    toast.setAttribute('role', 'alert');
    toast.setAttribute('aria-live', 'assertive');
    toast.setAttribute('aria-atomic', 'true');

    toast.innerHTML = `
        <div class="toast__content">
            <div class="toast__body">${message}</div>
            <button type="button" class="toast__close" aria-label="Close">&times;</button>
        </div>
    `;

    const closeBtn = toast.querySelector('.toast__close');
    closeBtn.addEventListener('click', () => hideAndRemoveToast(toast));

    toastContainer.appendChild(toast);

    // 动画展示
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });

    // 自动移除
    const autoHideMs = 3500;
    const autoHideTimer = setTimeout(() => hideAndRemoveToast(toast), autoHideMs);

    // 鼠标悬停时暂停自动关闭
    toast.addEventListener('mouseenter', () => clearTimeout(autoHideTimer));
}

window.showToast = showToast;

function hideAndRemoveToast(toastEl) {
    if (!toastEl) return;
    toastEl.classList.remove('show');
    toastEl.addEventListener('transitionend', () => {
        if (toastEl && toastEl.parentNode) {
            toastEl.parentNode.removeChild(toastEl);
        }
    }, { once: true });
}

// 创建toast容器
function createToastContainer() {
    const container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container toast-container--tr';
    container.style.zIndex = '9999';
    document.body.appendChild(container);
    return container;
}

// 获取并更新通知数量
function updateNotificationCount() {
    if (!window.isUserAuthenticated) {
        console.log('用户未登录，跳过通知数量更新');
        return;
    }

    if (!window.notificationApiUrl) {
        console.log('通知API URL未设置');
        return;
    }

    console.log('正在获取通知数量...', window.notificationApiUrl);
    fetch(window.notificationApiUrl)
        .then(response => response.json())
        .then(data => {
            const badge = document.getElementById('notificationBadge');
            if (badge) {
                const count = data.count || 0;
                if (count > 0) {
                    badge.style.display = 'flex';
                    if (count > 99) {
                        badge.textContent = '99+';
                        badge.classList.add('large-count');
                    } else {
                        badge.textContent = count;
                        badge.classList.remove('large-count');
                    }
                    badge.classList.add('has-notifications');
                } else {
                    badge.style.display = 'none';
                    badge.classList.remove('has-notifications');
                }
            }
        })
        .catch(error => {
            console.error('获取通知数量失败:', error);
        });
}

window.updateNotificationCount = updateNotificationCount;

// 获取并更新签到状态（绿点提示）
function updateCheckinIndicator() {
    if (!window.isUserAuthenticated) {
        return;
    }

    if (!window.checkinApiUrl) {
        return;
    }

    fetch(window.checkinApiUrl)
        .then(response => response.json())
        .then(data => {
            const badge = document.getElementById('checkinBadge');
            if (!badge) return;
            if (!data.checked_in) {
                badge.style.display = 'flex';
            } else {
                badge.style.display = 'none';
            }
        })
        .catch(error => {
            console.error('获取签到状态失败:', error);
        });
}

window.updateCheckinIndicator = updateCheckinIndicator;

const themeConfig = {
    light: {
        'data-theme': 'light'
    },
    dark: {
        'data-theme': 'dark'
    }
};

function switchTheme(themeName) {
    const root = document.documentElement;
    const config = themeConfig[themeName];
    root.setAttribute('data-theme', config['data-theme']);
    localStorage.setItem('theme', themeName);
    const tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.setAttribute('content', config['data-theme'] === 'dark' ? '#131517' : '#FBFBFD');
    console.log('切换主题:', themeName);
}

window.switchTheme = switchTheme;

// 当用户点击通知按钮时，延迟更新计数（给服务器时间处理）
document.addEventListener('click', function(e) {
    if (e.target.closest('.notification-btn')) {
        setTimeout(updateNotificationCount, 1000);
    }
});

// 全局函数：刷新通知计数（可在其他页面调用）
window.refreshNotificationCount = function() {
    updateNotificationCount();
};

// 自定义文件选择器：接管所有可见的原生 input[type=file]
// （保留原元素与其 id/name/事件，仅视觉隐藏，页面已有 JS 不受影响）
function enhanceFileInputs() {
    document.querySelectorAll('input[type="file"]').forEach(function (input) {
        if (input.dataset.filepick) return;
        // 跳过由自定义 UI 驱动、本就隐藏的（图床拖拽区、照片墙）
        if (input.hasAttribute('hidden') || input.style.display === 'none') return;
        input.dataset.filepick = '1';

        if (!input.id) input.id = 'fp-' + Math.random().toString(36).slice(2, 9);

        var wrap = document.createElement('div');
        wrap.className = 'filepick';
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);

        var btn = document.createElement('label');
        btn.className = 'filepick__btn';
        btn.setAttribute('for', input.id);
        btn.textContent = '选择文件';

        var name = document.createElement('span');
        name.className = 'filepick__name';
        name.textContent = '未选择文件';

        var clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'filepick__clear';
        clear.setAttribute('aria-label', '清除所选文件');
        clear.textContent = '×';

        wrap.appendChild(btn);
        wrap.appendChild(name);
        wrap.appendChild(clear);

        function render() {
            var files = input.files;
            if (files && files.length) {
                name.textContent = files.length > 1 ? (files.length + ' 个文件') : files[0].name;
                name.classList.add('filepick__name--has');
                wrap.classList.add('filepick--has');
            } else {
                name.textContent = '未选择文件';
                name.classList.remove('filepick__name--has');
                wrap.classList.remove('filepick--has');
            }
        }

        input.addEventListener('change', render);
        clear.addEventListener('click', function () {
            input.value = '';
            // 通知页面已有逻辑（如哈希页据此回退到文本输入）
            input.dispatchEvent(new Event('change', { bubbles: true }));
            render();
        });
        render();
    });
}

window.enhanceFileInputs = enhanceFileInputs;

// 页面加载后：初始化顶栏交互与通知
//
// 注意：本文件在 Next 侧由 <Script strategy="afterInteractive"> 加载，此时
// DOMContentLoaded 早已触发完毕——若仍只注册该事件的监听器，回调永远不会执行，
// 顶栏折叠 / 用户下拉 / 通知计数等会全部失效。故改为：DOM 已就绪则立即初始化。
// （原 Flask 由 base.html 内联 <script> 在解析期执行，赶得上该事件，故无此问题。）
//
// 用 AbortController 收集本轮 init 注册的所有监听器：再次进入 initSiteChrome()
// （HMR、SPA 重挂载、或测试反复执行）时先 abort 上一轮，避免监听器累积 ——
// 头像下拉的 click 委托尤其需要这个：多次注册会让 toggle.click() 触发 N 次切 .open。
const SITE_CHROME_CTRL_KEY = '__raricySiteChromeAbort';

function initSiteChrome() {
    const w = window;
    if (w[SITE_CHROME_CTRL_KEY]) w[SITE_CHROME_CTRL_KEY].abort();
    const ctrl = new AbortController();
    w[SITE_CHROME_CTRL_KEY] = ctrl;
    const { signal } = ctrl;

    updateNotificationCount();
    updateCheckinIndicator();
    enhanceFileInputs();

    // 顶栏折叠
    const siteNavbar = document.querySelector('.site-navbar');
    const toggler = document.querySelector('.site-navbar-toggler');
    // 与 _header.scss 的 @media (max-width: 808px) 对齐；改用 matchMedia 替代
    // window.innerWidth 判断，避免 809–991px 区间 .open 跨断点残留。
    // jsdom 下 window.matchMedia 不存在 → 走兜底，按非移动端处理（不影响测试）。
    const mqMobile = window.matchMedia
        ? window.matchMedia('(max-width: 808px)')
        : { matches: false, addEventListener: function () {}, removeEventListener: function () {} };
    function isMobile() { return mqMobile.matches; }

    function closeNavbar() {
        if (!siteNavbar || !siteNavbar.classList.contains('open')) return;
        siteNavbar.classList.remove('open');
        if (toggler) toggler.setAttribute('aria-expanded', 'false');
    }

    if (toggler && siteNavbar) {
        toggler.addEventListener('click', function () {
            const isOpen = siteNavbar.classList.toggle('open');
            toggler.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        }, { signal });
        // 跨断点（如桌面端缩放 / 旋转）：离开 mobile 时清掉 .open，避免
        // aria-expanded 与 .site-navbar-collapse 的 max-height 状态错位。
        mqMobile.addEventListener('change', function (e) {
            if (!e.matches) closeNavbar();
        });
    }

    // 用户下拉：mobile + desktop 行为一致 —— 点 toggle 切 .open。
    //
    // 用事件委托而不是直接绑 toggle：base.js 是 <Script strategy="afterInteractive">
    // 加载的（仅执行一次）。登录流程 router.refresh() 会让 Navbar 从无头像切到
    // 有头像 —— 新插入的 .site-user-dropdown-toggle 没绑过监听器，点击不会展开。
    // 委托到 document 后，无论 toggle 何时插入 DOM 都能响应。
    document.addEventListener('click', function (e) {
        // 1) 点中 toggle：切 .open，然后 return（不触发后续"外部关闭"）
        const toggle = e.target.closest && e.target.closest('.site-user-dropdown-toggle');
        if (toggle) {
            const dropdown = toggle.closest('.site-user-dropdown');
            if (dropdown) {
                dropdown.classList.toggle('open');
                toggle.setAttribute('aria-expanded', dropdown.classList.contains('open') ? 'true' : 'false');
            }
            return;
        }
        // 2) 点击页面其它位置：关闭所有已展开的头像下拉
        document.querySelectorAll('.site-user-dropdown.open').forEach(function (d) {
            if (!d.contains(e.target)) {
                d.classList.remove('open');
                const t = d.querySelector('.site-user-dropdown-toggle');
                if (t) t.setAttribute('aria-expanded', 'false');
            }
        });
        // 3) 移动端：点非 navbar 区域收起 navbar
        if (isMobile() && siteNavbar && !siteNavbar.contains(e.target)) {
            closeNavbar();
        }
    }, { signal });

    // ESC 关闭移动端 navbar / 桌面端下拉菜单
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (isMobile()) {
            closeNavbar();
        }
        document.querySelectorAll('.site-user-dropdown.open').forEach(function (d) {
            d.classList.remove('open');
            const t = d.querySelector('.site-user-dropdown-toggle');
            if (t) t.setAttribute('aria-expanded', 'false');
        });
    }, { signal });

    // 移动端：点导航链接后收起 navbar。
    // Navbar 在 root layout 里，Next 客户端路由跳转不会重建它，.open 会跨页残留。
    if (siteNavbar) {
        siteNavbar.querySelectorAll('a.site-link').forEach(function (a) {
            a.addEventListener('click', function () {
                if (isMobile()) closeNavbar();
            }, { signal });
        });
    }

    // 主题：有手动偏好则用之，否则跟随系统（不落盘，OS 变化实时跟随）
    const savedThemeName = localStorage.getItem('theme');
    if (savedThemeName === 'light' || savedThemeName === 'dark') {
        document.documentElement.setAttribute('data-theme', savedThemeName);
    } else if (window.matchMedia) {
        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
        mq.addEventListener('change', function (e) {
            if (!localStorage.getItem('theme')) {
                document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
            }
        });
    }
}

// DOM 还在解析 → 等事件；已就绪（Next 的 afterInteractive 即属此列）→ 立即执行。
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSiteChrome);
} else {
    initSiteChrome();
}

// 主题切换按钮
const themeToggleButton = document.getElementById('themeToggle');
if (themeToggleButton) {
    themeToggleButton.addEventListener('click', function() {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        switchTheme(newTheme);
    });

    let rotationAngle = 0;
    themeToggleButton.addEventListener('click', function() {
        rotationAngle += 180;
        const themeIcon = themeToggleButton.querySelector('.icon');
        (themeIcon || themeToggleButton).style.transform = `rotate(${rotationAngle}deg)`;
    });
}
