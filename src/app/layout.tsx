import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "The Hood",
  description: "A private, self-destructing chat room application. Create secure rooms that automatically expire after 10 minutes, with real-time messaging and automatic message deletion.",
  icons: {
    icon: "/icon.svg",
  },
  openGraph: {
    title: "The Hood",
    description: "A private, self-destructing chat room application. Create secure rooms that automatically expire after 10 minutes, with real-time messaging and automatic message deletion.",
    images: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${jetbrainsMono.variable} antialiased`}
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
