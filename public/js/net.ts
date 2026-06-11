// Thin WebSocket client wrapper with reconnect-on-menu semantics.

import type { ClientMessage, ServerMessage } from './protocol.ts';

export type NetStatus = 'connected' | 'disconnected' | 'error';

export class Net {
  ws: WebSocket | null = null;
  handlers = new Map<string, (msg: ServerMessage) => void>();
  onStatus: (status: NetStatus) => void = () => {};
  onClose: () => void = () => {};

  on<T extends ServerMessage['type']>(
    type: T,
    fn: (msg: Extract<ServerMessage, { type: T }>) => void
  ): void {
    this.handlers.set(type, fn as (msg: ServerMessage) => void);
  }

  connect(): Promise<void> {
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
        this.onClose();
      };
      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return;
        }
        const fn = this.handlers.get(msg.type);
        if (fn) fn(msg);
      };
    });
  }

  send(obj: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  close(): void {
    if (this.ws) this.ws.close();
    this.ws = null;
  }
}
