import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SentryAgent",
  description: "Spend-policy guardrails for autonomous AI wallets on Casper Network.",
  icons: {
    icon: "/sentryagent-logo.png",
    shortcut: "/sentryagent-logo.png",
    apple: "/sentryagent-logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
