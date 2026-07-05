import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SentryAgent",
  description: "Spend-policy guardrails for autonomous AI wallets on Casper Network.",
  icons: {
    icon: "/sentryagent-favicon.svg",
    shortcut: "/sentryagent-favicon.svg",
    apple: "/sentryagent-favicon.svg",
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
