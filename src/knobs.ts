import type { ControlSpec, Params } from './state';

export interface ControlPanel {
  root: HTMLElement;
  update(params: Params): void;
}

export function buildControls(
  specs: ControlSpec[],
  params: Params,
  onChange: (key: string, value: number, final: boolean) => void,
): ControlPanel {
  const root = document.createElement('div');
  root.className = 'controls';
  const groups = new Map<string, HTMLElement>();
  const updaters: Array<(p: Params) => void> = [];

  for (const spec of specs) {
    const groupName = spec.group ?? '';
    let group = groups.get(groupName);
    if (!group) {
      group = document.createElement('div');
      group.className = 'control-group';
      if (groupName) {
        const title = document.createElement('div');
        title.className = 'group-title';
        title.textContent = groupName;
        group.appendChild(title);
      }
      const body = document.createElement('div');
      body.className = 'group-body';
      group.appendChild(body);
      root.appendChild(group);
      groups.set(groupName, group);
    }
    const body = group.querySelector('.group-body') as HTMLElement;
    const el = spec.jack
      ? buildJack(spec)
      : spec.options
        ? buildSwitch(spec, params, onChange, updaters)
        : buildKnob(spec, params, onChange, updaters);
    body.appendChild(el);
  }

  return { root, update: (p) => updaters.forEach((u) => u(p)) };
}

function buildJack(spec: ControlSpec): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'jack';
  const hole = document.createElement('div');
  hole.className = 'hole';
  hole.dataset.jack = spec.jack;
  const label = document.createElement('span');
  label.textContent = spec.label;
  wrap.append(hole, label);
  return wrap;
}

function buildKnob(
  spec: ControlSpec,
  params: Params,
  onChange: (key: string, value: number, final: boolean) => void,
  updaters: Array<(p: Params) => void>,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'knob';
  const dial = document.createElement('div');
  dial.className = 'dial';
  const pointer = document.createElement('div');
  pointer.className = 'pointer';
  dial.appendChild(pointer);
  const label = document.createElement('span');
  label.textContent = spec.label;
  wrap.append(dial, label);

  const render = (v: number) => dial.style.setProperty('--angle', `${-135 + v * 270}deg`);
  render(params[spec.key] ?? 0);
  updaters.push((p) => render(p[spec.key] ?? 0));

  let startY = 0;
  let startValue = 0;
  let value = params[spec.key] ?? 0;
  dial.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dial.setPointerCapture(e.pointerId);
    startY = e.clientY;
    startValue = value;
    wrap.classList.add('active');
  });
  dial.addEventListener('pointermove', (e) => {
    if (!dial.hasPointerCapture(e.pointerId)) return;
    value = Math.min(1, Math.max(0, startValue + (startY - e.clientY) / 160));
    render(value);
    onChange(spec.key, value, false);
  });
  const finish = (e: PointerEvent) => {
    if (!dial.hasPointerCapture(e.pointerId)) return;
    dial.releasePointerCapture(e.pointerId);
    wrap.classList.remove('active');
    onChange(spec.key, value, true);
  };
  dial.addEventListener('pointerup', finish);
  dial.addEventListener('pointercancel', finish);
  updaters.push((p) => { if (!wrap.classList.contains('active')) value = p[spec.key] ?? 0; });
  return wrap;
}

function buildSwitch(
  spec: ControlSpec,
  params: Params,
  onChange: (key: string, value: number, final: boolean) => void,
  updaters: Array<(p: Params) => void>,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'switch';
  const row = document.createElement('div');
  row.className = 'switch-row';
  const buttons = spec.options!.map((opt, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opt;
    b.addEventListener('click', () => onChange(spec.key, i, true));
    row.appendChild(b);
    return b;
  });
  const label = document.createElement('span');
  label.textContent = spec.label;
  wrap.append(row, label);
  const render = (v: number) => buttons.forEach((b, i) => b.classList.toggle('on', i === v));
  render(params[spec.key] ?? 0);
  updaters.push((p) => render(p[spec.key] ?? 0));
  return wrap;
}
