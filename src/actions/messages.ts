"use server";

/**
 * Messaging actions.
 *
 * Threads are keyed by guest–host–listing, so "Message host" from the same
 * listing twice always lands in the same conversation. After sending, the
 * guest is dropped into the thread itself.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireUser } from "@/lib/auth";
import { getDB } from "@/lib/cf";
import { sendMessage, startThread } from "@/lib/db/conversations";
import { coerceLocale } from "@/lib/i18n/config";
import { localeHref } from "@/lib/i18n/config";
import type { MessageKey } from "@/lib/i18n/messages";
import type { Locale } from "@/lib/types";
import { field } from "@/lib/utils";

export type MessageResult = { ok: true } | { ok: false; error: MessageKey };

/** First message on a listing — opens the thread if needed, then redirects. */
export async function startThreadAction(form: FormData): Promise<void> {
  const locale: Locale = coerceLocale(field(form, "locale"));
  const user = await requireUser(locale, field(form, "returnTo") || undefined);

  const listingId = field(form, "listingId");
  const body = field(form, "body");

  // The recipient comes from the listing row, never from a form field, so a
  // tampered hostId cannot attach a listing to some other user's inbox.
  const db = await getDB();
  const listing = listingId
    ? await db
        .prepare("SELECT host_id FROM listings WHERE id = ? AND status = 'published'")
        .bind(listingId)
        .first<{ host_id: string }>()
    : null;
  if (!listing) redirect(`${localeHref(locale, "/messages")}?message=not_allowed`);
  const hostId = listing.host_id;

  const outcome = await startThread({
    guestId: user.id,
    hostId,
    listingId,
    senderId: user.id,
    body,
  });

  if (!outcome.ok) {
    redirect(
      `${localeHref(locale, `/listing/${listingId ?? ""}`)}?message=${outcome.reason === "empty" ? "empty" : "not_allowed"}`,
    );
  }

  revalidatePath("/[locale]/messages", "page");
  redirect(`${localeHref(locale, "/messages")}?c=${outcome.conversationId}`);
}

/** A reply inside an open thread. The client clears the box on ok. */
export async function sendMessageAction(
  conversationId: string,
  body: string,
): Promise<MessageResult> {
  const user = await requireUser("en", "/messages");

  const outcome = await sendMessage({ conversationId, senderId: user.id, body });
  if (!outcome.ok) {
    return { ok: false, error: outcome.reason === "empty" ? "error.messageEmpty" : "error.notAllowed" };
  }

  revalidatePath("/[locale]/messages", "page");
  return { ok: true };
}
