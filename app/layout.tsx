import type { Metadata, Viewport } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";

/**
 * Archivo, with its width axis loaded.
 *
 * Chosen because it comes out of signage and industrial lettering, which is
 * what the till is: a figure read across a counter, at an angle, by someone
 * whose hands are full. The width axis does real work here — the readouts are
 * set wide the way a weighing machine sets its digits, so the total and the
 * body text are one family rather than two.
 *
 * next/font downloads the file at build time and serves it from our own origin,
 * so a till with no network still renders in the right face.
 */
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
  variable: "--font-archivo",
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
});

export const metadata: Metadata = {
  title: "Newmark POS",
  description: "Point of sale for Newmark Butchery, Bishan Plaza, Westlands, Nairobi",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The till is a fixed-size touch surface. Pinch-zooming it mid-sale moves the
  // payment buttons out from under the cashier's thumb.
  maximumScale: 1,
  userScalable: false,
  themeColor: "#0f1417",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-KE" className={archivo.variable}>
      <body className="bg-char-950 text-char-100">{children}</body>
    </html>
  );
}
