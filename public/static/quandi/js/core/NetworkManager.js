// 本文档没有联网权限；本站父页持有票据与 WebSocket，只转发游戏操作。
class NetworkManager {
    constructor() {
        this.playerId = null;
        this.isConnected = false;
        this.stateBuffer = [];
        this.pendingInputs = [];
        this.lastAckedSeq = 0;
        this.inputSequence = 0;
        this.averagePing = 0;
        this.callbacks = {};
        window.quandiBridge.on((message) => {
            if (message.type === 'closed') {
                this.isConnected = false;
                this.stateBuffer = [];
                this.callbacks.disconnected?.();
                if (message.message) siteNotice(message.message);
            } else if (message.type === 'latency') {
                this.averagePing = message.milliseconds;
                document.getElementById('lobbyPing').textContent = this.averagePing + 'ms';
                document.getElementById('roomPing').textContent = this.averagePing;
            } else if (message.type === 'packet') this.handlePacket(message.packet);
        });
    }
    connect() { window.quandiBridge.send({ type: 'connect' }); }
    disconnect() { window.quandiBridge.send({ type: 'disconnect' }); this.isConnected = false; }
    handlePacket(packet) {
        const data = packet.data;
        switch (packet.type) {
            case 'S2C_CONNECTED':
                this.isConnected = true;
                this.playerId = data.playerId;
                document.getElementById('playerNameInput').textContent = data.playerName;
                this.callbacks.connected?.(data); break;
            case 'S2C_ROOM_UPDATE': this.callbacks.roomUpdate?.(data.room); break;
            case 'S2C_ROOM_LEFT': this.callbacks.roomLeft?.(); break;
            case 'S2C_GAME_START':
                this.stateBuffer = []; this.pendingInputs = []; this.inputSequence = 0; this.lastAckedSeq = 0;
                this.callbacks.gameStart?.(data); break;
            case 'S2C_GAME_STATE':
                // Delta 不能丢中间帧；后台积压超过 120 帧时断开，避免无限增长或错误合并。
                if (this.stateBuffer.length >= 120) { this.disconnect(); siteNotice('画面同步已中断，请重新联机。'); return; }
                this.stateBuffer.push(data); break;
            case 'S2C_GAME_EVENT': this.callbacks.gameEvent?.(data); break;
            case 'S2C_GAME_END': this.callbacks.gameEnd?.(data); break;
            case 'S2C_ERROR': this.callbacks.error?.(data); break;
        }
    }
    send(type, data = {}) {
        if (this.isConnected) window.quandiBridge.send({ type: 'send', command: { type, data } });
    }
    createRoom({ mode, difficulty }) { this.send('C2S_CREATE_ROOM', { mode, difficulty }); }
    joinRoom(roomCode) { this.send('C2S_JOIN_ROOM', { roomCode: roomCode.trim().toUpperCase() }); }
    leaveRoom() { this.send('C2S_LEAVE_ROOM'); }
    setReady(isReady) { this.send('C2S_SET_READY', { isReady }); }
    startGame() { this.send('C2S_START_GAME'); }
    forfeit() { this.send('C2S_FORFEIT'); }
    sendInput(direction) {
        const input = { seq: ++this.inputSequence, direction: { x: direction.x, y: direction.y } };
        this.pendingInputs.push(input);
        if (this.pendingInputs.length > 60) this.pendingInputs.shift();
        this.send('C2S_PLAYER_INPUT', input);
    }
    getPing() { return this.averagePing; }
    getNetworkQuality() { return { avgLatency: this.averagePing, jitter: 0, quality: this.averagePing < 100 ? 'good' : 'poor' }; }
    on(event, callback) { this.callbacks[event] = callback; }
}
window.NetworkManager = NetworkManager;
