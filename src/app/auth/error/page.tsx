import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { StatePanel } from "@/components/state-panel";
import { buttonClasses } from "@/lib/ui";

/**
 * Auth.js sends every sign-in failure here (see `pages.error` in auth.ts).
 * The one users actually hit is OAuthAccountNotLinked: a workspace already
 * exists for this account's email address but was created with a different
 * GitHub login, so Auth.js refuses to hand the existing workspace over.
 * Switching accounts is where someone runs into it.
 */
const MESSAGES: Record<string, { title: string; description: string }> = {
  OAuthAccountNotLinked: {
    title: "That GitHub account can't sign in here",
    description:
      "A workspace already exists for this account's email address, created with a different GitHub login. Sign in with that original login instead.",
  },
  AccessDenied: {
    title: "GitHub authorization was declined",
    description: "Nothing was connected. You can start the flow again whenever you're ready.",
  },
  Configuration: {
    title: "Sign-in isn't configured correctly",
    description: "The GitHub OAuth credentials for this deployment are missing or invalid.",
  },
};

const FALLBACK = {
  title: "Couldn't complete sign-in",
  description: "Something went wrong talking to GitHub. Try again — nothing was changed.",
};

export default async function AuthErrorPage(props: PageProps<"/auth/error">) {
  const searchParams = await props.searchParams;
  const code = typeof searchParams.error === "string" ? searchParams.error : "";
  const { title, description } = MESSAGES[code] ?? FALLBACK;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-10 sm:px-8">
      <StatePanel
        icon={<AlertTriangle className="h-5 w-5 text-danger" aria-hidden="true" />}
        title={title}
        description={description}
        action={
          <Link href="/dashboard" className={buttonClasses("primary")}>
            Back to dashboard
          </Link>
        }
      />
    </div>
  );
}
