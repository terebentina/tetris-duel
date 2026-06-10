// Thin WebSocket client wrapper with reconnect-on-menu semantics.

export class Net {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.onStatus = () => {};
  }

  on(type, fn) {
    this.handlers.set(type, fn);
  }

  connect() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return Promise.resolve();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}`);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.onopen = () => {
        this.onStatus('connected');
        resolve();
      };
      ws.onerror = () => {
        this.onStatus('error');
        reject(new Error('connection failed'));
      };
      ws.onclose = () => {
        this.onStatus('disconnected');
        const fn = this.handlers.get('_close');
        if (fn) fn();
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        const fn = this.handlers.get(msg.type);
        if (fn) fn(msg);
      };
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  close() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}
