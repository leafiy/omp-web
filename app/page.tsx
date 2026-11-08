import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { WebAuthGuard } from "@/components/WebAuthGuard";
import { I18nProvider } from "@/hooks/useI18n";

export default function Home() {
  return (
    <Suspense>
      <I18nProvider>
        <WebAuthGuard />
        <AppShell />
      </I18nProvider>
    </Suspense>
  );
}
