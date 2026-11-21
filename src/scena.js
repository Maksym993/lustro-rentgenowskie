// Wczytanie anatomii i rysowanie: warstwy anatomii do bufora, maska sylwetki, złożenie z obrazem z kamery.
import * as THREE from 'three';
import { CZESCI, policzCzesciWierzcholkow, przypiszCzesciKotwicom, naprawPrzypiecia } from './czesci.js';

export const WARSTWY = ['kosci', 'miesnie', 'narzady', 'naczynia', 'mozg', 'oczy', 'skora'];
const ILE_KLATEK = 8; // ile ostatnich klatek obrazu trzymamy (największe opóźnienie wygładzania to 5 klatek)

export async function wczytajAnatomie(postep) {
  const [opis, odp] = await Promise.all([fetch('/anatomia/cialo.json').then((r) => r.json()), fetch('/anatomia/cialo.bin')]);
  const ile = +odp.headers.get('content-length') || 36e6;
  const czyt = odp.body.getReader();
  const kaw = [];
  let mam = 0;
  for (;;) {
    const { done, value } = await czyt.read();
    if (done) break;
    kaw.push(value);
    mam += value.length;
    postep?.(Math.min(1, mam / ile));
  }
  const bin = new Uint8Array(mam);
  let o = 0;
  for (const k of kaw) {
    bin.set(k, o);
    o += k.length;
  }
  // wierzchołki przypięte do kości z dwóch różnych kończyn zostają przy jednej (patrz naprawPrzypiecia)
  opis.poprawionePrzypiecia = naprawPrzypiecia(opis, bin);
  // część ciała każdego wierzchołka i każdej kotwicy podpisu (do zaznaczania fragmentów ciała)
  const czesci = policzCzesciWierzcholkow(opis, bin);
  przypiszCzesciKotwicom(opis, bin, czesci);
  const geometrie = {};
  for (const w of WARSTWY) {
    const W = opis.warstwy[w];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bin.buffer, W.poz, W.wierzcholki * 3), 3));
    g.setAttribute('aNormalna', new THREE.BufferAttribute(new Int8Array(bin.buffer, W.nor, W.wierzcholki * 4), 4, true));
    g.setAttribute('aKolor', new THREE.BufferAttribute(new Uint8Array(bin.buffer, W.kol, W.wierzcholki * 4), 4, true));
    g.setAttribute('aRig', new THREE.BufferAttribute(new Uint8Array(bin.buffer, W.rig, W.wierzcholki * 4), 4, false));
    g.setAttribute('aCzesc', new THREE.BufferAttribute(czesci[w], 1, false));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(bin.buffer, W.ind, W.trojkaty * 3), 1));
    geometrie[w] = g;
  }
  return { opis, geometrie };
}

const WIERZCH = (n) => /* glsl */ `
uniform mat4 uKosci[${n}];
uniform float uWidok[${n}];
uniform vec2 uGlebia[${n}];
uniform vec3 uPersp;
uniform float uCzesc[${CZESCI.length}];
uniform float uCofnij;
attribute float aCzesc;
attribute vec4 aNormalna;
attribute vec4 aKolor;
attribute vec4 aRig;
varying vec3 vN;
varying vec3 vKolor;
varying float vWidok;
void main() {
  int i0 = int(aRig.x + 0.5);
  int i1 = int(aRig.y + 0.5);
  float w = aRig.z / 255.0;
  mat4 m0 = uKosci[i0];
  mat4 m1 = uKosci[i1];
  vec4 p0 = m0 * vec4(position, 1.0);
  vec4 p1 = m1 * vec4(position, 1.0);
  vec4 p = mix(p1, p0, w);
  // Wierzchołek rozpięty między dwiema kośćmi, które się rozjechały (np. dłoń zgubiona przez śledzenie),
  // znika, zamiast rozciągać skórę i mięśnie w smugę przez pół kadru. Rozjazd liczony w milimetrach ciała.
  float skalaKosci = max(0.5 * (length(m0[0].xyz) + length(m1[0].xyz)), 1e-4);
  float rozjazd = min(w, 1.0 - w) * distance(p0.xy, p1.xy) / skalaKosci;
  float spojny = 1.0 - smoothstep(60.0, 120.0, rozjazd);
  // perspektywa: to, co leży dalej od kamery niż płaszczyzna dopasowania, zbiega się do środka obrazu
  vec2 gl = uGlebia[i0] * w + uGlebia[i1] * (1.0 - w);
  float wsp = 1.0 / max(0.4, 1.0 - (p.z - gl.x) / uPersp.z);
  p.xy = mix(p.xy, uPersp.xy + (p.xy - uPersp.xy) * wsp, gl.y);
  vN = normalize(mix(mat3(m1) * aNormalna.xyz, mat3(m0) * aNormalna.xyz, w));
  vWidok = (uWidok[i0] * w + uWidok[i1] * (1.0 - w)) * spojny * uCzesc[int(aCzesc + 0.5)];
  vKolor = aKolor.rgb;
  p.z -= uCofnij;
  gl_Position = projectionMatrix * viewMatrix * p;
}`;

