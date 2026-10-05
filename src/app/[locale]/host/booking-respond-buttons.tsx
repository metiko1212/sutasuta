"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { respondBookingAction } from "@/actions/bookings";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/overlay";
import { useI18n } from "@/lib/i18n/client";

type Decision = "confirmed" | "declined";

/** Accept / decline controls for one pending request. */
export function BookingRespondButtons({ bookingId }: { bookingId: string }) {
  const { t, locale } = useI18n();
  const [declineOpen, setDeclineOpen] = useState(false);
  const [note, setNote] = useState("");
  const [decision, setDecision] = useState<Decision | null>(null);
  const [isPending, startTransition] = useTransition();

  const respond = (next: Decision) => {
    if (isPending) return;
    setDecision(next);
    // The note is the reason for declining; it must not ride along on an accept
    // just because the host typed one and then backed out of the dialog.
    const hostNote = next === "declined" ? note.trim() || undefined : undefined;

    startTransition(async () => {
      try {
        const res = await respondBookingAction(bookingId, next, hostNote, locale);
        if (res.ok) {
          setDeclineOpen(false);
          toast.success(
            next === "confirmed" ? t("booking.status.confirmed") : t("booking.status.declined"),
          );
        } else {
          toast.error(t(res.error ?? "error.generic"));
        }
      } catch {
        toast.error(t("error.generic"));
      }
    });
  };

  return (
    <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
      <Button
        size="sm"
        onClick={() => respond("confirmed")}
        loading={isPending && decision === "confirmed"}
        disabled={isPending}
      >
        {t("booking.accept")}
      </Button>

      <Dialog open={declineOpen} onOpenChange={(next) => (isPending ? undefined : setDeclineOpen(next))}>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline" disabled={isPending}>
            {t("booking.decline")}
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("booking.declineConfirm")}</DialogTitle>
            <DialogDescription>{t("booking.declineBody")}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t("booking.hostNote")}
            maxLength={1000}
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeclineOpen(false)} disabled={isPending}>
              {t("common.back")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => respond("declined")}
              loading={isPending && decision === "declined"}
              disabled={isPending}
            >
              {t("booking.decline")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
