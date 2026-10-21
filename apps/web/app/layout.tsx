import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '$PLASHSPY — Whale Tracker',
  description: 'Real-time large-bet alerts for NBA and NFL markets on Kalshi and Polymarket US.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased font-sans">{children}</body>
    </html>
  );
}
