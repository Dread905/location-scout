/// <reference lib="webworker" />
/** Building shadow union/difference off the main thread (polyclip on hundreds of hulls takes 100s of ms). */
import { buildingShadows, type Footprint } from './shadows.js';

export type ShadowJob = { id: number; features: Footprint[]; az: number; alt: number };

self.onmessage = (e: MessageEvent<ShadowJob>) => {
  const { id, features, az, alt } = e.data;
  (self as unknown as Worker).postMessage({ id, fc: buildingShadows(features, az, alt) });
};
