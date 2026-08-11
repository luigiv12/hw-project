import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Emissions Monitoring — Highwood',
  description: 'Methane emissions ingestion and compliance monitoring',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <div className="wrap">{children}</div>
      </body>
    </html>
  );
}
