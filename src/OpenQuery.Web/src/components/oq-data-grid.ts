import { LitElement, css, html, type PropertyValues } from 'lit';
import type { CellValue } from '../api.js';

export interface GridColumn {
  name: string;
  type: string;
}

interface CellPos {
  r: number; // view row index (after sorting)
  c: number;
}

const GUTTER_MIN = 44;
const OVERSCAN = 8;
const MAX_CELL_CHARS = 400;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * High-performance virtualized result grid.
 *
 * - Only visible rows exist in the DOM; a fixed pool of row elements is recycled on scroll
 *   (no per-scroll allocation, no framework diffing in the hot path).
 * - Column widths live in one CSS custom property, so resizing touches a single style.
 * - Cell range selection (click / shift-click / drag / keyboard), Ctrl+C copies TSV,
 *   Ctrl+Shift+C copies with headers, click header to sort, drag header edge to resize,
 *   double-click header edge to auto-fit.
 */
export class OqDataGrid extends LitElement {
  static properties = {
    columns: { attribute: false },
    rows: { attribute: false },
  };

  declare columns: GridColumn[];
  declare rows: CellValue[][];

  private widths: number[] = [];
  private numeric: boolean[] = [];
  private order: number[] = [];
  private sort: { col: number; dir: 1 | -1 } | null = null;
  private anchor: CellPos | null = null;
  private focusCell: CellPos | null = null;
  private dragging = false;

  private pool: HTMLDivElement[] = [];
  private viewport!: HTMLDivElement;
  private canvas!: HTMLDivElement;
  private rowHeight = 26;
  private gutterWidth = GUTTER_MIN;
  private frame = 0;
  private resizeObserver = new ResizeObserver(() => this.schedulePaint(true));

  constructor() {
    super();
    this.columns = [];
    this.rows = [];
  }

  static styles = css`
    :host {
      display: block;
      position: relative;
      overflow: hidden;
      font-family: var(--oq-grid-font);
      font-size: var(--oq-grid-font-size);
      color: var(--wa-color-text-normal);
      background: var(--wa-color-surface-default);
      --row-h: var(--oq-grid-row-height, 26px);
      --border: var(--wa-color-surface-border);
    }
    .viewport {
      position: absolute;
      inset: 0;
      overflow: auto;
      outline: none;
      contain: strict;
    }
    .header {
      position: sticky;
      top: 0;
      z-index: 2;
      display: grid;
      grid-template-columns: var(--cols);
      height: var(--row-h);
      width: max-content;
      min-width: 100%;
      background: var(--wa-color-surface-raised);
      border-bottom: 1px solid var(--border);
      font-family: var(--wa-font-family-body);
      font-weight: 600;
      user-select: none;
    }
    .hcell {
      position: relative;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 8px;
      border-right: 1px solid var(--border);
      overflow: hidden;
      white-space: nowrap;
      cursor: pointer;
    }
    .hcell .name {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .hcell .sort {
      color: var(--wa-color-brand-fill-loud);
      font-size: 10px;
    }
    .hcell:hover {
      background: var(--wa-color-neutral-fill-quiet);
    }
    .hcell.gutter {
      cursor: cell;
    }
    .resizer {
      position: absolute;
      top: 0;
      right: -4px;
      width: 8px;
      height: 100%;
      cursor: col-resize;
      z-index: 1;
    }
    .canvas {
      position: relative;
      width: max-content;
      min-width: 100%;
    }
    .row {
      position: absolute;
      top: 0;
      left: 0;
      display: grid;
      grid-template-columns: var(--cols);
      height: var(--row-h);
      line-height: var(--row-h);
      will-change: transform;
    }
    .row.odd .cell {
      background: color-mix(in oklab, var(--wa-color-surface-default), var(--wa-color-text-normal) 2.5%);
    }
    .cell {
      padding: 0 8px;
      overflow: hidden;
      white-space: pre;
      text-overflow: ellipsis;
      border-right: 1px solid var(--border);
      border-bottom: 1px solid color-mix(in oklab, var(--border) 50%, transparent);
      background: var(--wa-color-surface-default);
      cursor: cell;
    }
    .cell.num {
      text-align: right;
    }
    .cell.null {
      color: var(--oq-null);
      font-style: italic;
    }
    .cell.gutter,
    .hcell.gutter {
      position: sticky;
      left: 0;
      z-index: 1;
      text-align: right;
      color: var(--wa-color-text-quiet);
      background: var(--wa-color-surface-raised) !important;
    }
    .row .cell.sel {
      background: var(--oq-selection);
    }
    .row .cell.focus {
      outline: 2px solid var(--wa-color-brand-fill-loud);
      outline-offset: -2px;
    }
    .row .cell.gutter.sel {
      color: var(--wa-color-text-normal);
    }
    .empty {
      padding: 12px;
      color: var(--wa-color-text-quiet);
      font-family: var(--wa-font-family-body);
    }
  `;

