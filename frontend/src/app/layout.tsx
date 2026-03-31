import type { Metadata, Viewport } from "next";
import { Heebo } from "next/font/google";
import "./globals.css";

const heebo = Heebo({
  subsets: ["latin", "hebrew"],
  weight: ["400", "500", "600", "700", "800", "900"],
  display: "swap",
  variable: "--font-heebo",
});

export const metadata: Metadata = {
  title: "Israel Transport",
  description: "Real-time buses, trains & flights across Israel",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="he" className={heebo.variable} style={{ height: "100%", overflow: "hidden" }}>
      <body
        className={heebo.className}
        style={{ height: "100%", overflow: "hidden", margin: 0, padding: 0 }}
      >
        {children}
      </body>
    </html>
  );
}
