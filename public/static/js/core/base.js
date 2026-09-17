// Core site JavaScript — loaded on every page via base.html

// 从meta标签读取服务器端数据
const userAuthenticatedMeta = document.querySelector('meta[name="user-authenticated"]');
const notificationApiUrlMeta = document.querySelector('meta[name="notification-api-url"]');
const notificationStreamUrlMeta = document.querySelector('meta[name="notification-stream-url"]');
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
// 顶栏实时流（SSE）。与上面的 notificationApiUrl 是两个不同的东西：
// 前者是补丁推送，后者是兜底快照，缺一不可（见 scheduleHeartbeat 的注释）。
window.notificationStreamUrl = notificationStreamUrlMeta ? notificationStreamUrlMeta.content : null;
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
            <div class="toast__body"></div>
            <button type="button" class="toast__close" aria-label="Close">&times;</button>
        </div>
    `;

    // 正文用 textContent 写入（不走 innerHTML）：message 可能掺入服务端/用户可控内容时，
    // innerHTML 会变成同源 XSS 汇点；toast 语义只是纯文本提示，无任何需要解析的 HTML。
    toast.querySelector('.toast__body').textContent = message;

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

// ── 顶栏两个指示器的状态 ────────────────────────────────────────────────────
//
// 数据有两个来源，落到同一处 DOM：
//   · SSE 流（/api/notifications/stream）—— 服务端推来的**增量补丁**，实时值；
//   · fetch 快照（/api/notifications/count）—— 首屏 / 切页 / 回到前台 / 兜底轮询。
//     SSE 存在「连着但收不到」的半死状态（反代掐连接、NAT 超时），没有快照就没人纠正它。
//
// rev 是**版本号**，专治一类竞态：可见时的那次快照 fetch 发出（读到 count=0）→ 期间
// 来了通知并由 SSE 推出（铃铛变 1）→ 快照响应后到、把 0 盖回去 → 铃铛熄掉且要等下一个
// 事件才回来（这个竞态是接入 SSE 之后**新引入**的：以前只有一个数据源，无从打架）。
// 落地前比对 rev，期间有推送落地就丢弃这份可能更旧的快照 —— 那个字段的权威值已经由
// 推送写了，另一个字段的权威值来自首帧快照，丢掉是安全的。

const TOPBAR_STATE_KEY = '__raricyTopbar';

function topbarState() {
    if (!window[TOPBAR_STATE_KEY]) {
        window[TOPBAR_STATE_KEY] = {
            es: null,          // 当前 EventSource（null = 没连）
            pollTimer: null,   // 兜底轮询定时器
            retryTimer: null,  // 流被永久关闭后的重建定时器
            streamUp: false,   // 流是否处于 open 状态（决定轮询档位）
            rev: 0             // 已落地数据的版本号，见上
        };
    }
    return window[TOPBAR_STATE_KEY];
}

// 把一个补丁（或快照）落到 DOM 上。
// 三个字段都是**绝对值**、且**缺哪个就不动哪个** —— 服务端推的是增量补丁
// （见 src/lib/topbar-bus.ts），`{chatUnread:false}` 里没有 count，整体替换会把铃铛抹掉。
function applyTopbar(data) {
    if (!data) return;
    const st = topbarState();

    if (typeof data.count === 'number') {
        const badge = document.getElementById('notificationBadge');
        if (badge) {
            const count = data.count;
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
                badge.classList.remove('large-count');
            }
        }
    }

    if (typeof data.chatUnread === 'boolean') {
        // 讨论未读：不算数字，只在「讨论」链接右上角点一个红点
        const chatDot = document.getElementById('chatUnreadDot');
        if (chatDot) {
            chatDot.style.display = data.chatUnread ? 'block' : 'none';
        }
    }

    st.rev += 1;

    // 「我不确定新值，你去重算」—— 服务端够不着计算函数的那些地方推这个
    // （改角色、关闭专注模式；理由见 topbar-bus.ts 的 TopbarPatch）。
    if (data.refresh === true) updateNotificationCount();
}

// 获取并更新顶栏的两个提示（一次请求喂两个元素）
// 服务端返回 { count, chatUnread }：
//   count      → 铃铛数字，只数站内通知（＝ /notifications 列表里的条数，讨论不计入）
//   chatUnread → 「讨论」链接右上角的小红点（私聊有未读 / 大区被 @）
function updateNotificationCount() {
    if (!window.isUserAuthenticated) {
        console.log('用户未登录，跳过通知数量更新');
        return;
    }

    if (!window.notificationApiUrl) {
        console.log('通知API URL未设置');
        return;
    }

    const st = topbarState();
    const startedRev = st.rev;
    console.log('正在获取通知数量...', window.notificationApiUrl);
    fetch(window.notificationApiUrl)
        .then(response => response.json())
        .then(data => {
            // 期间 SSE 推来更新的值 → 丢弃这份可能更旧的快照（见 rev 的说明）
            if (st.rev !== startedRev) return;
            applyTopbar(data);
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
    // 这两支是 --color-background-page 的明暗两值，手抄在此（JS 读不到 CSS 变量）。
    // 浅色那支曾写成 #FBFBFD，与令牌的 #F8FAFC 已经漂了 —— 改了令牌不会带动这里，
    // 改令牌时记得回来对一眼。深色 #131517 与令牌一致。
    if (tc) tc.setAttribute('content', config['data-theme'] === 'dark' ? '#131517' : '#F8FAFC');
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

// ── 顶栏实时流（SSE）+ 兜底轮询 ─────────────────────────────────────────────
//
// 为什么还需要轮询：SSE 只在**能收到帧**时才有用。反代掐掉连接、NAT 超时之后，
// 浏览器这边的 EventSource 未必报错（半死状态），数字就此冻住 —— 只有这条定时器能纠正。
// 所以它不能删。
//
// 两档间隔：流连着 → 60s（省负载）；没连上 → 20s。隐藏标签页同理（见
// startTopbarStream 的注释：HTTP/1.1 每源只有 6 条连接且跨标签页共享，隐藏的标签页
// 不该占坑），于是隐藏时回到 20s —— 与接入 SSE 之前**完全一致**，
// 也就是说 SSE 万一彻底失效，最坏表现不会比过去差。

const POLL_INTERVAL_CONNECTED_MS = 60 * 1000;
const POLL_INTERVAL_FALLBACK_MS = 20 * 1000;

// 幂等与两档是同一处代码：每次都先清掉上一轮再按当前档位重开，所以 initSiteChrome
// 重复执行（HMR / 测试反复 new Function）既不会叠加定时器，也不会停留在旧档位。
function scheduleHeartbeat() {
    const st = topbarState();
    // 未登录（无 meta）或页面没有徽标（未登录态 Navbar 不渲染）时无意义，不空轮询
    if (!window.isUserAuthenticated || !window.notificationApiUrl) return;
    if (!document.getElementById('notificationBadge')) return;
    if (st.pollTimer) clearInterval(st.pollTimer);
    st.pollTimer = setInterval(
        updateNotificationCount,
        st.streamUp ? POLL_INTERVAL_CONNECTED_MS : POLL_INTERVAL_FALLBACK_MS
    );
}

function closeTopbarStream() {
    const st = topbarState();
    if (st.retryTimer) {
        clearTimeout(st.retryTimer);
        st.retryTimer = null;
    }
    if (st.es) {
        try { st.es.close(); } catch (e) { /* 已关闭 */ }
        st.es = null;
    }
    if (st.streamUp) {
        st.streamUp = false;
        scheduleHeartbeat(); // 回到 20s 档
    }
}

function startTopbarStream() {
    // 幂等：重复执行（initSiteChrome 可能重跑）先关掉上一轮，否则每次都多一条长连接
    closeTopbarStream();

    // jsdom 不实现 EventSource（单测环境），老浏览器也没有 → 早退，纯靠轮询兜底。
    // 这一行不能省：裸写 new EventSource 会让所有跑 base.js 的单测同步抛错。
    if (typeof window.EventSource === 'undefined') return;
    if (!window.isUserAuthenticated || !window.notificationStreamUrl) return;
    // 隐藏标签页不占连接（池子是跨标签页共享的）；切回可见时由 visibilitychange 重连
    if (document.hidden) return;

    const st = topbarState();
    const es = new window.EventSource(window.notificationStreamUrl);
    st.es = es;

    es.onopen = function () {
        st.streamUp = true;
        scheduleHeartbeat(); // 切到 60s 档
        // 不在这里补一次 fetch：服务端紧接着就会推首帧**全量快照**（见路由），
        // 那一帧就是当前值。多拉一次纯属浪费，而且会打乱既有测试的精确调用计数。
    };

    es.onmessage = function (e) {
        const data = safeJsonParse(e.data, null);
        if (data) applyTopbar(data);
    };

    es.onerror = function () {
        st.streamUp = false;
        scheduleHeartbeat(); // 回到 20s 档
        // readyState === 2（CLOSED）= 浏览器**永久放弃**这条连接（非 200 响应、如 401 / 502），
        // 按规范不会再重试。我们自己隔一会儿重建一次：服务端重启造成的 502 能自愈；
        // 会话真废了的话，重建会再吃一个 401，代价与那条 20s 轮询同级。
        // readyState === 0（CONNECTING）= 普通断线，浏览器按服务端下发的 retry 自动重连，不用管。
        if (st.es === es && es.readyState === 2) {
            st.es = null;
            if (st.retryTimer) clearTimeout(st.retryTimer);
            st.retryTimer = setTimeout(startTopbarStream, 30 * 1000);
        }
    };
}

// 自定义文件选择器：接管所有可见的原生 input[type=file]
// （保留原元素与其 id/name/事件，仅视觉隐藏，页面已有 JS 不受影响）
function enhanceFileInputs() {
    document.querySelectorAll('input[type="file"]').forEach(function (input) {
        if (input.dataset.filepick) return;
        // 跳过由自定义 UI 驱动、本就隐藏的（图床拖拽区）
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
    scheduleHeartbeat();
    startTopbarStream();
    enhanceFileInputs();

    // 标签页可见性：隐藏时断开长连接（池子跨标签页共享，见 startTopbarStream），
    // 回到前台立刻重连并补一次快照。监听器挂在本轮的 AbortController 上，不累积。
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            closeTopbarStream();
            return;
        }
        startTopbarStream();
        updateNotificationCount();
    }, { signal });

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
    // 用事件委托而不是逐个绑定 `a.site-link`：登录后 router.refresh() 会插入
    // 通知 / 签到 / 用户下拉等链接，逐个绑定收不到它们；委托到 .site-navbar 后
    // 任意 <a>（含 site-brand、登录、用户下拉菜单项）点击都会收起。
    if (siteNavbar) {
        siteNavbar.addEventListener('click', function (e) {
            if (!isMobile()) return;
            if (e.target.closest && e.target.closest('a')) {
                closeNavbar();
                // 用户下拉菜单项也是 <a>：导航时连下拉一并收起，避免 .open 跨页残留
                const dd = document.querySelector('.site-user-dropdown.open');
                if (dd) dd.classList.remove('open');
            }
        }, { signal });
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
