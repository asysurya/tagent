import type { Metadata, Viewport } from "next";
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
  icons: { icon: "/logo.svg" },
};

/* Android Chrome does not resize the layout viewport when the virtual
 * keyboard opens — without this the chat composer stays hidden behind it.
 * `interactiveWidget: "resizes-content"` makes the visual+layout viewport
 * shrink, so h-dvh tracks the visible area (A7 note, wired by A9). */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
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