  render() {
    const cols = this.columns ?? [];
    return html`
      <div class="viewport" tabindex="0" @scroll=${() => this.schedulePaint()} @keydown=${this.onKeyDown}>
        <div class="header">
          <div class="hcell gutter" title="Select all" @click=${this.selectAll}></div>
          ${cols.map(
            (col, i) => html`
              <div class="hcell" title="${col.name} (${col.type})" @click=${() => this.toggleSort(i)}>
                <span class="name">${col.name}</span>
                ${this.sort?.col === i ? html`<span class="sort">${this.sort.dir === 1 ? '▲' : '▼'}</span>` : null}
                <div
                  class="resizer"
                  @pointerdown=${(e: PointerEvent) => this.startResize(e, i)}
                  @click=${(e: Event) => e.stopPropagation()}
                  @dblclick=${(e: Event) => {
                    e.stopPropagation();
                    this.autoFit(i);
                  }}
                ></div>
              </div>
            `,
          )}
        </div>
        <div class="canvas" @pointerdown=${this.onPointerDown}></div>
        ${cols.length === 0 ? html`<div class="empty">No columns</div>` : null}
      </div>
    `;
  }

  firstUpdated() {
    this.viewport = this.renderRoot.querySelector('.viewport')!;
    this.canvas = this.renderRoot.querySelector('.canvas')!;
    this.resizeObserver.observe(this.viewport);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.frame);
  }

  willUpdate(changed: PropertyValues<this>) {
    if (changed.has('columns') || changed.has('rows')) {
      this.sort = null;
      this.anchor = this.focusCell = null;
      this.order = Array.from({ length: this.rows.length }, (_, i) => i);
      this.numeric = this.columns.map((_, c) => this.detectNumeric(c));
    }
  }

  updated(changed: PropertyValues<this>) {
    if (changed.has('columns') || changed.has('rows')) {
      this.rowHeight = parseFloat(getComputedStyle(this).getPropertyValue('--row-h')) || 26;
      this.gutterWidth = Math.max(GUTTER_MIN, String(this.rows.length).length * 8 + 20);
      this.widths = this.columns.map((_, i) => this.measureColumn(i));
      this.rebuildPool();
      this.viewport.scrollTop = 0;
      this.viewport.scrollLeft = 0;
      this.applyLayout();
    }
  }

  /** Copy the current selection (or everything if nothing selected) as TSV. */
  async copySelection(withHeaders = false) {
    const range = this.selectionRange() ?? { r1: 0, c1: 0, r2: this.rows.length - 1, c2: this.columns.length - 1 };
    const lines: string[] = [];
    if (withHeaders) lines.push(this.columns.slice(range.c1, range.c2 + 1).map((c) => c.name).join('\t'));
    for (let r = range.r1; r <= range.r2; r++) {
      const row = this.rows[this.order[r]];
      const out: string[] = [];
      for (let c = range.c1; c <= range.c2; c++) out.push(row[c] === null ? 'NULL' : String(row[c]));
      lines.push(out.join('\t'));
    }
    await navigator.clipboard.writeText(lines.join('\n'));
  }

  // ---- Layout & painting -----------------------------------------------------

  private applyLayout() {
    const template = [this.gutterWidth, ...this.widths].map((w) => `${w}px`).join(' ');
    this.viewport.style.setProperty('--cols', template);
    this.canvas.style.height = `${this.rows.length * this.rowHeight}px`;
    this.canvas.style.width = `${this.gutterWidth + this.widths.reduce((a, b) => a + b, 0)}px`;
    this.schedulePaint(true);
  }

  private rebuildPool() {
    this.canvas.replaceChildren();
    this.pool = [];
    this.ensurePool();
  }

  private ensurePool() {
    const needed = Math.ceil((this.viewport.clientHeight || 600) / this.rowHeight) + OVERSCAN * 2;
    const colCount = this.columns.length;
    while (this.pool.length < needed) {
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.v = '-1';
      for (let c = 0; c <= colCount; c++) {
        const cell = document.createElement('div');
        cell.className = c === 0 ? 'cell gutter' : 'cell';
        row.appendChild(cell);
      }
      this.canvas.appendChild(row);
      this.pool.push(row);
    }
  }

  private schedulePaint(force = false) {
    if (force) this.pool.forEach((r) => (r.dataset.v = '-1'));
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private paint() {
    if (!this.viewport || this.columns.length === 0) return;
    this.ensurePool();
    const total = this.rows.length;
    const first = Math.max(0, Math.floor(this.viewport.scrollTop / this.rowHeight) - OVERSCAN);
    const range = this.selectionRange();
    const colCount = this.columns.length;

    for (let i = 0; i < this.pool.length; i++) {
      const rowEl = this.pool[i];
      const v = first + i;
      if (v >= total) {
        rowEl.style.display = 'none';
        rowEl.dataset.v = '-1';
        continue;
      }
      rowEl.style.display = '';
      const cells = rowEl.children as HTMLCollectionOf<HTMLDivElement>;

      if (rowEl.dataset.v !== String(v)) {
        rowEl.dataset.v = String(v);
        rowEl.style.transform = `translateY(${v * this.rowHeight}px)`;
        rowEl.classList.toggle('odd', v % 2 === 1);
        const data = this.rows[this.order[v]];
        cells[0].textContent = String(v + 1);
        for (let c = 0; c < colCount; c++) {
          const cell = cells[c + 1];
          const value = data[c];
          if (value === null || value === undefined) {
            cell.textContent = 'NULL';
            cell.className = 'cell null';
          } else {
            const text = String(value);
            cell.textContent = text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) + '…' : text;
            cell.className = this.numeric[c] ? 'cell num' : 'cell';
          }
        }
      }

      // Selection state (cheap: only visible cells).
      const rowSelected = !!range && v >= range.r1 && v <= range.r2;
      cells[0].classList.toggle('sel', rowSelected);
      for (let c = 0; c < colCount; c++) {
        const cell = cells[c + 1];
        cell.classList.toggle('sel', rowSelected && c >= range!.c1 && c <= range!.c2);
        cell.classList.toggle('focus', this.focusCell?.r === v && this.focusCell?.c === c);
      }
    }
  }

  // ---- Measuring -------------------------------------------------------------

  private measureCtx?: CanvasRenderingContext2D;

  private textWidth(text: string, bold = false) {
    if (!this.measureCtx) {
      this.measureCtx = document.createElement('canvas').getContext('2d')!;
    }
    const style = getComputedStyle(this);
    this.measureCtx.font = `${bold ? '600 ' : ''}${style.fontSize} ${style.fontFamily}`;
    return this.measureCtx.measureText(text).width;
  }

  private measureColumn(c: number, sample = 200) {
    let max = this.textWidth(this.columns[c].name, true) + 28;
    const step = Math.max(1, Math.floor(this.rows.length / sample));
    for (let r = 0; r < this.rows.length; r += step) {
      const v = this.rows[r][c];
      const text = v === null ? 'NULL' : String(v).slice(0, 120);
      max = Math.max(max, this.textWidth(text) + 18);
    }
    return Math.round(Math.min(Math.max(max, 56), 420));
  }

  private autoFit(c: number) {
    this.widths[c] = this.measureColumn(c, 2000);
    this.applyLayout();
  }

  private detectNumeric(c: number) {
    if (/int|decimal|numeric|money|float|real|double/i.test(this.columns[c].type)) return true;
    for (let r = 0; r < Math.min(this.rows.length, 50); r++) {
      const v = this.rows[r][c];
      if (v !== null) return typeof v === 'number';
    }
    return false;
  }

  // ---- Interaction -----------------------------------------------------------

  private startResize(e: PointerEvent, c: number) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = this.widths[c];
    const target = e.target as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      this.widths[c] = Math.max(40, startW + ev.clientX - startX);
      this.applyLayout();
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  }

  private toggleSort(c: number) {
    const dir: 1 | -1 = this.sort?.col === c && this.sort.dir === 1 ? -1 : 1;
    this.sort = { col: c, dir };
    const rows = this.rows;
    const numeric = this.numeric[c];
    this.order.sort((a, b) => {
      const x = rows[a][c];
      const y = rows[b][c];
      if (x === y) return a - b;
      if (x === null) return -dir;
      if (y === null) return dir;
      const cmp = numeric ? Number(x) - Number(y) : collator.compare(String(x), String(y));
      return (cmp || a - b) * dir;
    });
    this.requestUpdate();
    this.schedulePaint(true);
  }

  private cellAt(clientX: number, clientY: number): CellPos {
    const rect = this.canvas.getBoundingClientRect();
    const y = clientY - rect.top;
    const r = Math.min(Math.max(Math.floor(y / this.rowHeight), 0), this.rows.length - 1);
    let x = clientX - rect.left - this.gutterWidth;
    // Over the sticky gutter: treat as column 0 (row selection handled by caller).
    let c = 0;
    if (x > 0) {
      for (c = 0; c < this.widths.length - 1 && x > this.widths[c]; c++) x -= this.widths[c];
    }
    return { r, c };
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.rows.length === 0) return;
    this.viewport.focus({ preventScroll: true });
    const onGutter = e.clientX - this.viewport.getBoundingClientRect().left < this.gutterWidth;
    const pos = this.cellAt(e.clientX, e.clientY);

    if (onGutter) {
      // Row selection
      const last = this.columns.length - 1;
      if (e.shiftKey && this.anchor) this.focusCell = { r: pos.r, c: last };
      else {
        this.anchor = { r: pos.r, c: 0 };
        this.focusCell = { r: pos.r, c: last };
      }
    } else if (e.shiftKey && this.anchor) {
      this.focusCell = pos;
    } else {
      this.anchor = this.focusCell = pos;
    }
    this.schedulePaint();

    this.dragging = true;
    const move = (ev: PointerEvent) => {
      if (!this.dragging) return;
      const p = this.cellAt(ev.clientX, ev.clientY);
      this.focusCell = onGutter ? { r: p.r, c: this.columns.length - 1 } : p;
      this.schedulePaint();
    };
    const up = () => {
      this.dragging = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  private selectAll = () => {
    if (!this.rows.length || !this.columns.length) return;
    this.anchor = { r: 0, c: 0 };
    this.focusCell = { r: this.rows.length - 1, c: this.columns.length - 1 };
    this.schedulePaint();
  };

  private selectionRange() {
    if (!this.anchor || !this.focusCell) return null;
    return {
      r1: Math.min(this.anchor.r, this.focusCell.r),
      r2: Math.max(this.anchor.r, this.focusCell.r),
      c1: Math.min(this.anchor.c, this.focusCell.c),
      c2: Math.max(this.anchor.c, this.focusCell.c),
    };
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      this.copySelection(e.shiftKey);
      return;
    }
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      this.selectAll();
      return;
    }
    if (!this.rows.length) return;

    const cur = this.focusCell ?? { r: 0, c: 0 };
    const page = Math.max(1, Math.floor(this.viewport.clientHeight / this.rowHeight) - 1);
    const lastR = this.rows.length - 1;
    const lastC = this.columns.length - 1;
    let next: CellPos | null = null;
    switch (e.key) {
      case 'ArrowDown': next = { r: mod ? lastR : cur.r + 1, c: cur.c }; break;
      case 'ArrowUp': next = { r: mod ? 0 : cur.r - 1, c: cur.c }; break;
      case 'ArrowRight': next = { r: cur.r, c: mod ? lastC : cur.c + 1 }; break;
      case 'ArrowLeft': next = { r: cur.r, c: mod ? 0 : cur.c - 1 }; break;
      case 'PageDown': next = { r: cur.r + page, c: cur.c }; break;
      case 'PageUp': next = { r: cur.r - page, c: cur.c }; break;
      case 'Home': next = { r: mod ? 0 : cur.r, c: 0 }; break;
      case 'End': next = { r: mod ? lastR : cur.r, c: lastC }; break;
      default: return;
    }
    e.preventDefault();
    next = { r: Math.min(Math.max(next.r, 0), lastR), c: Math.min(Math.max(next.c, 0), lastC) };
    if (e.shiftKey && this.anchor) this.focusCell = next;
    else this.anchor = this.focusCell = next;
    this.scrollCellIntoView(next);
    this.schedulePaint();
  };

  private scrollCellIntoView(pos: CellPos) {
    const vp = this.viewport;
    const top = pos.r * this.rowHeight;
    const headerH = this.rowHeight;
    if (top < vp.scrollTop) vp.scrollTop = top;
    else if (top + this.rowHeight > vp.scrollTop + vp.clientHeight - headerH)
      vp.scrollTop = top + this.rowHeight - vp.clientHeight + headerH;

    let left = this.gutterWidth;
    for (let c = 0; c < pos.c; c++) left += this.widths[c];
    const right = left + this.widths[pos.c];
    if (left - this.gutterWidth < vp.scrollLeft) vp.scrollLeft = left - this.gutterWidth;
    else if (right > vp.scrollLeft + vp.clientWidth) vp.scrollLeft = right - vp.clientWidth;
  }
}

customElements.define('oq-data-grid', OqDataGrid);

declare global {
  interface HTMLElementTagNameMap {
    'oq-data-grid': OqDataGrid;
  }
}
