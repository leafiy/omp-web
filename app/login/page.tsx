import { I18nProvider } from "@/hooks/useI18n";
import { LoginForm } from "@/components/LoginForm";

export const metadata = { title: "OMP Web" };

export default function LoginPage() {
  return (
    <I18nProvider>
      <LoginForm />
    </I18nProvider>
  );
}
