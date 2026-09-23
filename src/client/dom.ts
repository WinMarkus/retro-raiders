type Child = Node | string | number | null | undefined | false;

export interface Props {
  [key: string]: unknown;
}

/**
 * Elements are built from data, never from strings, so user text can only ever
 * become a text node. There is no innerHTML in this client.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') {
      element.className = String(value);
    } else if (key === 'text') {
      element.textContent = String(value);
    } else if (key === 'value') {
      (element as HTMLInputElement).value = String(value);
    } else if (key === 'checked' || key === 'disabled') {
      (element as HTMLInputElement)[key] = Boolean(value);
      if (key === 'disabled' && value) element.setAttribute('disabled', '');
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else {
      element.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(element, children);
  return element;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function clear(element: Element): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}

export function mount(target: Element, ...children: Child[]): void {
  clear(target);
  append(target, children);
}

export function svg(markup: string, className = ''): SVGSVGElement {
  const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wrapper.setAttribute('viewBox', '0 0 24 24');
  wrapper.setAttribute('aria-hidden', 'true');
  if (className) wrapper.setAttribute('class', className);
  const parser = new DOMParser();
  const parsed = parser.parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${markup}</svg>`, 'image/svg+xml');
  for (const node of Array.from(parsed.documentElement.childNodes)) {
    wrapper.appendChild(node);
  }
  return wrapper;
}

interface FocusSnapshot {
  key: string;
  start: number | null;
  end: number | null;
  scrollTop: number;
}

function snapshotFocus(): FocusSnapshot | null {
  const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  if (!active) return null;
  const key = active.getAttribute('data-key');
  if (!key) return null;
  const canSelect = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
  return {
    key,
    start: canSelect ? active.selectionStart : null,
    end: canSelect ? active.selectionEnd : null,
    scrollTop: canSelect ? active.scrollTop : 0,
  };
}

function restoreFocus(snapshot: FocusSnapshot | null): void {
  if (!snapshot) return;
  const target = document.querySelector(`[data-key="${CSS.escape(snapshot.key)}"]`);
  if (!(target instanceof HTMLElement)) return;
  target.focus({ preventScroll: true });
  if (
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
    snapshot.start !== null &&
    snapshot.end !== null
  ) {
    try {
      target.setSelectionRange(snapshot.start, snapshot.end);
      target.scrollTop = snapshot.scrollTop;
    } catch {
      /* input types without selection support */
    }
  }
}

/** Re-rendering must never steal the caret from someone mid-sentence. */
export function withFocusPreserved(render: () => void): void {
  const snapshot = snapshotFocus();
  render();
  restoreFocus(snapshot);
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let handle: number | undefined;
  return ((...args: never[]) => {
    if (handle !== undefined) window.clearTimeout(handle);
    handle = window.setTimeout(() => fn(...args), ms);
  }) as T;
}

export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const signatures = new WeakMap<Element, string>();

/**
 * Re-renders a region only when the data it shows actually changed. Rebuilding
 * on every push used to eat clicks (mousedown on one button, mouseup on its
 * replacement) and restart animations for everyone in the room.
 */
export function patch(host: Element, signature: unknown, build: () => Child | Child[]): void {
  const key = JSON.stringify(signature);
  if (signatures.get(host) === key) return;
  signatures.set(host, key);
  const built = build();
  mount(host, ...(Array.isArray(built) ? built : [built]));
}

/** Sets a control's disabled state without touching anything else about it. */
export function setDisabled(element: HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, disabled: boolean): void {
  if (element.disabled !== disabled) element.disabled = disabled;
}

/** Soft timers only count; they never stop anyone from doing anything. */
export function countdown(endsAt: number, now: number): { text: string; over: boolean } {
  const left = Math.ceil((endsAt - now) / 1000);
  return left > 0 ? { text: formatClock(left), over: false } : { text: `+${formatClock(-left)}`, over: true };
}
