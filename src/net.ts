import * as Ably from 'ably';
import type { Message, Player, Slot } from './state';

export interface Transport {
  readonly id: string;
  readonly online: boolean;
  serverNow(): number;
  send(msg: Message): void;
  onMessage(cb: (msg: Message, from: string) => void): void;
  onPlayers(cb: (players: Player[]) => void): void;
  setPresence(name: string, slot: Slot | null): Promise<void>;
  players(): Player[];
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

class LocalTransport implements Transport {
  readonly id = randomId();
  readonly online = false;
  private list: Player[] = [];
  private playersCb: (players: Player[]) => void = () => {};
  serverNow() { return Date.now(); }
  send() {}
  onMessage() {}
  onPlayers(cb: (players: Player[]) => void) { this.playersCb = cb; }
  async setPresence(name: string, slot: Slot | null) {
    this.list = [{ id: this.id, name, slot }];
    this.playersCb(this.list);
  }
  players() { return this.list; }
}

class AblyTransport implements Transport {
  readonly id = randomId();
  readonly online = true;
  private client: Ably.Realtime;
  private channel: Ably.RealtimeChannel;
  private offset = 0;
  private list: Player[] = [];
  private messageCb: (msg: Message, from: string) => void = () => {};
  private playersCb: (players: Player[]) => void = () => {};

  constructor(room: string) {
    this.client = new Ably.Realtime({
      authUrl: '/api/token',
      clientId: this.id,
      echoMessages: false,
    });
    this.channel = this.client.channels.get(`trio:${room}`);
  }

  async connect(): Promise<void> {
    await this.client.connection.once('connected');
    await this.syncClock();
    this.channel.subscribe('msg', (m) => {
      this.messageCb(m.data as Message, m.clientId ?? '');
    });
    this.channel.presence.subscribe(() => this.refreshPlayers());
    await this.channel.attach();
    window.setInterval(() => this.syncClock(), 60_000);
  }

  private async syncClock(): Promise<void> {
    let best = Infinity;
    for (let i = 0; i < 4; i++) {
      const t0 = Date.now();
      const server = await this.client.time();
      const t1 = Date.now();
      const rtt = t1 - t0;
      if (rtt < best) {
        best = rtt;
        this.offset = server + rtt / 2 - t1;
      }
    }
  }

  private async refreshPlayers(): Promise<void> {
    const members = await this.channel.presence.get();
    this.list = members.map((m) => ({
      id: m.clientId ?? '',
      name: (m.data?.name as string) ?? '?',
      slot: (m.data?.slot as Slot | null) ?? null,
    }));
    this.playersCb(this.list);
  }

  serverNow() { return Date.now() + this.offset; }
  send(msg: Message) { void this.channel.publish('msg', msg); }
  onMessage(cb: (msg: Message, from: string) => void) { this.messageCb = cb; }
  onPlayers(cb: (players: Player[]) => void) { this.playersCb = cb; }
  async setPresence(name: string, slot: Slot | null) {
    await this.channel.presence.update({ name, slot });
  }
  players() { return this.list; }
}

export async function createTransport(room: string): Promise<Transport> {
  try {
    const probe = await fetch('/api/token');
    if (!probe.ok) throw new Error(`token endpoint returned ${probe.status}`);
    const t = new AblyTransport(room);
    await t.connect();
    return t;
  } catch (err) {
    console.warn('Realtime unavailable, running solo:', err);
    return new LocalTransport();
  }
}
