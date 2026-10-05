"use server";

/**
 * Host listing actions.
 *
 * The editor posts plain FormData and every write goes through `updateListing`,
 * which drops any column a host is not allowed to set. Photos go straight into
 * R2 from the action, after the same ownership check as every other write.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { requireHost } from "@/lib/auth";
import { getPhotos } from "@/lib/cf";
import {
  addPhoto,
  createListingDraft,
  getOwnedListing,
  removePhoto,
  setCoverPhoto,
  setListingStatus,
  updateListing,
  type ListingPatch,
} from "@/lib/db/listings";
import { coerceLocale, localeHref } from "@/lib/i18n/config";
import type { MessageKey } from "@/lib/i18n/messages";
import { MAX_PHOTO_BYTES, detectPhotoType, newObjectName } from "@/lib/photos";
import type { ListingStatus } from "@/lib/types";
import { AMENITY_MAP, PROPERTY_TYPE_MAP } from "@/lib/taxonomy";
import { boolField, field, isValidDate } from "@/lib/utils";

/** Parses a numeric field, keeping valid zeros and rejecting NaN/Infinity. */
function numberField(
  form: FormData,
  key: string,
  fallback: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = field(form, key);
  const value = Number(raw);
  if (!raw || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Opens a fresh draft and drops the host into the editor. */
export async function createListingAction(form: FormData): Promise<void> {
  const locale = coerceLocale(field(form, "locale"));
  const user = await requireHost(locale, field(form, "returnTo") || undefined);
  const id = await createListingDraft(user.id, field(form, "title") || "Untitled listing");
  revalidatePath("/[locale]/host", "page");
  redirect(localeHref(locale, `/host/listing/${id}`));
}

/** Persists the editor form; junk numbers fall back to sane defaults. */
export async function saveListingAction(form: FormData): Promise<void> {
  const locale = coerceLocale(field(form, "locale"));
  const user = await requireHost(locale, "/host");

  const id = field(form, "listingId");
  const amenities = form
    .getAll("amenities")
    .filter((value): value is string => typeof value === "string" && Object.hasOwn(AMENITY_MAP, value));
  const propertyType = field(form, "propertyType");
  const availableFrom = field(form, "availableFrom");

  const patch: ListingPatch = {
    title_en: field(form, "titleEn"),
    title_am: field(form, "titleAm") || null,
    summary_en: field(form, "summaryEn") || null,
    summary_am: field(form, "summaryAm") || null,
    description_en: field(form, "descriptionEn") || null,
    description_am: field(form, "descriptionAm") || null,
    house_rules_en: field(form, "houseRulesEn") || null,
    house_rules_am: field(form, "houseRulesAm") || null,
    property_type: Object.hasOwn(PROPERTY_TYPE_MAP, propertyType) ? propertyType : "apartment",
    rental_type: field(form, "rentalType") === "nightly" ? "nightly" : "monthly",
    price: numberField(form, "price", 0),
    deposit_months: numberField(form, "depositMonths", 0),
    bedrooms: Math.floor(numberField(form, "bedrooms", 1)),
    beds: Math.floor(numberField(form, "beds", 1)),
    bathrooms: numberField(form, "bathrooms", 1),
    max_guests: Math.floor(numberField(form, "maxGuests", 2, 1)),
    area_sqm: numberField(form, "areaSqm", 0) || null,
    furnished: ["furnished", "semi", "unfurnished"].includes(field(form, "furnished"))
      ? field(form, "furnished")
      : "unfurnished",
    amenities: JSON.stringify(amenities),
    city: field(form, "city") || "Addis Ababa",
    subcity: field(form, "subcity") || null,
    neighborhood: field(form, "neighborhood") || null,
    address_line: field(form, "addressLine") || null,
    lat: numberField(form, "lat", 9.0108, -90, 90),
    lng: numberField(form, "lng", 38.7613, -180, 180),
    min_stay_months: Math.floor(numberField(form, "minStayMonths", 1, 1)),
    min_nights: Math.floor(numberField(form, "minNights", 1, 1)),
    available_from: availableFrom && isValidDate(availableFrom) ? availableFrom : null,
    instant_book: boolField(form, "instantBook") ? 1 : 0,
  };

  const updated = await updateListing(id, user.id, patch);
  if (!updated) redirect(`${localeHref(locale, "/host")}?error=not_allowed`);
  revalidatePath("/[locale]/host", "page");
  revalidatePath("/[locale]/listing/[id]", "page");
  redirect(`${localeHref(locale, `/host/listing/${id}`)}?saved=1`);
}

/** Publish, pause or unpublish. */
export async function setListingStatusAction(
  listingId: string,
  status: ListingStatus,
): Promise<{ ok: boolean; error?: MessageKey }> {
  const user = await requireHost("en", "/host");
  const updated = await setListingStatus(listingId, user.id, status);
  if (!updated) return { ok: false, error: "error.notAllowed" };

  revalidatePath("/[locale]/host", "page");
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Uploads one photo into R2 and appends it to the gallery. */
export async function addListingPhotoAction(form: FormData): Promise<void> {
  const locale = coerceLocale(field(form, "locale"));
  const user = await requireHost(locale, "/host");

  const listingId = field(form, "listingId");
  const file = form.get("photo");
  if (!listingId || !(file instanceof File) || file.size === 0) {
    redirect(`${localeHref(locale, `/host/listing/${listingId}`)}?photo=missing`);
  }
  if (file.size > MAX_PHOTO_BYTES) {
    redirect(`${localeHref(locale, `/host/listing/${listingId}`)}?photo=too_big`);
  }

  // Ownership gate: without this, any host could attach photos to any listing.
  const owned = await getOwnedListing(listingId, user.id);
  if (!owned) {
    redirect(`${localeHref(locale, "/host")}?error=not_allowed`);
  }

  const bytes = await file.arrayBuffer();
  const format = detectPhotoType(new Uint8Array(bytes));
  if (!format) throw new Error("Only JPEG, PNG, GIF and WebP photos are supported.");

  const bucket = await getPhotos();
  const name = newObjectName("listing", user.id, `photo.${format.extension}`);
  await bucket.put(name, bytes, {
    httpMetadata: { contentType: format.contentType },
  });

  try {
    await addPhoto(listingId, `r2:${name}`, null, null);
  } catch (error) {
    await bucket.delete(name).catch(() => undefined);
    throw error;
  }
  revalidatePath("/[locale]/host/listing/[id]", "page");
  revalidatePath("/[locale]/listing/[id]", "page");
}

/** Removes a gallery photo row and its object. */
export async function removeListingPhotoAction(form: FormData): Promise<void> {
  const locale = coerceLocale(field(form, "locale"));
  const user = await requireHost(locale, "/host");

  const listingId = field(form, "listingId");
  const photoId = field(form, "photoId");

  // Same ownership gate as the upload path. The deleted row, not the form,
  // determines which storage object this host is allowed to remove.
  const owned = await getOwnedListing(listingId, user.id);
  if (!owned) return;

  const key = await removePhoto(photoId, listingId);
  if (key?.startsWith("r2:")) {
    try {
      const bucket = await getPhotos();
      await bucket.delete(key.slice(3));
    } catch {
      // The row is gone; a stranded object is a cleanup job, not an error.
    }
  }
  revalidatePath("/[locale]/host/listing/[id]", "page");
}

/** Promotes a photo to cover; placeholder seeds are rejected up front. */
export async function setCoverPhotoAction(form: FormData): Promise<void> {
  const locale = coerceLocale(field(form, "locale"));
  const user = await requireHost(locale, "/host");

  const listingId = field(form, "listingId");
  const owned = await getOwnedListing(listingId, user.id);
  if (!owned) return;

  await setCoverPhoto(listingId, field(form, "photoId"));
  revalidatePath("/[locale]/host/listing/[id]", "page");
}