const FRAG_RENTGEN = /* glsl */ `
precision highp float;
uniform vec3 uBarwa;
uniform float uMoc;
uniform float uBaza;
uniform float uKrawedz;
uniform float uWykladnik;
uniform float uWlasnyKolor;
varying vec3 vN;
varying vec3 vKolor;
varying float vWidok;
void main() {
  float f = 1.0 - abs(normalize(vN).z);
  float a = (uBaza + uKrawedz * pow(f, uWykladnik)) * uMoc * vWidok;
  vec3 k = mix(uBarwa, vKolor * uBarwa * 1.6, uWlasnyKolor);
  gl_FragColor = vec4(k * a, a);
}`;

const FRAG_BRYLA = /* glsl */ `
precision highp float;
uniform float uMoc;
varying vec3 vN;
varying vec3 vKolor;
varying float vWidok;
void main() {
  if (vWidok < 0.5) discard;
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float dyf = max(dot(n, normalize(vec3(0.35, 0.55, 0.75))), 0.0);
  float wyp = max(dot(n, normalize(vec3(-0.6, 0.1, 0.6))), 0.0);
  float kraw = pow(1.0 - abs(n.z), 3.0);
  float blysk = pow(max(dot(n, normalize(vec3(0.25, 0.45, 0.86))), 0.0), 28.0);
  vec3 k = vKolor * (0.22 + 0.78 * dyf + 0.18 * wyp) * (1.0 - 0.35 * kraw) + vec3(0.16) * blysk;
  gl_FragColor = vec4(k * uMoc, 1.0);
}`;

// zasłona w buforze głębi: nic nie rysuje, tylko zasłania to, co leży za nią
const FRAG_ZASLONA = /* glsl */ `
precision highp float;
varying float vWidok;
void main() {
  if (vWidok < 0.5) discard;
  gl_FragColor = vec4(0.0);
}`;

const FRAG_MASKA = /* glsl */ `
precision highp float;
varying float vWidok;
void main() {
  if (vWidok < 0.35) discard;
  gl_FragColor = vec4(1.0);
}`;

// wygląd warstw w trybie rentgena
const RENTGEN = {
  kosci: { barwa: [0.8, 0.9, 1.0], moc: 0.6, baza: 0.025, krawedz: 0.8, wykl: 2.3, wlasny: 0.2 },
  miesnie: { barwa: [1.0, 0.2, 0.16], moc: 0.2, baza: 0.012, krawedz: 0.9, wykl: 2.4, wlasny: 0.3 },
  narzady: { barwa: [1.0, 0.8, 0.75], moc: 0.34, baza: 0.05, krawedz: 0.9, wykl: 2.0, wlasny: 1.0 },
  naczynia: { barwa: [1.0, 1.0, 1.0], moc: 0.6, baza: 0.1, krawedz: 0.9, wykl: 1.6, wlasny: 1.0 },
  mozg: { barwa: [1.0, 0.42, 0.7], moc: 0.34, baza: 0.03, krawedz: 0.9, wykl: 2.0, wlasny: 0.3 },
  oczy: { barwa: [0.95, 0.97, 1.0], moc: 0.5, baza: 0.05, krawedz: 0.9, wykl: 2.2, wlasny: 0.0 },
  skora: { barwa: [0.2, 0.47, 1.0], moc: 0.5, baza: 0.0, krawedz: 1.0, wykl: 4.5, wlasny: 0.0 },
};

