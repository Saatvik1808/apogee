/**
 * LEARNING NOTE: Web Workers keep the frame rate smooth
 *
 * Generating a terrain patch evaluates the height function ~1,200 times with
 * dozens of noise octaves each — several milliseconds of CPU. Doing that on the
 * main thread during a landing would stutter the game. A Web Worker is a separate
 * JavaScript thread: we post it a patch request, it builds the vertex arrays and
 * posts them back as *transferable* buffers (moved, not copied).
 *
 * Key concepts: multithreading in the browser, message passing, transferables
 */
/// <reference lib="webworker" />
import { buildPatch, type PatchRequest } from './PatchBuilder';
import { loadTerrains, type FlatSiteSpec, type TerrainSet, type TerrainUrls } from '../../world/Terrain';

interface InitMsg {
  type: 'init';
  urls: TerrainUrls;
  radii: { earth: number; moon: number; mars: number };
  sites: FlatSiteSpec[];
}
interface BuildMsg {
  type: 'build';
  req: PatchRequest;
}

let terrains: TerrainSet | null = null;
const queue: PatchRequest[] = [];
let busy = false;

function drain(): void {
  if (!terrains || busy) return;
  busy = true;
  while (queue.length) {
    const req = queue.shift()!;
    const t = terrains[req.body as keyof TerrainSet];
    if (!t) continue;
    const res = buildPatch(req, (d, wl) => t.heightAtLod(d, wl), t.hasOcean, (d, wl, out) => t.macroAt(d, wl, out));
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: 'patch', res }, [
      res.positions.buffer,
      res.normals.buffer,
      res.dirs.buffer,
      res.heights.buffer,
      res.detail.buffer,
      res.macro.buffer,
    ]);
  }
  busy = false;
}

self.onmessage = async (e: MessageEvent<InitMsg | BuildMsg | { type: 'cancel'; ids: number[] }>) => {
  const m = e.data;
  if (m.type === 'init') {
    terrains = await loadTerrains(m.urls, m.radii, m.sites);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage({ type: 'ready' });
    drain();
  } else if (m.type === 'build') {
    queue.push(m.req);
    drain();
  } else if (m.type === 'cancel') {
    const ids = new Set(m.ids);
    for (let i = queue.length - 1; i >= 0; i--) if (ids.has(queue[i]!.id)) queue.splice(i, 1);
  }
};
