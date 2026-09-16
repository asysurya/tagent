import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tagent — terminal-native coding agent",
  description:
    "An open, provider-agnostic coding agent engine with a web GUI: agentic loop, subagents, skills, memory, permissions, checkpoints, plugins. Runs locally, syncs to GitHub & MEGA.",
  keywords: ["tagent", "ai agent", "coding agent", "cli", "gui", "byok"],
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23ff7a2f'/%3E%3Ctext x='16' y='22' font-family='monospace' font-weight='bold' font-size='17' text-anchor='middle' fill='%2318181b'%3E%3E_%3C/text%3E%3C/svg%3E",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-zinc-950 text-zinc-200`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
