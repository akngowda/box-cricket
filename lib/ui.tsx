'use client';

/**
 * Shared bits of the prototype's design system as components.
 * §7 — every tap is onPointerDown, not onClick, and buzzes.
 */

import Link from 'next/link';
import { useState, type ReactNode } from 'react';

export function tap(fn?: () => void, pattern: number | number[] = 10) {
  return (): void => {
    navigator.vibrate?.(pattern);
    fn?.();
  };
}

export function Btn({
  children,
  onTap,
  disabled,
  className = '',
  style,
  buzz,
}: {
  children: ReactNode;
  onTap?: () => void;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  buzz?: number | number[];
}) {
  return (
    <button
      className={className}
      style={style}
      disabled={disabled}
      onPointerDown={disabled ? undefined : tap(onTap, buzz ?? 10)}
    >
      {children}
    </button>
  );
}

export function TopBar({ title, back, right }: { title: string; back?: string; right?: ReactNode }) {
  return (
    <div className="bar">
      {back && (
        <Link href={back} className="back" style={{ textDecoration: 'none' }}>
          ‹
        </Link>
      )}
      <h2>{title}</h2>
      {right}
    </div>
  );
}

export function Sheet({
  title,
  onClose,
  children,
}: {
  title?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="sheet" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheetbody">
        <div className="grab" />
        {title && (
          <h3 style={{ margin: '0 0 12px', fontFamily: 'var(--font-num)', fontSize: 20, fontWeight: 600 }}>
            {title}
          </h3>
        )}
        {children}
      </div>
    </div>
  );
}

export function Toggle({ on, onTap }: { on: boolean; onTap: () => void }) {
  return <button className={`tog ${on ? 'on' : ''}`} onPointerDown={tap(onTap)} aria-pressed={on} />;
}

export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="card" style={{ padding: '11px 13px', marginBottom: 7 }}>
      <div className="row">
        <div style={{ flex: 1, fontSize: 13 }}>
          {label}
          {hint && <div className="sub" style={{ fontSize: 10.5, marginTop: 2 }}>{hint}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

export type Tab = 'matches' | 'series' | 'ranks' | 'rules' | 'admin';

export function TabBar({ active }: { active: Tab }) {
  const tabs: Array<{ id: Tab; label: string; icon: string; href: string }> = [
    { id: 'matches', label: 'Matches', icon: '🏏', href: '/' },
    { id: 'series', label: 'Series', icon: '🏆', href: '/series' },
    { id: 'ranks', label: 'Ranks', icon: '📊', href: '/ranks' },
    { id: 'rules', label: 'Rules', icon: '📖', href: '/rules' },
    { id: 'admin', label: 'Admin', icon: '⚙', href: '/admin' },
  ];
  return (
    <div className="tabbar" style={{ gridTemplateColumns: `repeat(${tabs.length},1fr)` }}>
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          style={{ textDecoration: 'none' }}
          className={active === t.id ? 'on' : ''}
        >
          <button className={active === t.id ? 'on' : ''} style={{ width: '100%' }}>
            <span>{t.icon}</span>
            {t.label}
          </button>
        </Link>
      ))}
    </div>
  );
}

/**
 * Save as PDF. Every browser's print dialog can write a PDF, so there is no
 * library, no server and no cost — and the print stylesheet in globals.css is
 * what turns the dark scoring UI into a clean black-on-white report.
 */
export function PrintButton({ label = 'Save as PDF' }: { label?: string }) {
  return (
    <Btn className="btn ghost noprint" onTap={() => window.print()}>
      {label}
    </Btn>
  );
}

/** The masthead a printed report needs, since the app bar is hidden on paper. */
export function PrintHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="printonly" style={{ marginBottom: 14, borderBottom: '2px solid #111', paddingBottom: 8 }}>
      <div style={{ fontFamily: 'var(--font-num)', fontSize: 22, fontWeight: 700 }}>{title}</div>
      {subtitle && <div style={{ fontSize: 11, color: '#555' }}>{subtitle}</div>}
      <div style={{ fontSize: 10, color: '#777', marginTop: 2 }}>Box Cricket</div>
    </div>
  );
}

/**
 * Numbers are never typed into a free-text box. Tapping the value opens a
 * sheet with the usual choices to tap, plus a phone-style keypad for anything
 * else. On the turf that is far quicker than a keyboard, and it cannot produce
 * a nonsense value.
 */
export function NumberPicker({
  value,
  onChange,
  label,
  quick = [],
  min = 0,
  max = 99,
  width = 64,
}: {
  value: number;
  onChange: (n: number) => void;
  label: string;
  quick?: number[];
  min?: number;
  max?: number;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);

  const shown = typed ?? String(value);
  const parsed = Number(shown === '' ? NaN : shown);
  const valid = Number.isFinite(parsed) && parsed >= min && parsed <= max;

  const close = (): void => {
    setOpen(false);
    setTyped(null);
  };

  return (
    <>
      <button
        className="field"
        style={{ width, textAlign: 'center', padding: 10, fontFamily: 'var(--font-num)', fontSize: 20, fontWeight: 600 }}
        onPointerDown={tap(() => setOpen(true))}
      >
        {value}
      </button>

      {open && (
        <Sheet title={label} onClose={close}>
          <div style={{ textAlign: 'center', margin: '4px 0 14px' }}>
            <div className="score" style={{ fontSize: 44 }}>{shown === '' ? '—' : shown}</div>
            {!valid && shown !== '' && (
              <div className="sub" style={{ color: 'var(--strike)' }}>
                between {min} and {max}
              </div>
            )}
          </div>

          {quick.length > 0 && (
            <>
              <div className="lbl" style={{ marginTop: 0 }}>Usual</div>
              <div className="grid4" style={{ marginBottom: 14 }}>
                {quick.map((n) => (
                  <button
                    key={n}
                    className={`opt ${value === n && typed === null ? 'on' : ''}`}
                    onPointerDown={tap(() => {
                      onChange(n);
                      close();
                    })}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </>
          )}

          <div className="keypad">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => (
              <button
                key={d}
                onPointerDown={tap(() => setTyped(((typed ?? '') + d).replace(/^0+/, '').slice(0, 2)))}
              >
                {d}
              </button>
            ))}
            <button onPointerDown={tap(() => setTyped(null))} style={{ fontSize: 15 }}>
              clear
            </button>
            <button onPointerDown={tap(() => setTyped(((typed ?? '') + '0').replace(/^0+/, '').slice(0, 2)))}>
              0
            </button>
            <button
              onPointerDown={tap(() => setTyped((typed ?? '').slice(0, -1)))}
              style={{ fontSize: 18 }}
            >
              ⌫
            </button>
          </div>

          <Btn
            className="btn primary"
            style={{ marginTop: 14 }}
            disabled={!valid}
            onTap={() => {
              onChange(parsed);
              close();
            }}
          >
            Done
          </Btn>
        </Sheet>
      )}
    </>
  );
}
