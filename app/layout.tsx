import { Analytics } from '@vercel/analytics/next'
import { Geist, Geist_Mono } from 'next/font/google'
import type { Metadata, Viewport } from 'next'
import './globals.css'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' })

export const metadata: Metadata = {
  title: 'BTC 5M — Polymarket FOK Maker Terminal',
  description:
    'Ultra-low latency dual-pipeline (Paper V1 / Live V2) FOK limit-maker terminal for Polymarket 5-minute Bitcoin Up/Down contracts, with a 6-edge quant strategy registry.',
  generator: 'v0.app',
}

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#f7f7f9',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`bg-background ${geist.variable} ${geistMono.variable}`}>
      <body className="font-sans antialiased">
        {children}
        {/* Only load Vercel Analytics when actually deployed on Vercel.
            On a self-hosted VPS the /_vercel/insights/script.js endpoint
            does not exist and produces a 404 in the console. */}
        {process.env.NODE_ENV === 'production' && process.env.VERCEL === '1' && <Analytics />}
      </body>
    </html>
  )
}
