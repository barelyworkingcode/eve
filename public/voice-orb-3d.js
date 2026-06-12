/**
 * VoiceOrb3D — audio-reactive 3D orb rendered with Three.js (WebGL).
 * Noise-displaced icosphere with animated interior energy swirls, fresnel rim
 * lighting, a wireframe shell, a soft halo, and a faint drifting particle
 * field. Normal (non-additive) blending throughout so it reads on the light
 * Apple theme as well as dark backgrounds.
 * Same interface as VoiceOrbCanvas: constructor(canvas, app), start(), stop(),
 * setState(state), plus destroy() for full GL teardown.
 * States: idle, listening, processing, speaking.
 */

// ── GLSL noise (Ashima / webgl-noise 3D simplex, MIT) ──────────────────────

const SIMPLEX_NOISE_GLSL = `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

// ── Shaders ─────────────────────────────────────────────────────────────────

const ORB_VERT = `
uniform float uTime;
uniform float uAudio;
uniform float uNoiseAmp;
uniform float uNoiseSpeed;
uniform vec3 uTouch;
varying float vDisp;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vPos;
${SIMPLEX_NOISE_GLSL}
void main() {
  float n  = snoise(normal * 1.8 + uTime * uNoiseSpeed);
  float n2 = snoise(normal * 4.5 - uTime * uNoiseSpeed * 1.7);
  float disp = uNoiseAmp * n + uAudio * 0.18 * n2;
  vec3 touchDir = normalize(vec3(uTouch.xy * 1.2, 1.0));
  float td = smoothstep(0.55, 1.0, dot(normalize(position), touchDir));
  disp += td * uTouch.z * 0.25;
  vec3 displaced = position + normal * disp;
  vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
  vDisp = disp;
  vNormal = normalize(normalMatrix * normal);
  vView = -mvPosition.xyz;
  vPos = position;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const ORB_FRAG = `
uniform vec3 uColor;
uniform float uAudio;
uniform float uGlow;
uniform float uTime;
varying float vDisp;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vPos;
${SIMPLEX_NOISE_GLSL}
void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vView);
  float ndv = abs(dot(N, V));
  float fresnel = pow(1.0 - ndv, 2.5);

  // Deep, near-dark body with a static view-space key light (upper left) —
  // the glow elements below read crisply against it
  float lightDot = dot(N, normalize(vec3(-0.5, 0.35, 0.8)));
  vec3 deep = uColor * 0.14;
  vec3 mid  = uColor * 0.34;
  vec3 body = mix(deep, mid, 0.5 + 0.5 * lightDot);

  // Sharp plasma filaments: ridges where drifting noise crosses zero form
  // thin closed curves sweeping over the sphere. Voice lights them up.
  float n1 = snoise(vPos * 1.0 + vec3(0.0, uTime * 0.10, uTime * 0.07));
  float n2 = snoise(vPos * 2.1 - vec3(uTime * 0.14, 0.0, uTime * 0.09));
  float fil1 = pow(max(0.0, 1.0 - abs(n1) * 2.8), 7.0);
  float fil2 = pow(max(0.0, 1.0 - abs(n2) * 3.0), 9.0);
  float filaments = (fil1 * 0.9 + fil2 * 0.35) * (0.55 + uAudio * 1.6);

  // Crisp ring just inside the silhouette, plus the bright limb itself
  float ring = exp(-pow((ndv - 0.18) * 12.0, 2.0));
  float limb = fresnel * fresnel;

  vec3 bright = mix(uColor, vec3(1.0), 0.55);
  vec3 col = body
           + bright * filaments * 0.9
           + bright * ring * (0.7 + uAudio * 0.5)
           + uColor * limb * 1.2
           + uColor * max(vDisp, 0.0) * 0.8;
  col *= uGlow;

  float alpha = clamp(0.92 + fresnel * 0.08, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
`;

const WIRE_FRAG = `
uniform vec3 uColor;
uniform float uAudio;
uniform float uGlow;
varying float vDisp;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  float a = 0.02 + uAudio * 0.06 + max(vDisp, 0.0) * 0.35;
  gl_FragColor = vec4(uColor * 0.9 * uGlow, clamp(a, 0.0, 0.14));
}
`;

const HALO_VERT = `
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = -mvPosition.xyz;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const HALO_FRAG = `
uniform vec3 uColor;
uniform float uGlow;
uniform float uAudio;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(vView);
  float rim = pow(clamp(dot(N, V), 0.0, 1.0), 3.0);
  gl_FragColor = vec4(uColor, rim * (0.24 * uGlow + uAudio * 0.25));
}
`;

// ── Three.js lazy loader ────────────────────────────────────────────────────

let _threeModPromise = null;
function _loadThree() {
  if (!_threeModPromise) _threeModPromise = import('/three/three.module.min.js');
  return _threeModPromise;
}

// ── Class ───────────────────────────────────────────────────────────────────

class VoiceOrb3D {
  static isSupported() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch { return false; }
  }

  constructor(canvas, app) {
    this.canvas = canvas;
    this.app = app;
    this.targetState = 'idle';
    this.running = false;
    this.ready = false;
    this.failed = false;
    this._destroyed = false;
    this.animationFrame = null;
    this.time = 0;
    this.audioLevel = 0;
    this.breathPhase = 0;
    this.touchPoint = null;
    this.touchEnergy = 0;
    this.onInitError = null;

    // Base noiseAmp is the at-rest ripple; voice adds up to ~0.3 on top (see
    // uNoiseAmp in _renderFrame), so silence = near-smooth, speech = bloom
    this.stateConfigs = {
      idle:       { color: { r: 160, g: 160, b: 200 }, breathRate: 0.012, breathDepth: 0.06, rot: 0.05, noiseAmp: 0.025, noiseSpeed: 0.4, glow: 0.7 },
      listening:  { color: { r: 255, g: 70,  b: 70  }, breathRate: 0.022, breathDepth: 0.08, rot: 0.12, noiseAmp: 0.05,  noiseSpeed: 0.9, glow: 1.0 },
      processing: { color: { r: 255, g: 200, b: 50  }, breathRate: 0.035, breathDepth: 0.04, rot: 0.45, noiseAmp: 0.08,  noiseSpeed: 1.6, glow: 0.9 },
      speaking:   { color: { r: 60,  g: 160, b: 255 }, breathRate: 0.018, breathDepth: 0.10, rot: 0.10, noiseAmp: 0.07,  noiseSpeed: 1.1, glow: 1.1 },
    };

    this.current = {
      color:      { r: 160, g: 160, b: 200 },
      breathRate: 0,
      breathDepth: 0,
      rot: 0,
      noiseAmp: 0,
      noiseSpeed: 0.4,
      glow: 0.7,
    };

    this._setupTouch();

    this._initPromise = this._init().catch((err) => {
      this.failed = true;
      console.warn('[VoiceOrb3D] init failed, falling back:', err);
      if (this.onInitError) this.onInitError(err);
    });
  }

  setState(state) {
    this.targetState = state;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._tick();
  }

  stop() {
    this.running = false;
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  destroy() {
    this._destroyed = true;
    this.stop();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    if (this.ready) {
      // Dispose geometries
      if (this.coreGeometry) this.coreGeometry.dispose();
      if (this.haloGeometry) this.haloGeometry.dispose();
      if (this.particleGeometry) this.particleGeometry.dispose();
      // Dispose materials
      if (this.coreMaterial) this.coreMaterial.dispose();
      if (this.wireMaterial) this.wireMaterial.dispose();
      if (this.haloMaterial) this.haloMaterial.dispose();
      if (this.particleMaterial) this.particleMaterial.dispose();
      if (this.particleTexture) this.particleTexture.dispose();
      if (this.soulMaterial) this.soulMaterial.dispose();
      // Dispose renderer
      if (this.renderer) {
        this.renderer.dispose();
        if (this.renderer.forceContextLoss) this.renderer.forceContextLoss();
      }
      this.renderer = null;
      this.scene = null;
    }
  }

  // ── Private ─────────────────────────────────────────────────────────────

  async _init() {
    const THREE = await _loadThree();
    if (this._destroyed) return;

    this.THREE = THREE;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
    });
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.z = 3.2;

    this.group = new THREE.Group();
    this.scene.add(this.group);

    // Shared uniforms (core + wire share the same object)
    this.uniforms = {
      uTime:       { value: 0 },
      uColor:      { value: new THREE.Color(160 / 255, 160 / 255, 200 / 255) },
      uAudio:      { value: 0 },
      uNoiseAmp:   { value: 0.05 },
      uNoiseSpeed: { value: 0.4 },
      uGlow:       { value: 0.7 },
      uTouch:      { value: new THREE.Vector3(0, 0, 0) },
    };

    // 1. Core mesh — noise-displaced icosphere. detail=16 → ~5.8k faces, enough
    // tessellation that displacement reads as liquid rather than low-poly facets
    this.coreGeometry = new THREE.IcosahedronGeometry(1, 16);
    this.coreMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: ORB_VERT,
      fragmentShader: ORB_FRAG,
      transparent: true,
    });
    this.coreMesh = new THREE.Mesh(this.coreGeometry, this.coreMaterial);
    this.group.add(this.coreMesh);

    // 2. Wireframe shell — same geometry; normal blending so it shows on
    // light backgrounds (additive is invisible over white)
    this.wireMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: ORB_VERT,
      fragmentShader: WIRE_FRAG,
      wireframe: true,
      transparent: true,
      depthWrite: false,
    });
    this.wireMesh = new THREE.Mesh(this.coreGeometry, this.wireMaterial);
    this.group.add(this.wireMesh);

    // 3. Halo — back-face sphere with fresnel rim glow (normal blending for
    // light-theme visibility)
    this.haloGeometry = new THREE.SphereGeometry(1.35, 48, 48);
    this.haloMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
    });
    this.haloMesh = new THREE.Mesh(this.haloGeometry, this.haloMaterial);
    this.group.add(this.haloMesh);

    // 4. Particles — 260 points on a spherical shell (1.5–2.0 radius)
    this.particleGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(260 * 3);
    for (let i = 0; i < 260; i++) {
      // Normalize-random-cube trick for uniform sphere directions
      let x, y, z;
      do {
        x = Math.random() * 2 - 1;
        y = Math.random() * 2 - 1;
        z = Math.random() * 2 - 1;
      } while (x * x + y * y + z * z >= 1);
      const len = Math.sqrt(x * x + y * y + z * z);
      const r = 1.5 + Math.random() * 0.5;
      positions[i * 3]     = (x / len) * r;
      positions[i * 3 + 1] = (y / len) * r;
      positions[i * 3 + 2] = (z / len) * r;
    }
    this.particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // Radial-gradient sprite so points render as soft round motes, not squares
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 64;
    const sctx = sprite.getContext('2d');
    const grad = sctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.5)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, 64, 64);
    this.particleTexture = new THREE.CanvasTexture(sprite);
    this.particleMaterial = new THREE.PointsMaterial({
      size: 0.04,
      map: this.particleTexture,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      color: new THREE.Color(160 / 255, 160 / 255, 200 / 255),
    });
    this.particles = new THREE.Points(this.particleGeometry, this.particleMaterial);
    this.scene.add(this.particles);

    // 5. Soul — a small white orb at the heart of the sphere. Drawn last with
    // depth testing off so it glows through the shell from the very center.
    this.soulMaterial = new THREE.SpriteMaterial({
      map: this.particleTexture,
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      depthTest: false,
      depthWrite: false,
    });
    this.soul = new THREE.Sprite(this.soulMaterial);
    this.soul.renderOrder = 10;
    this.soul.scale.set(0.3, 0.3, 1);
    this.group.add(this.soul);

    this._setupResize();
    this.ready = true;
  }

  _tick() {
    if (!this.running) return;
    this.animationFrame = requestAnimationFrame(() => this._tick());
    if (this.ready) this._renderFrame();
  }

  _renderFrame() {
    this.time += 0.016;

    // Poll audio level (same logic as VoiceOrbCanvas)
    let rawLevel = 0;
    if (this.app?.voiceChatManager?.useNativeAudio) {
      rawLevel = this.app.voiceChatManager.getNativeLevel(this.targetState);
    } else if (this.targetState === 'listening') {
      rawLevel = this.app?.sttManager?.getAudioLevel?.() || 0;
    } else if (this.targetState === 'speaking') {
      rawLevel = this.app?.ttsManager?.getAudioLevel?.() || 0;
    }
    this.audioLevel = this._lerp(this.audioLevel, rawLevel, 0.15);

    const config = this.stateConfigs[this.targetState] || this.stateConfigs.idle;
    const ease = 0.04;

    // Touch energy
    this.touchEnergy = this._lerp(this.touchEnergy, this.touchPoint ? 1 : 0, this.touchPoint ? 0.15 : 0.05);

    // Lerp current toward config
    this.current.color.r = this._lerp(this.current.color.r, config.color.r, ease);
    this.current.color.g = this._lerp(this.current.color.g, config.color.g, ease);
    this.current.color.b = this._lerp(this.current.color.b, config.color.b, ease);
    this.current.rot = this._lerp(this.current.rot, config.rot, ease);
    this.current.breathRate = this._lerp(this.current.breathRate, config.breathRate, ease);
    this.current.noiseSpeed = this._lerp(this.current.noiseSpeed, config.noiseSpeed, ease);
    this.current.glow = this._lerp(this.current.glow, config.glow, ease);
    this.current.breathDepth = this._lerp(this.current.breathDepth, config.breathDepth, ease * 3);
    this.current.noiseAmp = this._lerp(this.current.noiseAmp, config.noiseAmp, ease * 3);

    // Breathing
    this.breathPhase += this.current.breathRate + this.audioLevel * 0.02;
    const rawBreath = Math.sin(this.breathPhase);
    const breathMod = 1 + this.current.breathDepth * (0.7 * rawBreath + 0.3 * rawBreath * rawBreath * rawBreath);

    // Transform
    this.group.scale.setScalar(breathMod);
    this.group.rotation.y += (this.current.rot + this.audioLevel * 0.08) * 0.016;
    this.group.rotation.x = this._lerp(this.group.rotation.x, (this.touchPoint ? -this.touchPoint.y * 0.45 : Math.sin(this.time * 0.13) * 0.12), 0.06);
    this.group.rotation.z = Math.sin(this.time * 0.09) * 0.08;

    // Uniforms
    this.uniforms.uTime.value = this.time;
    this.uniforms.uAudio.value = this.audioLevel;
    this.uniforms.uNoiseAmp.value = this.current.noiseAmp + this.audioLevel * 0.30 + this.touchEnergy * 0.08;
    this.uniforms.uNoiseSpeed.value = this.current.noiseSpeed;
    this.uniforms.uGlow.value = this.current.glow * (0.85 + 0.15 * (rawBreath * 0.5 + 0.5));
    this.uniforms.uColor.value.setRGB(this.current.color.r / 255, this.current.color.g / 255, this.current.color.b / 255);
    this.uniforms.uTouch.value.set(this.touchPoint?.x || 0, this.touchPoint?.y || 0, this.touchEnergy);

    // Particles
    this.particles.rotation.y -= 0.0008 + this.audioLevel * 0.002;
    this.particleMaterial.color.copy(this.uniforms.uColor.value);

    // Soul — gentle breath pulse, swells with voice
    const soulScale = 0.3 * (1 + 0.1 * rawBreath + this.audioLevel * 0.45);
    this.soul.scale.set(soulScale, soulScale, 1);
    this.soulMaterial.opacity = Math.min(0.7 + 0.1 * (rawBreath * 0.5 + 0.5) + this.audioLevel * 0.3, 1);

    // Render
    this.renderer.render(this.scene, this.camera);
  }

  _setupResize() {
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(this.canvas.parentElement);
    this._resize();
  }

  _resize() {
    const parent = this.canvas.parentElement;
    if (!parent || !this.renderer) return;
    const size = Math.min(parent.clientWidth, parent.clientHeight);
    if (!size) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(size, size, false);
    this.canvas.style.width = size + 'px';
    this.canvas.style.height = size + 'px';
  }

  _setupTouch() {
    const toNorm = (clientX, clientY) => {
      const rect = this.canvas.getBoundingClientRect();
      return {
        x: ((clientX - rect.left) / rect.width) * 2 - 1,
        y: -(((clientY - rect.top) / rect.height) * 2 - 1),
      };
    };

    this.canvas.addEventListener('mousedown', (e) => {
      this.touchPoint = toNorm(e.clientX, e.clientY);
    });
    this.canvas.addEventListener('mousemove', (e) => {
      if (this.touchPoint) this.touchPoint = toNorm(e.clientX, e.clientY);
    });
    this.canvas.addEventListener('mouseup', () => { this.touchPoint = null; });
    this.canvas.addEventListener('mouseleave', () => { this.touchPoint = null; });
    this.canvas.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      this.touchPoint = toNorm(t.clientX, t.clientY);
    }, { passive: true });
    this.canvas.addEventListener('touchmove', (e) => {
      const t = e.touches[0];
      this.touchPoint = toNorm(t.clientX, t.clientY);
    }, { passive: true });
    this.canvas.addEventListener('touchend', () => { this.touchPoint = null; });
    this.canvas.addEventListener('touchcancel', () => { this.touchPoint = null; });
  }

  _lerp(a, b, t) {
    return a + (b - a) * t;
  }
}

window.VoiceOrb3D = VoiceOrb3D;
