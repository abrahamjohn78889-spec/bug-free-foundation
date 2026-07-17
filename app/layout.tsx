import { Analytics } from '@vercel/analytics/next'
import { Geist, JetBrains_Mono } from 'next/font/google'
import type { Metadata, Viewport } from 'next'
import { SettingsBoot } from '@/components/v2/settings-boot'
import './globals.css'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' })
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' })

export const metadata: Metadata = {
  title: 'BTC 5M — Polymarket FOK Maker Terminal',
  description:
    'Ultra-low latency dual-pipeline (Paper V1 / Live V2) FOK limit-maker terminal for Polymarket 5-minute Bitcoin Up/Down contracts, with a 6-edge quant strategy registry.',
  generator: 'BTC 5M Terminal',
}

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#08090d',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`dark bg-background ${geist.variable} ${jetbrains.variable}`}
      suppressHydrationWarning
    >
      <body className="font-sans antialiased">
        <SettingsBoot />
        {children}
        {process.env.NODE_ENV === 'production' && process.env.VERCEL === '1' && <Analytics />}
      </body>
    </html>
  )
}
