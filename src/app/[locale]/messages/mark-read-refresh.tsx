"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * The layout counts unread messages for the header and tab-bar badges, but it
 * renders in parallel with the page (and is not re-rendered on soft navigation),
 * so it can read the count before the page marks the thread as read. One
 * refresh after opening an unread thread brings the badges in line. The page
 * only renders this while the thread was unread, so it never loops.
 */
export function MarkReadRefresh({ conversationId }: { conversationId: string }) {
  const router = useRouter();

  useEffect(() => {
    router.refresh();
  }, [router, conversationId]);

  return null;
}
