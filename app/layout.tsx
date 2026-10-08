import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Z-Agent",
  description: "A capable AI agent built by Bolo67-ctrl."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}