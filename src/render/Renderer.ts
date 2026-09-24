/**
 * LEARNING NOTE: Renderer setup for a planet-sized world
 *
 * Three.js normally assumes a scene a few hundred metres across. We need 5 cm to
 * 10^12 m in one frame, so we:
 *   • use a REVERSED-Z floating-point depth buffer: depth 1 at the near plane,
 *     0 at infinity. Floats are dense near 0, which exactly cancels the 1/z
 *     distribution of perspective depth, giving ~7 significant digits at every
 *     distance. Unlike a logarithmic depth buffer (which must write gl_FragDepth
 *     from the pixel shader) it keeps the GPU's EARLY-Z test working, so hidden
 *     pixels are rejected before their expensive shader runs. Browsers without
 *     EXT_clip_control fall back to the logarithmic buffer.
 *   • keep the camera at the ORIGIN and move the world around it ("floating
 *     origin"), so everything near the camera has small, precise coordinates
 *   • render into HDR (half-float) targets and post-process to the screen.
 *
 * Key concepts: reversed-Z, early depth testing, logarithmic depth, floating
 * origin, device pixel ratio, render resolution scaling
 */
import { PerspectiveCamera, WebGLRenderer } from 'three';
import { CAMERA_FAR, CAMERA_NEAR } from '../core/constants';

function supportsClipControl(): boolean {
  try {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl2');
    const ok = !!g?.getExtension('EXT_clip_control');
    g?.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch {
    return false;
  }
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: WebGLRenderer;
  readonly camera: PerspectiveCamera;
  /** true: reversed-Z float depth; false: logarithmic depth (fallback). */
  readonly reversedDepth: boolean;
  pixelRatio = 1;
  /** Shadow-map resolution chosen by the quality preset. */
  shadowSize = 2048;
  shadowsEnabled = true;
  resolutionScale = 1;
  width = 1;
  height = 1;
  private readonly onResizeCbs: Array<(w: number, h: number) => void> = [];

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas';
    container.appendChild(this.canvas);
    const wantReversed = supportsClipControl() && new URLSearchParams(location.search).get('depth') !== 'log';
    const make = (reversed: boolean) =>
      new WebGLRenderer({
        canvas: this.canvas,
        antialias: false,
        alpha: false,
        depth: true,
        stencil: false,
        logarithmicDepthBuffer: !reversed,
        reversedDepthBuffer: reversed,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: false,
      });
    let gl = make(wantReversed);
    if (wantReversed && !gl.capabilities.reversedDepthBuffer) {
      gl.dispose();
      gl = make(false);
    }
    this.gl = gl;
    this.reversedDepth = gl.capabilities.reversedDepthBuffer && wantReversed;
    this.gl.autoClear = false;
    this.gl.setClearColor(0x000000, 1);
    this.camera = new PerspectiveCamera(60, 1, CAMERA_NEAR, CAMERA_FAR);
    this.camera.position.set(0, 0, 0);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get maxTextureSize(): number {
    return this.gl.capabilities.maxTextureSize;
  }

  onResize(cb: (w: number, h: number) => void): void {
    this.onResizeCbs.push(cb);
    cb(this.width * this.pixelRatio, this.height * this.pixelRatio);
  }

  setResolutionScale(s: number): void {
    this.resolutionScale = s;
    this.resize();
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.width = w;
    this.height = h;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2) * this.resolutionScale;
    this.gl.setPixelRatio(this.pixelRatio);
    this.gl.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const cb of this.onResizeCbs) cb(w * this.pixelRatio, h * this.pixelRatio);
  }
}
