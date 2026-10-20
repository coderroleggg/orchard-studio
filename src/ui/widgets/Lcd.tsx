// Seven-segment style numeric display (original segment drawing).

import { memo } from 'react';

//  segments: a top, b upper-right, c lower-right, d bottom, e lower-left, f upper-left, g middle
const DIGITS: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc',
  '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '', 'b': 'fgedc', 'A': 'abcefg',
};

interface LcdProps {
  text: string; // digits, '.', ':', '-', ' '
  height?: number;
  color?: string;
  dim?: string;
  small?: number; // number of trailing characters rendered smaller
}

export const Lcd = memo(function Lcd({ text, height = 22, color = 'var(--lcd-on, #dce9ef)', dim = 'rgba(220,233,239,0.06)', small = 0 }: LcdProps) {
  const chars = text.split('');
  let x = 0;
  const parts: React.ReactNode[] = [];
  const smallStart = chars.length - small;
  chars.forEach((ch, idx) => {
    const isSmall = idx >= smallStart && small > 0;
    const h = isSmall ? height * 0.68 : height;
    const w = h * 0.52;
    const t = Math.max(1.6, h * 0.11); // segment thickness
    const y0 = height - h;
    if (ch === '.' || ch === ':') {
      const r = t * 0.55;
      if (ch === '.') parts.push(<rect key={idx} x={x + 0.5} y={height - t} width={t} height={t} rx={r * 0.4} fill={color} />);
      else {
        parts.push(<rect key={idx + 'a'} x={x + 0.5} y={y0 + h * 0.28} width={t} height={t} fill={color} />);
        parts.push(<rect key={idx + 'b'} x={x + 0.5} y={y0 + h * 0.66} width={t} height={t} fill={color} />);
      }
      x += t + 2.5;
      return;
    }
    const on = DIGITS[ch] ?? '';
    const g = (k: string) => (on.includes(k) ? color : dim);
    const hx = w - t; // horizontal seg length area
    const vy = (h - 3 * t) / 2; // vertical seg length
    // polygons with bevelled ends
    const H = (sx: number, sy: number, k: string) => (
      <polygon key={idx + k}
        points={`${sx + t * 0.5},${sy} ${sx + hx - t * 0.5},${sy} ${sx + hx},${sy + t / 2} ${sx + hx - t * 0.5},${sy + t} ${sx + t * 0.5},${sy + t} ${sx},${sy + t / 2}`}
        fill={g(k)} />
    );
    const V = (sx: number, sy: number, k: string) => (
      <polygon key={idx + k}
        points={`${sx + t / 2},${sy} ${sx + t},${sy + t * 0.5} ${sx + t},${sy + vy + t * 0.5} ${sx + t / 2},${sy + vy + t} ${sx},${sy + vy + t * 0.5} ${sx},${sy + t * 0.5}`}
        fill={g(k)} />
    );
    const ox = x + t / 2;
    parts.push(H(ox, y0, 'a'));
    parts.push(V(ox + hx - t / 2, y0 + t / 2, 'b'));
    parts.push(V(ox + hx - t / 2, y0 + t * 1.5 + vy, 'c'));
    parts.push(H(ox, y0 + h - t, 'd'));
    parts.push(V(ox - t / 2, y0 + t * 1.5 + vy, 'e'));
    parts.push(V(ox - t / 2, y0 + t / 2, 'f'));
    parts.push(H(ox, y0 + t + vy, 'g'));
    x += w + t * 0.9;
  });
  return (
    <svg width={Math.ceil(x)} height={height} style={{ display: 'block', overflow: 'visible' }}>
      {parts}
    </svg>
  );
});
