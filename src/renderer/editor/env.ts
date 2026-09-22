// State shared by the editor modules: the image being edited and the display scale.
export const env = {
  img: null as unknown as HTMLImageElement,
  imgW: 0,
  imgH: 0,
  /** Capture scale factor (2 on a 200% display); default annotation sizes are multiplied by it. */
  unit: 1,
  /** CSS pixels per canvas pixel, set by the editor as it lays out the canvas. */
  viewScale: () => 1,
};
