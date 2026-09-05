import type { Metadata, Viewport } from 'next';
import { Barlow_Condensed, IBM_Plex_Sans } from 'next/font/google';
import { SyncPill } from '../lib/SyncPill';
import './globals.css';

// The prototype's two faces: condensed for numbers, Plex for everything else.
const num = Barlow_Condensed({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-num',
  display: 'swap',
});
const ui = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-ui',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Box Cricket',
  description: 'Weekend box cricket — live scores, scorecards and rankings',
};

// §7 — viewport-fit=cover so the pad clears the iPhone home bar.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#0b1512',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // Extensions (recorders, password managers, translators) add attributes to
    // <html> and <body> before React hydrates. That mismatch aborts hydration
    // and leaves the page with no event handlers — buttons stop working. This
    // tells React to ignore attribute differences on these two elements only.
    <html lang="en" className={`${num.variable} ${ui.variable}`} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <SyncPill />
        {children}
      </body>
    </html>
  );
}
