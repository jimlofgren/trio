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
    this.list = [{ id: this.id, name, slot, since: Date.now() }];
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
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('realtime connect timeout')), 6000);
      this.client.connection.once('connected', () => { window.clearTimeout(timer); resolve(); });
      this.client.connection.on('failed', (change) => { window.clearTimeout(timer); reject(change.reason ?? new Error('connection failed')); });
      this.client.connection.on('disconnected', (change) => {
        if (change.reason?.code === 80019) { window.clearTimeout(timer); reject(change.reason); }
      });
    });
    await this.syncClock();
    this.channel.subscribe('msg', (m) => {
      this.messageCb(m.data as Message, m.clientId ?? '');
    });
    this.channel.presence.subscribe(() => this.refreshPlayers());
    await this.channel.attach();
    window.setInterval(() => this.syncClock(), 60_000);
  }

  private async syncClock(): Promise<void> {
    const samples = await Promise.all(Array.from({ length: 3 }, async () => {
      const t0 = Date.now();
      const server = await this.client.time();
      const t1 = Date.now();
      return { rtt: t1 - t0, offset: server + (t1 - t0) / 2 - t1 };
    }));
    this.offset = samples.sort((a, b) => a.rtt - b.rtt)[0].offset;
  }

  close(): void {
    this.client.close();
  }

  private async refreshPlayers(): Promise<void> {
    const members = await this.channel.presence.get();
    this.list = members.map((m) => ({
      id: m.clientId ?? '',
      name: (m.data?.name as string) ?? '?',
      slot: (m.data?.slot as Slot | null) ?? null,
      since: m.timestamp ?? 0,
    }));
    this.playersCb(this.list);
  }

  serverNow() { return Date.now() + this.offset; }
  send(msg: Message) { void this.channel.publish('msg', msg); }
  onMessage(cb: (msg: Message, from: string) => void) { this.messageCb = cb; }
  onPlayers(cb: (players: Player[]) => void) { this.playersCb = cb; }
  async setPresence(name: string, slot: Slot | null) {
    await this.channel.presence.update({ name, slot });
    await this.refreshPlayers();
  }
  players() { return this.list; }
}

export async function createTransport(room: string): Promise<Transport> {
  const t = new AblyTransport(room);
  try {
    await t.connect();
    return t;
  } catch (err) {
    console.warn('Realtime unavailable, running solo:', err);
    t.close();
    return new LocalTransport();
  }
}
