export class ScanBuffer {
  private value = "";
  private last = 0;
  private selected = false;
  constructor(
    readonly submit: (card: string) => void,
    readonly invalid: () => void,
    readonly options: {
      idleTimeoutMs?: number;
      onChange?: (length: number) => void;
    } = {},
  ) {}
  key(key: string, now: number) {
    // A scanner sends a burst, but manual testing also needs time between keys.
    // Expire abandoned input without silently discarding normal typing pauses.
    if (now - this.last > (this.options.idleTimeoutMs ?? 10000)) this.clear();
    this.last = now;
    if (key === "Enter" || key === "\r" || key === "\n") {
      if (!this.value) return;
      const card = this.value;
      this.clear();
      if (/^[0-9]{6}$/.test(card)) this.submit(card);
      else this.invalid();
      return;
    }
    if (key === "Escape" || key === "Delete") {
      this.clear();
      return;
    }
    if (key === "Backspace") {
      this.value = this.selected ? "" : this.value.slice(0, -1);
      this.selected = false;
      this.options.onChange?.(this.value.length);
      return;
    }
    if (key.length === 1) {
      if (this.selected) this.value = "";
      this.selected = false;
      this.value = (this.value + key).slice(-32);
      this.options.onChange?.(this.value.length);
    }
  }
  selectAll() {
    this.selected = true;
  }
  clear() {
    this.value = "";
    this.selected = false;
    this.options.onChange?.(0);
  }
}
