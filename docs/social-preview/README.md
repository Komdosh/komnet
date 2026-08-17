# Social preview

The card GitHub serves as `og:image` — what a link to this repository looks like
when it is pasted into Slack, X, Discord or Hacker News. Without one, GitHub
generates a default from the avatar and description.

Rebuild after editing the HTML:

```console
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1280,640 \
  --screenshot=docs/social-preview/social-preview.png \
  "file://$PWD/docs/social-preview/social-preview.html"
```

1280×640 is GitHub's own size. `--force-device-scale-factor=1` matters: without
it a retina machine renders 2560×1280 and the upload is rejected.

Uploading is manual — GitHub exposes no API for it. Settings → General → Social
preview.

## Why it looks like this

It gets scaled to roughly 600px wide in a card, so it is built for that size
rather than for the full-resolution version nobody sees: few elements, nothing
below 24px, no thin weights. An ASCII diagram of the two-machine topology was
tried first and turned to mush at half scale — the file is deliberately plainer
than the README it advertises.
