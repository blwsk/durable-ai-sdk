import type { ReactNode } from 'react';

export const metadata = { title: 'Durable agent' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'ui-monospace, monospace', margin: 0 }}>
        {children}
      </body>
    </html>
  );
}