const FRAG_ZLOZENIE = /* glsl */ `
precision highp float;
uniform sampler2D tWideo;
uniform sampler2D tAnat;
uniform sampler2D tMaska;
uniform sampler2D tNapisy;
uniform vec2 uRozmiar;
uniform vec4 uKadr;       // skala xy i przesunięcie xy: uv sceny -> uv wideo
uniform float uMaWideo;
uniform float uLustro;
uniform float uTryb;      // 0 rentgen, 1 bryła
uniform float uPrzenikanie; // ile prawdziwego obrazu widać w sylwetce
uniform float uJasnosc;
uniform float uPioro;     // miękkość krawędzi w pikselach
uniform float uOdslona;   // 0 całość, 1 półpłaszczyzna, 2 soczewka
uniform vec3 uLinia;      // nx, ny, d: odsłonięte tam, gdzie nx*x + ny*y + d > 0
uniform vec3 uSoczewka;   // x, y, promień
varying vec2 vUv;

float maska(vec2 uv) {
  vec2 k = uPioro * 0.5 / uRozmiar;
  float s = texture2D(tMaska, uv).r * 0.25;
  s += texture2D(tMaska, uv + vec2(k.x, 0.0)).r * 0.125;
  s += texture2D(tMaska, uv - vec2(k.x, 0.0)).r * 0.125;
  s += texture2D(tMaska, uv + vec2(0.0, k.y)).r * 0.125;
  s += texture2D(tMaska, uv - vec2(0.0, k.y)).r * 0.125;
  s += texture2D(tMaska, uv + k).r * 0.0625;
  s += texture2D(tMaska, uv - k).r * 0.0625;
  s += texture2D(tMaska, uv + vec2(k.x, -k.y)).r * 0.0625;
  s += texture2D(tMaska, uv + vec2(-k.x, k.y)).r * 0.0625;
  return s;
}

void main() {
  vec2 uvS = vec2(mix(vUv.x, 1.0 - vUv.x, uLustro), vUv.y);
  vec2 px = uvS * uRozmiar;
  vec2 uvW = uvS * uKadr.xy + uKadr.zw;
  vec3 wideo = texture2D(tWideo, uvW).rgb;
  if (uMaWideo < 0.5) {
    float w = distance(vUv, vec2(0.5, 0.55));
    wideo = mix(vec3(0.07, 0.09, 0.13), vec3(0.015, 0.02, 0.03), smoothstep(0.0, 0.8, w));
  }
  vec4 anat = texture2D(tAnat, uvS);
  float m = maska(uvS);

  float R = 1.0;
  float pioro = max(uPioro, 1.0);
  if (uOdslona > 0.5 && uOdslona < 1.5) {
    R = smoothstep(-pioro, pioro, uLinia.x * px.x + uLinia.y * px.y + uLinia.z);
  } else if (uOdslona > 1.5) {
    R = 1.0 - smoothstep(uSoczewka.z - pioro, uSoczewka.z + pioro, distance(px, uSoczewka.xy));
  }

  vec3 kolor;
  if (uTryb < 0.5) {
    float przyc = (1.0 - uPrzenikanie) * m * R;
    float lum = dot(wideo, vec3(0.299, 0.587, 0.114));
    vec3 ciemne = vec3(0.42, 0.52, 0.72) * lum * 0.15 + vec3(0.003, 0.007, 0.018);
    vec3 baza = mix(wideo, ciemne, przyc);
    // kompresja jasności z zachowaniem barwy: gęste miejsca nie wypalają się do bieli
    vec3 sw = anat.rgb * uJasnosc * 1.25;
    float mx = max(max(sw.r, sw.g), max(sw.b, 1e-4));
    vec3 a = mix(sw * ((1.0 - exp(-mx)) / mx), vec3(1.0) - exp(-sw), 0.45);
    kolor = baza + a * R * (1.0 - baza * 0.6);
  } else {
    float a = clamp(anat.a, 0.0, 1.0) * R * (1.0 - uPrzenikanie);
    kolor = mix(wideo, anat.rgb * uJasnosc, a);
    kolor += (vec3(1.0) - exp(-max(anat.rgb - 1.0, 0.0))) * 0.0;
  }

  vec4 nap = texture2D(tNapisy, vUv);
  kolor = kolor * (1.0 - nap.a) + nap.rgb;
  gl_FragColor = vec4(kolor, 1.0);
}`;

