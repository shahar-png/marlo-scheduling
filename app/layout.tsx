import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './tokens/marlo.css';
import './marlo-ui.css';

export const metadata: Metadata = {
  title: 'Marlo Scheduling',
  description: 'Book time with Marlo — public scheduling pages.',
};

// Handoff §4.3: Outfit (display) + Manrope (text) from Google Fonts, display=swap.
const GOOGLE_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700&family=Manrope:wght@400;500;600;700&display=swap';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link rel="stylesheet" href={GOOGLE_FONTS_HREF} />
      </head>
      <body>{children}</body>
    </html>
  );
}
