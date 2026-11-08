# Serenity Place Residences

*Pristine Living. Peaceful Stays. · Ìtura àti Àlàáfíà.*

The website for Serenity Place Residences: rooms, rates and online booking.

## What's here

- `index.html` is the whole website in one file, with the logo built in.
- `assets/logo.png` is the original logo.
- `assets/photos/` is where the real room photos will go.

## Updating content

All business details sit in the `CONFIG` block near the bottom of `index.html`:
room names, prices, availability, amenities, FAQs, contact details, location and photos.

To add a photo, put the image in `assets/photos/` and set its path in `CONFIG.photos`,
e.g. `dorm8: "assets/photos/dorm8.jpg"`. Any photo left as `null` shows a branded placeholder.

## Status

- Version 1 has placeholder photos and prices, because the building is still under construction.
- Payment is in preview mode. Live payments (Paystack or Flutterwave) come in the next phase.

## Previewing online

Turn on GitHub Pages under **Settings → Pages → Deploy from branch → main / (root)**.

## Hosting on GoDaddy Node.js Hosting

The repo includes `package.json` and a small `server.js` (no dependencies) so GoDaddy can run it.
In GoDaddy Node.js Hosting choose **Connect GitHub**, pick this repository and the `main` branch, then **Import & Deploy**.
To test locally: `npm start`, then open http://localhost:3000.
