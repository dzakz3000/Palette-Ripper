# Palette-Ripper
Pull a working color palette out of any image. Palette Ripper is a browser-based color extraction tool: upload an image, get its dominant colors, click anywhere to sample an exact pixel, and see how your palette looks in a live UI preview.  Everything runs in your browser. Images are never uploaded to a server.

Features
Image upload: drag and drop, click to browse, or paste an image from the clipboard. Supports PNG, JPEG, WebP, GIF, BMP and AVIF up to 25 MB, with clear error messages for unsupported or unreadable files.
Dominant color extraction: a real median-cut quantization of the image's pixel data, returning 2 to 12 colors. Change the count with the slider and the palette updates.
Exact pixel picker: click or tap any point on the image to read that pixel's HEX, RGB and HSL values. A marker shows the sampled position, and arrow keys move the sample point for keyboard users.
Palette management: copy HEX or RGB with one click, add picked colors to the palette, remove or reorder colors, and reset to the extracted palette. Duplicates are blocked, and each color is tagged as extracted or picked.
Live preview: assign palette colors to Background, Surface, Primary, Secondary, Accent and Text, and watch a website layout, a set of color cards, or a typography specimen update instantly. WCAG contrast ratios are shown for key color pairs, and button label colors are chosen automatically so they stay readable.
Export: download the current palette as a .txt list of HEX codes, a .json file with full color data, or a .css file of custom properties. Filenames come from your image name, for example sunset-palette.json.
Light and dark theme, responsive layout for desktop, tablet and mobile, and reduced-motion support.
How it works

Color extraction

The image is drawn onto a canvas and downsampled to 256 px on its longest side, so large photos stay fast.
Pixels are read with getImageData(). Mostly transparent pixels are ignored so they cannot skew the result.
Colors are counted in a histogram, then split with median-cut quantization into candidate colors.
Candidates are filtered by perceptual difference (CIE Lab distance), so near-identical shades are not returned when better alternatives exist.

Accurate picking

The canvas keeps the image's full resolution (up to 4096 px on the longest side), while CSS only scales how it is displayed. A coordinate-mapping function converts a click position into a bitmap pixel, accounting for CSS scaling, borders, padding and object-fit: contain. The same math is used in reverse to place the marker, so it stays on the right pixel when the layout resizes.
