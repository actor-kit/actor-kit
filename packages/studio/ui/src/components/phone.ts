/**
 * Phone-width rules shared by every Studio page (below Tailwind's `sm`, 640px). Desktop is untouched.
 *
 * - TAP: controls are at least 40px tall, so thumbs can hit them.
 * - SCROLL_X: a wide table or tab bar scrolls inside its own box instead of pushing the page sideways.
 */
export const TAP = "max-sm:min-h-10";
export const SCROLL_X = "overflow-x-auto";
