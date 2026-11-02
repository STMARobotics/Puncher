import { it, expect } from "vitest";
import { ScanBuffer } from "../ui/src/scanner";
it("submits CR LF CRLF once, rejects bad buffers and clears stale partial data", () => {
  const cards: string[] = [];
  let invalid = 0;
  const s = new ScanBuffer(
    (c) => cards.push(c),
    () => invalid++,
  );
  let t = 0;
  for (const ending of ["\r", "\n", "\r\n"])
    for (const c of `000123${ending}`) s.key(c, (t += 10));
  expect(cards).toEqual(["000123", "000123", "000123"]);
  s.key("0", (t += 10));
  s.key("1", (t += 11000));
  s.key("Enter", (t += 10));
  expect(invalid).toBe(1);
  for (const c of "000456") s.key(c, (t += 10));
  s.clear();
  s.key("Enter", (t += 10));
  expect(cards).toHaveLength(3);
});
it("preserves manual typing pauses, leading zeros, and editable corrections", () => {
  const cards: string[] = [];
  let invalid = 0,
    t = 0;
  const progress: number[] = [];
  const s = new ScanBuffer(
    (card) => cards.push(card),
    () => invalid++,
    { onChange: (length) => progress.push(length) },
  );
  for (const c of "000129") s.key(c, (t += 1400));
  s.key("Backspace", (t += 50));
  s.key("3", (t += 1400));
  s.key("Enter", (t += 1400));
  expect(cards).toEqual(["000123"]);
  expect(invalid).toBe(0);
  expect(progress).toContain(6);
  expect(progress.at(-1)).toBe(0);
  for (const c of "123") s.key(c, (t += 50));
  s.selectAll();
  for (const c of "000456") s.key(c, (t += 1400));
  s.key("Enter", (t += 10));
  expect(cards).toEqual(["000123", "000456"]);
});
it("cancels abandoned input and never submits partial or malformed edits", () => {
  const cards: string[] = [];
  let invalid = 0,
    t = 0;
  const s = new ScanBuffer(
    (card) => cards.push(card),
    () => invalid++,
  );
  for (const c of "000") s.key(c, (t += 10));
  s.key("Escape", (t += 10));
  s.key("Enter", (t += 10));
  for (const c of "000") s.key(c, (t += 10));
  s.selectAll();
  s.key("Backspace", (t += 10));
  s.key("Enter", (t += 10));
  for (const c of "0001234") s.key(c, (t += 10));
  s.key("Enter", (t += 10));
  expect(invalid).toBe(1);
  expect(cards).toEqual([]);
  for (const c of "000123") s.key(c, (t += 10));
  s.key("Enter", (t += 10));
  s.key("\r", (t += 10));
  s.key("\n", (t += 10));
  expect(cards).toEqual(["000123"]);
});
