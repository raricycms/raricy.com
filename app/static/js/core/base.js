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
        const logoutUrl = logoutUrlMeta ? logoutUrlMeta.content : '/auth/logout';
        fetch(logoutUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
            }
        })
        .then(response => response.json())
        .then(data => {
            if (data.code === 200) {
                // 显示成功消息
                showToast('已成功退出登录', 'success');
                // 刷新页面
                setTimeout(() => {
                    window.location.reload();
                }, 1000);
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

// 页面加载后：初始化顶栏交互与通知
document.addEventListener('DOMContentLoaded', function() {
    updateNotificationCount();
    updateCheckinIndicator();

    // 顶栏折叠
    const siteNavbar = document.querySelector('.site-navbar');
    const toggler = document.querySelector('.site-navbar-toggler');
    if (toggler && siteNavbar) {
        toggler.addEventListener('click', function () {
            const isOpen = siteNavbar.classList.toggle('open');
            toggler.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        });
        window.addEventListener('resize', function () {
            if (window.innerWidth >= 992 && siteNavbar.classList.contains('open')) {
                siteNavbar.classList.remove('open');
                toggler.setAttribute('aria-expanded', 'false');
            }
        });
    }

    // 用户下拉
    const userDropdown = document.querySelector('.site-user-dropdown');
    const userToggle = document.querySelector('.site-user-dropdown-toggle');
    if (userDropdown && userToggle) {
        userToggle.addEventListener('click', function (e) {
            e.stopPropagation();
            userDropdown.classList.toggle('open');
            const expanded = userDropdown.classList.contains('open') ? 'true' : 'false';
            userToggle.setAttribute('aria-expanded', expanded);
        });
        document.addEventListener('click', function (e) {
            if (!userDropdown.contains(e.target)) {
                userDropdown.classList.remove('open');
                userToggle.setAttribute('aria-expanded', 'false');
            }
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
});

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
        themeToggleButton.style.transform = `rotate(${rotationAngle}deg)`;
    });
}
