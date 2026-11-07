// packages/audio/src/vite-assets.d.ts — type surface for bundler-resolved
// asset URL imports (`?url`). What this is for: letting tsc build the QA
// render, which imports the nature-bed WAV through Vite's `?url` loader.
// What it must not do: change runtime behaviour — a declaration only.

declare module "*.wav?url" {
  const url: string;
  export default url;
}
