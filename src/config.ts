// The one CTA. It now points at an embedded scheduler on the page (#book)
// as soon as BOOKING_LINK is filled in. Until then every CTA falls back to email.
//
// To go live, set BOOKING_PROVIDER and BOOKING_LINK:
//
//   Cal.com   BOOKING_PROVIDER = "cal"
//             BOOKING_LINK     = "<user>/<event>"   e.g. "njyn/30min"
//
//   Calendly  BOOKING_PROVIDER = "calendly"
//             BOOKING_LINK     = "<user>/<event>"   e.g. "njyn/30min"
//                                (or the full https://calendly.com/... URL)
//
// Nothing else needs to change: the embed, the nav button, the hero, the demo
// strip and the final CTA all read from here.
export type BookingProvider = "cal" | "calendly";

export const BOOKING_PROVIDER: BookingProvider = "cal";
export const BOOKING_LINK = "";

export const BOOKING_LABEL = "Book a call";
export const BOOKING_EMAIL_URL = "mailto:hello@njyn.ai?subject=Book%20a%20call";

/** Height of the inline scheduler, in px. Cal/Calendly both need a fixed box. */
export const BOOKING_EMBED_HEIGHT = 720;

/** True once a real scheduler link is configured above. */
export const BOOKING_ENABLED = BOOKING_LINK.trim() !== "";

/** Where every CTA on the site points. */
export const BOOKING_URL = BOOKING_ENABLED ? "#book" : BOOKING_EMAIL_URL;
