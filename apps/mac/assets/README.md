# Mac artwork

The owner supplied `Hearable-macOS-icon-1024.png` and
`Minimal Cream Headphone Mascot.png` on 2026-10-29.

- `app-icon.png` adapts the supplied app artwork to a full-bleed, opaque 1024 px
  square. The dark background reaches every edge; the supplied white surround,
  exterior shadow and pre-rounded tile boundary are removed. macOS applies the
  final icon shape. Copying the original image unchanged produced a nested icon.
- `Hearable.icns` contains the standard macOS icon sizes generated from it.
- `tray-mascot.png` is the transparent monochrome extraction of the supplied mascot.
- `tray-waiting-mascot.png` adds the waiting status dot to that extraction.
- `trayTemplate.png` / `trayTemplate@2x.png` and their waiting counterparts are the
  18 px / 36 px runtime representations. Electron marks them as template images;
  macOS supplies their displayed colour. Both variants use the same centered crop
  to make the mascot larger while retaining the waiting dot. Transparent eye holes
  and gaps stay open.

The built-in imagegen tool adapted the app background and produced the two transparent
source masks with the prompts below. Apple's `sips` resized the images; `sips` and
`iconutil` generated the ICNS.
These are build-time assets with no new application dependency. The web console's
existing favicon is separate from the Mac shell artwork.

The app background follows [Apple's icon guidance](https://developer.apple.com/design/human-interface-guidelines/app-icons/):
provide a full-bleed opaque background and let the system apply the rounded corners.

To resize the tray sources from the repository root:

```sh
tray_crop=$(mktemp -d)
sips --cropToHeightWidth 1100 1100 apps/mac/assets/tray-mascot.png --out "$tray_crop/normal.png"
sips --cropToHeightWidth 1100 1100 apps/mac/assets/tray-waiting-mascot.png --out "$tray_crop/waiting.png"
sips -z 18 18 "$tray_crop/normal.png" --out apps/mac/assets/trayTemplate.png
sips -z 36 36 "$tray_crop/normal.png" --out apps/mac/assets/trayTemplate@2x.png
sips -z 18 18 "$tray_crop/waiting.png" --out apps/mac/assets/trayWaitingTemplate.png
sips -z 36 36 "$tray_crop/waiting.png" --out apps/mac/assets/trayWaitingTemplate@2x.png
```

To regenerate the app icon:

```sh
iconset=$(mktemp -d)/Hearable.iconset
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" apps/mac/assets/app-icon.png --out "$iconset/icon_${size}x${size}.png"
  double=$((size * 2))
  sips -z "$double" "$double" apps/mac/assets/app-icon.png --out "$iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$iconset" -o apps/mac/assets/Hearable.icns
```

## App background correction prompt

```text
Use case: precise-object-edit
Asset type: production macOS application icon source, flat opaque 1024 by 1024 square PNG.
Edit target: supplied cream headphone mascot centered on a black rounded square tile, currently pictured on a white outer background.
Primary request: remove the icon-within-an-icon presentation. Extend the existing nearly black charcoal tile background seamlessly to every edge and all four corners of the entire square canvas. There must be no white margin, no padding, no outside backdrop, no rounded-square tile boundary, no pre-rounded corners, no white border, and no cast shadow around a tile. The output is one flat, full-bleed dark square containing the cream headphone mascot, ready for macOS itself to mask into its icon shape. Preserve the cream mascot itself exactly: same centered position, size, face, eyes, separate ear cups and headphone arc, cream material and subtle lighting. Only replace the outer white surround, tile silhouette and exterior shadow with a seamless continuation of the tile's own dark background. Keep the subtle charcoal lighting across the flat background, but no visible frame. Do not add any new shapes, text, watermark, border, bevel, or second icon. All canvas pixels, including corners, are opaque and nearly black except for the centered existing mascot. Output square 1024 by 1024.
```

## Extraction prompt

```text
Use case: background-extraction
Asset type: macOS menu bar template icon, production logo mask
Input image: edit target, the supplied Hearable cream headphone mascot.
Primary request: extract precisely the cream/white shapes of this mascot as solid black shapes on a genuinely transparent background. Preserve the original silhouette, proportions, round face, overhead headphone arc, separate inner ear pads and outer ear cups, and two vertical rounded eye holes. Convert the cream shapes to opaque pure black, and make the entire dark background, dark outlines, glow, shadows, and dark eyes genuinely transparent. Keep the head, arc, and ear cups separated by transparent gaps. No new artwork, no text, no gradients, no shadow, no border, no redesign. Center the entire complete mascot with small even transparent padding on a square canvas. The intended final use is 18-pixel macOS menu bar image, so edges must be crisp and the two eye holes open. Output transparent PNG.
```

## Waiting variant prompt

```text
Use case: precise-object-edit
Asset type: waiting variant of the exact supplied macOS menu bar logo mask.
Edit target: the supplied black headphone mascot on a transparent 1254 by 1254 square canvas.
Change only this: add one small solid black circular status dot centered near (1050, 190) with radius 85 pixels, in the transparent space above the right ear cup and just to the right of the headphone arc. Keep a clean transparent gap between dot and arc. Preserve every existing pixel of the mascot, its scale, position, eye holes, arc and ear cups. Keep the same square canvas and genuinely transparent background. No other change, no glow, no gradients, no shadow, no text.
```
