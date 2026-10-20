import type { Metadata } from "next";
import "./globals.css";
import "@/components/capacity/spread-theme.css";

export const metadata: Metadata = {
  title: "Capacity Manager — Gestão de Capacidade Operacional",
  description: "Conecte pessoas, demandas e disponibilidade. Planeje a capacidade operacional com confiança.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className="antialiased">{children}</body>
    </html>
  );
}
