import type { Metadata } from "next";
import { StageBackground } from "@/components/StageBackground";
import "./globals.css";

export const metadata: Metadata = {
  title: "RiffRush — realtime music quiz",
  description:
    "Host a live music quiz: short clips, longer extends, and realtime guesses.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <StageBackground />
        <div className="app-foreground">{children}</div>
      </body>
    </html>
  );
}
