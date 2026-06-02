import './globals.css';
import { ForkModeBanner } from '@/components/ForkModeBanner';
import { Providers } from './providers';

export const metadata = {
  title: 'DeFi Composer — Autonomous Treasury OS',
  description: 'Institutional-grade autonomous DeFi management.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-aesthetic="onchain">
      <body>
        <ForkModeBanner />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
