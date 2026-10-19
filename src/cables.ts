interface Cable {
  from: string;
  to: string;
  amount: () => number;
  color: string;
  path: SVGPathElement;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export class CableLayer {
  private svg: SVGSVGElement;
  private cables: Cable[] = [];

  constructor(parent: HTMLElement) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('cables');
    parent.appendChild(this.svg);
  }

  add(from: string, to: string, amount: () => number, color: string): void {
    const path = document.createElementNS(SVG_NS, 'path');
    path.classList.add('cable');
    path.style.setProperty('--c', color);
    this.svg.appendChild(path);
    this.cables.push({ from, to, amount, color, path });
  }

  pulse(from: string): void {
    for (const c of this.cables) {
      if (c.from !== from || c.amount() <= 0) continue;
      c.path.classList.remove('pulse');
      void c.path.getBoundingClientRect();
      c.path.classList.add('pulse');
    }
  }

  update(): void {
    for (const c of this.cables) {
      const a = this.jack(c.from);
      const b = this.jack(c.to);
      const amount = c.amount();
      if (!a || !b || amount <= 0) {
        c.path.style.opacity = '0';
        this.connected(c.from, false, c.color);
        this.connected(c.to, false, c.color);
        continue;
      }
      const dx = Math.abs(b.x - a.x);
      const sag = 50 + dx * 0.18;
      c.path.setAttribute('d', `M ${a.x} ${a.y} C ${a.x} ${a.y + sag}, ${b.x} ${b.y + sag}, ${b.x} ${b.y}`);
      c.path.style.opacity = String(0.45 + amount * 0.55);
      c.path.style.strokeWidth = `${3 + amount * 2.5}`;
      this.connected(c.from, true, c.color);
      this.connected(c.to, true, c.color);
    }
  }

  private jack(id: string): { x: number; y: number } | null {
    const el = document.querySelector<HTMLElement>(`[data-jack="${id}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const panel = el.closest('.panel');
    if (panel) {
      const pr = panel.getBoundingClientRect();
      if (r.bottom < pr.top || r.top > pr.bottom) return null;
    }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  private connected(id: string, on: boolean, color: string): void {
    const el = document.querySelector<HTMLElement>(`[data-jack="${id}"]`);
    if (!el) return;
    el.classList.toggle('connected', on);
    if (on) el.style.setProperty('--c', color);
  }
}
