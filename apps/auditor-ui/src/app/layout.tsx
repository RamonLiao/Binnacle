import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/Providers';
import { Header } from '@/components/Header';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'ComplianceVault Auditor',
  description: 'Auditor dashboard for verifying AI agent events',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={inter.className}>
        <Providers>
          <div className="min-h-screen bg-background text-foreground flex flex-col">
            <Header />
            <main className="flex-1 p-6">
              {children}
            </main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
