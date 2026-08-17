import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { buttonClasses } from "@/lib/ui";
import { StatePanel } from "@/components/state-panel";

export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col">
      <StatePanel
        icon={<FileQuestion className="h-5 w-5" aria-hidden="true" />}
        title="Page not found"
        description="The page you're looking for doesn't exist or may have moved."
        action={
          <Link href="/" className={buttonClasses("secondary")}>
            Back to home
          </Link>
        }
      />
    </div>
  );
}