export class Scena {
  constructor(canvas, anat, rig) {
    this.canvas = canvas;
    this.anat = anat;
    this.rig = rig;
    const n = rig.n;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.autoClear = false;
    this.kamera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 8000);
    this.kamera.position.set(0, 0, 4000);
    this.scena = new THREE.Scene();
    this.scenaObrys = new THREE.Scene();
    this.scenaMaski = new THREE.Scene();
    this.uPersp = { value: new THREE.Vector3(960, 540, 1500) };
    // widoczność każdej części ciała (1 = zaznaczona); zmienia ją pętla główna
    this.czesc = new Float32Array(CZESCI.length).fill(1);
    const wspolne = { uKosci: { value: rig.macierze }, uWidok: { value: rig.widok }, uGlebia: { value: rig.glebia }, uPersp: this.uPersp, uCzesc: { value: this.czesc } };
    this.siatki = {};
    this.matRentgen = {};
    this.matBryla = {};
    for (const w of WARSTWY) {
      const r = RENTGEN[w];
      this.matRentgen[w] = new THREE.ShaderMaterial({
        vertexShader: WIERZCH(n),
        fragmentShader: FRAG_RENTGEN,
        uniforms: {
          ...wspolne,
          uBarwa: { value: new THREE.Vector3(...r.barwa) },
          uMoc: { value: r.moc },
          uBaza: { value: r.baza },
          uKrawedz: { value: r.krawedz },
          uWykladnik: { value: r.wykl },
          uWlasnyKolor: { value: r.wlasny },
        },
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
      });
      this.matBryla[w] = new THREE.ShaderMaterial({
        vertexShader: WIERZCH(n),
        fragmentShader: FRAG_BRYLA,
        uniforms: { ...wspolne, uMoc: { value: 1 } },
        side: THREE.DoubleSide,
      });
      const siatka = new THREE.Mesh(anat.geometrie[w], this.matRentgen[w]);
      siatka.frustumCulled = false;
      this.siatki[w] = siatka;
      (w === 'skora' ? this.scenaObrys : this.scena).add(siatka);
    }
    // Bryła: dłoń i przedramię trzymane przed tułowiem zasłaniają go, jak w prawdziwym obrazie. Skóra tych części,
    // cofnięta o 60 mm (za kości dłoni, przed tułów), trafia tylko do bufora głębi: anatomia tułowia za nią nie
    // rysuje się, więc w tym miejscu zostaje prawdziwa dłoń z własnymi kośćmi na wierzchu.
    this.czescZaslony = new Float32Array(CZESCI.length);
    this.nrZaslony = ['przedramieL', 'przedramieP', 'dlonL', 'dlonP'].map((id) => CZESCI.findIndex((c) => c.id === id));
    this.uCofnij = { value: 0 };
    this.matZaslony = new THREE.ShaderMaterial({
      vertexShader: WIERZCH(n),
      fragmentShader: FRAG_ZASLONA,
      uniforms: { ...wspolne, uCzesc: { value: this.czescZaslony }, uCofnij: this.uCofnij },
      side: THREE.DoubleSide,
      colorWrite: false,
    });
    this.scenaZaslony = new THREE.Scene();
    const sz = new THREE.Mesh(anat.geometrie.skora, this.matZaslony);
    sz.frustumCulled = false;
    this.scenaZaslony.add(sz);
    this.matMaski = new THREE.ShaderMaterial({ vertexShader: WIERZCH(n), fragmentShader: FRAG_MASKA, uniforms: { ...wspolne }, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    const sm = new THREE.Mesh(anat.geometrie.skora, this.matMaski);
    sm.frustumCulled = false;
    this.scenaMaski.add(sm);

    // złożenie
    this.pustaTekstura = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.pustaTekstura.needsUpdate = true;
    this.matZloz = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: FRAG_ZLOZENIE,
      uniforms: {
        tWideo: { value: this.pustaTekstura },
        tAnat: { value: null },
        tMaska: { value: null },
        tNapisy: { value: this.pustaTekstura },
        uRozmiar: { value: new THREE.Vector2(1, 1) },
        uKadr: { value: new THREE.Vector4(1, 1, 0, 0) },
        uMaWideo: { value: 0 },
        uLustro: { value: 0 },
        uTryb: { value: 0 },
        uPrzenikanie: { value: 0.5 },
        uJasnosc: { value: 1 },
        uPioro: { value: 20 },
        uOdslona: { value: 0 },
        uLinia: { value: new THREE.Vector3(1, 0, 0) },
        uSoczewka: { value: new THREE.Vector3(0, 0, 100) },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.scenaZloz = new THREE.Scene();
    const kwadrat = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.matZloz);
    kwadrat.frustumCulled = false;
    this.scenaZloz.add(kwadrat);
    this.kameraZloz = new THREE.Camera();
    // przepisywanie klatki źródła do pierścienia tekstur
    this.matKopii = new THREE.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'precision highp float; uniform sampler2D t; varying vec2 vUv; void main(){ gl_FragColor = vec4(texture2D(t, vUv).rgb, 1.0); }',
      uniforms: { t: { value: this.pustaTekstura } },
      depthTest: false,
      depthWrite: false,
    });
    this.scenaKopii = new THREE.Scene();
    const kwadratKopii = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.matKopii);
    kwadratKopii.frustumCulled = false;
    this.scenaKopii.add(kwadratKopii);
    this.pierscien = [];
    this.slot = -1;
    this.W = 0;
    this.H = 0;
  }

  ustawRozmiar(W, H) {
    if (W === this.W && H === this.H) return;
    this.W = W;
    this.H = H;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(W, H, false);
    this.kamera.left = 0;
    this.kamera.right = W;
    this.kamera.top = H;
    this.kamera.bottom = 0;
    this.kamera.updateProjectionMatrix();
    this.rtAnat?.dispose();
    this.rtMaska?.dispose();
    this.rtAnat = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: true, samples: 4, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rtMaska = new THREE.WebGLRenderTarget(Math.round(W / 4), Math.round(H / 4), { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.matZloz.uniforms.tAnat.value = this.rtAnat.texture;
    this.matZloz.uniforms.tMaska.value = this.rtMaska.texture;
    this.matZloz.uniforms.uRozmiar.value.set(W, H);
    // płótno podpisów zmienia rozmiar razem z kadrem, więc tekstura musi dostać nową pamięć
    this.teksturaNapisow?.dispose();
  }

  // Źródło obrazu: płótno z kopią bieżącej klatki. Każdą klatkę przepisujemy do jednej z kilku tekstur w pierścieniu,
  // żeby móc pokazać klatkę sprzed kilku klatek razem z anatomią policzoną dokładnie dla niej.
  ustawZrodlo(plotno) {
    this.teksturaZrodla?.dispose();
    for (const rt of this.pierscien) rt.dispose();
    this.pierscien = [];
    this.teksturaZrodla = null;
    this.slot = -1;
    if (!plotno || !plotno.width || !plotno.height) return;
    const t = new THREE.CanvasTexture(plotno);
    t.colorSpace = THREE.NoColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    this.teksturaZrodla = t;
    this.matKopii.uniforms.t.value = t;
    for (let i = 0; i < ILE_KLATEK; i++) {
      this.pierscien.push(new THREE.WebGLRenderTarget(plotno.width, plotno.height, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false }));
    }
  }
  // Przepisuje bieżącą zawartość płótna źródła do następnej tekstury pierścienia. Zwraca jej numer.
  wgrajKlatke() {
    if (!this.teksturaZrodla) return -1;
    this.slot = (this.slot + 1) % this.pierscien.length;
    this.teksturaZrodla.needsUpdate = true;
    const r = this.renderer;
    r.setRenderTarget(this.pierscien[this.slot]);
    r.render(this.scenaKopii, this.kameraZloz);
    r.setRenderTarget(null);
    return this.slot;
  }

  ustawNapisy(canvas2d) {
    this.teksturaNapisow = new THREE.CanvasTexture(canvas2d);
    this.teksturaNapisow.colorSpace = THREE.NoColorSpace;
    this.teksturaNapisow.premultiplyAlpha = true;
    this.teksturaNapisow.minFilter = THREE.LinearFilter;
    this.teksturaNapisow.generateMipmaps = false;
    this.matZloz.uniforms.tNapisy.value = this.teksturaNapisow;
  }

  // ust: { klatka: numer tekstury z wgrajKlatke() albo -1, warstwy: {kosci: bool, ...}, tryb: 'rentgen' | 'bryla', jasnosc, przenikanie, pioro, lustro,
  //   odslona: {rodzaj, linia, soczewka}, kadr: [sx, sy, ox, oy] }
  rysuj(ust) {
    const r = this.renderer;
    this.uPersp.value.set(...this.rig.persp);
    const bryla = ust.tryb === 'bryla';
    for (const w of WARSTWY) {
      const s = this.siatki[w];
      s.visible = !!ust.warstwy[w];
      if (w !== 'skora') s.material = bryla ? this.matBryla[w] : this.matRentgen[w];
    }
    // anatomia
    r.setRenderTarget(this.rtAnat);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    if (bryla) {
      for (const i of this.nrZaslony) this.czescZaslony[i] = this.czesc[i];
      this.uCofnij.value = 60 * (this.rig.info?.g || 1);
      r.render(this.scenaZaslony, this.kamera);
    }
    r.render(this.scena, this.kamera);
    if (this.siatki.skora.visible) r.render(this.scenaObrys, this.kamera);
    // maska sylwetki
    r.setRenderTarget(this.rtMaska);
    r.clear(true, false, false);
    r.render(this.scenaMaski, this.kamera);
    // złożenie
    const u = this.matZloz.uniforms;
    u.uTryb.value = bryla ? 1 : 0;
    u.uJasnosc.value = ust.jasnosc;
    u.uPrzenikanie.value = ust.przenikanie;
    u.uPioro.value = ust.pioro;
    u.uLustro.value = ust.lustro ? 1 : 0;
    u.uKadr.value.set(...ust.kadr);
    const o = ust.odslona;
    u.uOdslona.value = o.rodzaj === 'calosc' ? 0 : o.rodzaj === 'soczewka' ? 2 : 1;
    if (o.linia) u.uLinia.value.set(...o.linia);
    if (o.soczewka) u.uSoczewka.value.set(...o.soczewka);
    if (this.teksturaNapisow) this.teksturaNapisow.needsUpdate = true;
    const kl = ust.klatka >= 0 && this.pierscien[ust.klatka] ? this.pierscien[ust.klatka].texture : null;
    u.tWideo.value = kl || this.pustaTekstura;
    u.uMaWideo.value = kl ? 1 : 0;
    r.setRenderTarget(null);
    r.render(this.scenaZloz, this.kameraZloz);
  }
}
