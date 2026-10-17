// 唯一端口只接受父窗口的首次交接，不接收全局 window 上的游戏消息。
(() => {
    let port = null;
    let listener = () => {};
    const pending = [];
    window.quandiBridge = {
        on(callback) { listener = callback; },
        send(message) {
            if (port) port.postMessage(message);
            else if (pending.length < 16) pending.push(message);
        },
    };
    window.addEventListener('message', (event) => {
        if (event.source !== window.parent || event.data?.type !== 'quandi.bridge' || !event.ports[0] || port) return;
        port = event.ports[0];
        port.onmessage = (incoming) => listener(incoming.data);
        for (const message of pending.splice(0)) port.postMessage(message);
    });
})();
function siteNotice(message) {
    const notice = document.getElementById('siteNotice');
    if (!notice) return;
    notice.textContent = String(message);
    notice.hidden = !message;
}
