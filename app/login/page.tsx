import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getSettings } from "@/lib/settings";
import { LoginPad } from "./LoginPad";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  const settings = await getSettings();
  const terminalId = process.env.TERMINAL_ID ?? "T1";

  return (
    <main className="flex min-h-screen items-center justify-center bg-char-950 p-6">
      {/*
        The masthead is the shop's name at the size it would be painted above
        the counter, not a logo tile with an initial in it. Wide-cut Archivo,
        because that is how shop fascias are lettered.
      */}
      <div className="w-full max-w-sm">
        <div className="mb-7">
          <h1 className="wide text-[2.6rem] font-bold leading-[0.92] tracking-tight text-bone">
            Newmark
          </h1>
          <p className="wide mt-0.5 text-[2.6rem] font-light leading-[0.92] tracking-tight text-char-500">
            Butchery
          </p>
          <p className="mt-4 border-t border-char-800 pt-3 text-sm text-char-400">
            {settings.tagline}
          </p>
        </div>

        <LoginPad terminalId={terminalId} />
      </div>
    </main>
  );
}
