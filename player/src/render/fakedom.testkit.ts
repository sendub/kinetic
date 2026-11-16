// A minimal element and document for the render tests that mount a panel in
// node, which has no DOM here (config.test.ts, volumes.test.ts): children,
// attributes, text, `value`, focus and listeners, with the one selector form
// the panels' click handlers use, an attribute name in brackets.

export class FakeElement {
  readonly tag: string;
  readonly children: FakeElement[] = [];
  /** Every child in order, text included (`append` takes strings too). */
  readonly childNodes: (FakeElement | string)[] = [];
  parent: FakeElement | null = null;
  id = "";
  className = "";
  type = "";
  hidden = false;
  private ownText = "";
  value = "";
  min = "";
  max = "";
  step = "";
  accept = "";
  /** A file input's chosen files (the picker's answer, set by a test). */
  files: unknown[] | null = null;
  /** How many times `click()` ran: a file input's picker opening. */
  clicks = 0;
  /** Inline style (the voices' progress bar sets its width). */
  readonly style: Record<string, string> = {};
  readonly ownerDocument: FakeDocument;
  private readonly attributes = new Map<string, string>();
  private readonly handlers = new Map<string, ((event: FakeEvent) => void)[]>();

  constructor(tag: string, doc: FakeDocument) {
    this.tag = tag;
    this.ownerDocument = doc;
  }

  /** Its own text and its children's, in order, as the DOM's is. */
  get textContent(): string {
    return (
      this.ownText +
      this.childNodes
        .map((node) => (typeof node === "string" ? node : node.textContent))
        .join("")
    );
  }

  set textContent(text: string) {
    this.ownText = text;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      this.childNodes.push(node);
      if (typeof node === "string") continue;
      node.parent = this;
      this.children.push(node);
    }
  }

  appendChild(node: FakeElement): void {
    this.append(node);
  }

  closest(selector: string): FakeElement | null {
    const name = selector.match(/^\[([^\]]+)\]$/)?.[1];
    if (name === undefined) return null;
    for (let el: FakeElement | null = this; el !== null; el = el.parent) {
      if (el.getAttribute(name) !== null) return el;
    }
    return null;
  }

  get parentElement(): FakeElement | null {
    return this.parent;
  }

  /** Makes it the document's active element, as a real `focus()` does. */
  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  /** Its descendants of the given tags (a selector like "button, input"), in tree order. */
  querySelectorAll(selector: string): FakeElement[] {
    const tags = selector.split(",").map((tag) => tag.trim());
    const all = (el: FakeElement): FakeElement[] => [
      ...el.children.flatMap((child) => [child, ...all(child)]),
    ];
    return all(this).filter((el) => tags.includes(el.tag));
  }

  /** Like a real `click()`: counts, then dispatches a bubbling click. */
  click(): void {
    this.clicks += 1;
    this.fire("click");
  }

  addEventListener(type: string, handler: (event: FakeEvent) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  /**
   * Fires the listeners of `type` on this element and then on each parent in
   * turn — a real event bubbles, and config.ts listens on the panel.
   */
  fire(type: string): void {
    const event = { target: this };
    for (let el: FakeElement | null = this; el !== null; el = el.parent) {
      for (const handler of el.handlers.get(type) ?? []) {
        handler(event);
      }
    }
  }
}

export interface FakeEvent {
  target: FakeElement;
}

export class FakeDocument {
  activeElement: FakeElement | null = null;
  private readonly handlers = new Map<string, ((event: unknown) => void)[]>();

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  addEventListener(type: string, handler: (event: never) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler as (event: unknown) => void);
    this.handlers.set(type, list);
  }

  /** Delivers `event` to the document's listeners of `type`. */
  dispatch(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }
}

// config.ts's click handler asks `target instanceof Element`; node has no
// such global, so for this file the stub is it.
globalThis.Element = FakeElement as unknown as typeof Element;

export function walk(el: FakeElement): FakeElement[] {
  return [el, ...el.children.flatMap(walk)];
}

export function find(
  root: FakeElement,
  label: string,
  predicate: (el: FakeElement) => boolean,
): FakeElement {
  const el = walk(root).find(predicate);
  if (el === undefined) throw new Error(`no ${label}`);
  return el;
}

/**
 * An element's own words as the screen shows them on its line: its text
 * without the tip a "?" carries (that is the button's description, drawn
 * only on hover, focus or a click).
 */
export function words(el: FakeElement): string {
  if (el.childNodes.length === 0) return el.textContent;
  return el.childNodes
    .map((node) =>
      typeof node === "string"
        ? node
        : node.className === "config-tipwrap"
          ? ""
          : words(node),
    )
    .join("");
}

// className is matched as a token: the speed readout carries two classes.
export const byClass = (root: FakeElement, className: string): FakeElement =>
  find(root, `.${className}`, (el) =>
    el.className.split(" ").includes(className),
  );

export const byAction = (root: FakeElement, action: string): FakeElement =>
  find(
    root,
    `[data-config-action=${action}]`,
    (el) => el.getAttribute("data-config-action") === action,
  );
