// Buduje public/anatomia/cialo.bin i cialo.json z plików STL BodyParts3D 3.0.
// Uruchomienie: npm run anatomia   (z katalogu projektu)
//
// Co robi:
//  1. dzieli części na warstwy (klasy.mjs) i upraszcza siatki,
//  2. z kształtu kości wylicza stawy w pozycji spoczynkowej (bark, łokieć, palce itd.),
//  3. kościom daje kość rigu po nazwie, a tkankom miękkim (skóra, mięśnie, narządy) wagi
//     według najbliższych kości, żeby zginały się razem ze szkieletem,
//  4. dopasowuje wzorcową siatkę twarzy MediaPipe do twarzy modelu (do śledzenia głowy),
//  5. wylicza kotwice podpisów.
import fs from 'node:fs';
import path from 'node:path';
import { MeshoptSimplifier } from 'meshoptimizer';
import { wczytajStl, ramka } from './stl.mjs';
import { klasyfikuj, kostRigu, KOSCI_RIGU, NR } from './klasy.mjs';
import { ETYKIETY } from './etykiety.mjs';
import { osieGlowne, dopasujPodobienstwo, mnozR, odejmij, dodaj, razy, iloczyn, jednostkowy, dlugosc, mieszaj, ogranicz } from '../src/matma.js';

const KAT = 'surowe/bp3d-3.0';
const WYJ = 'public/anatomia';
const indeks = JSON.parse(fs.readFileSync('surowe/indeks-3.0.json', 'utf8'));
await MeshoptSimplifier.ready;

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s]`, ...a);

// ---------- narzędzia siatek ----------
function uprosc(m, celTr) {
  const tr = m.ind.length / 3;
  if (tr <= celTr * 1.15) return m;
  const [ind] = MeshoptSimplifier.simplify(m.ind, m.poz, 3, Math.floor(celTr) * 3, 1.0, []);
  // zagęszczenie wierzchołków
  const mapa = new Int32Array(m.poz.length / 3).fill(-1);
  const poz = [];
  const noweInd = new Uint32Array(ind.length);
  for (let i = 0; i < ind.length; i++) {
    const s = ind[i];
    if (mapa[s] < 0) {
      mapa[s] = poz.length / 3;
      poz.push(m.poz[s * 3], m.poz[s * 3 + 1], m.poz[s * 3 + 2]);
    }
    noweInd[i] = mapa[s];
  }
  return { poz: new Float32Array(poz), ind: noweInd };
}

function normalne(m) {
  const n = new Float32Array(m.poz.length);
  const p = m.poz;
  for (let i = 0; i < m.ind.length; i += 3) {
    const a = m.ind[i] * 3, b = m.ind[i + 1] * 3, c = m.ind[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) {
      n[k] += nx;
      n[k + 1] += ny;
      n[k + 2] += nz;
    }
  }
  for (let i = 0; i < n.length; i += 3) {
    const d = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= d;
    n[i + 1] /= d;
    n[i + 2] /= d;
  }
  return n;
}

// środek wierzchołków spełniających warunek
function srodekGdzie(poz, warunek) {
  const s = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < poz.length; i += 3) {
    if (warunek(poz[i], poz[i + 1], poz[i + 2])) {
      s[0] += poz[i];
      s[1] += poz[i + 1];
      s[2] += poz[i + 2];
      n++;
    }
  }
  if (!n) throw new Error('pusty wybór wierzchołków');
  return s.map((v) => v / n);
}

// końce kości długiej: środki skrajnych 12% wierzchołków wzdłuż osi głównej; pierwszy koniec to ten wyżej
function konce(poz, udzial = 0.12) {
  const { srodek, osie } = osieGlowne(poz);
  const os = osie[0];
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < poz.length; i += 3) {
    const t = (poz[i] - srodek[0]) * os[0] + (poz[i + 1] - srodek[1]) * os[1] + (poz[i + 2] - srodek[2]) * os[2];
    if (t < mn) mn = t;
    if (t > mx) mx = t;
  }
  const zak = mx - mn;
  const rzut = (x, y, z) => (x - srodek[0]) * os[0] + (y - srodek[1]) * os[1] + (z - srodek[2]) * os[2];
  const a = srodekGdzie(poz, (x, y, z) => rzut(x, y, z) < mn + zak * udzial);
  const b = srodekGdzie(poz, (x, y, z) => rzut(x, y, z) > mx - zak * udzial);
  // skrajne punkty na osi (czubki)
  const czA = dodaj(srodek, razy(os, mn));
  const czB = dodaj(srodek, razy(os, mx));
  return a[1] >= b[1] ? { gora: a, dol: b, czubekGora: czA, czubekDol: czB } : { gora: b, dol: a, czubekGora: czB, czubekDol: czA };
}

// ---------- 1. wczytanie i uproszczenie ----------
const czesci = []; // { id, en, klasa, m (uproszczona), surowa? }
const poNazwie = {}; // en -> surowe pozycje (tylko kości i kilka innych, do stawów)
let sumaTr = 0;
const idWszystkie = Object.keys(indeks).sort();
for (const id of idWszystkie) {
  const en = indeks[id].en;
  const klasa = klasyfikuj(id, en);
  if (!klasa) continue;
  const surowa = wczytajStl(path.join(KAT, id + '.stl'));
  const cel = Math.round(Math.min(klasa.cel[2], Math.max(klasa.cel[1], (surowa.ind.length / 3) * klasa.cel[0])));
  const m = uprosc(surowa, cel);
  if (klasa.warstwa === 'kosci' || en === 'skin' || en === 'eyeball' || en === 'ear') poNazwie[en] = surowa.poz;
  czesci.push({ id, en, klasa, m });
  sumaTr += m.ind.length / 3;
}
log('części', czesci.length, 'trójkątów po uproszczeniu', sumaTr);

// ---------- 2. stawy w pozycji spoczynkowej ----------
const K = (en) => {
  if (!poNazwie[en]) throw new Error('brak kości: ' + en);
  return poNazwie[en];
};
const STR = { L: 'left', P: 'right' };
const staw = {};
for (const s of ['L', 'P']) {
  const lr = STR[s];
  const znak = s === 'L' ? 1 : -1;
  const hum = K(`${lr} humerus`);
  const rh = ramka(hum);
  staw['bark' + s] = srodekGdzie(hum, (x, y) => y > rh.mx[1] - 38);
  staw['lokiec' + s] = srodekGdzie(hum, (x, y) => y < rh.mn[1] + 22);
  // oś zawiasu łokcia: najdłuższa oś dolnego końca kości ramiennej, zwrócona w stronę -X
  {
    const dol = [];
    for (let i = 0; i < hum.length; i += 3) if (hum[i + 1] < rh.mn[1] + 22) dol.push(hum[i], hum[i + 1], hum[i + 2]);
    let os = osieGlowne(new Float32Array(dol)).osie[0];
    if (os[0] > 0) os = razy(os, -1);
    staw['osLokcia' + s] = os;
  }
  const nadg = [];
  for (const n of ['scaphoid', 'lunate', 'triquetral']) nadg.push(...K(`${lr} ${n}`));
  staw['nadgarstek' + s] = ramka(new Float32Array(nadg)).sr;
  // oś nawracania: od głowy kości promieniowej do głowy kości łokciowej
  const prom = konce(K(`${lr} radius`));
  const lok = konce(K(`${lr} ulna`));
  staw['promienGora' + s] = prom.gora;
  staw['promienDol' + s] = prom.dol;
  staw['lokciowaDol' + s] = lok.dol;

  const fem = K(`${lr} femur`);
  const rf = ramka(fem);
  {
    // głowa kości udowej: górne 48 mm, połowa bliższa osi ciała
    const xs = [];
    for (let i = 0; i < fem.length; i += 3) if (fem[i + 1] > rf.mx[1] - 48) xs.push(fem[i] * znak);
    xs.sort((a, b) => a - b);
    const prog = xs[Math.floor(xs.length * 0.4)];
    staw['biodro' + s] = srodekGdzie(fem, (x, y) => y > rf.mx[1] - 48 && x * znak <= prog);
  }
  const tib = K(`${lr} tibia`);
  const rt = ramka(tib);
  const fib = K(`${lr} fibula`);
  const rfi = ramka(fib);
  const kolUd = srodekGdzie(fem, (x, y) => y < rf.mn[1] + 28);
  const kolPi = srodekGdzie(tib, (x, y) => y > rt.mx[1] - 18);
  staw['kolano' + s] = mieszaj(kolUd, kolPi, 0.5);
  {
    const dol = [];
    for (let i = 0; i < fem.length; i += 3) if (fem[i + 1] < rf.mn[1] + 28) dol.push(fem[i], fem[i + 1], fem[i + 2]);
    let os = osieGlowne(new Float32Array(dol)).osie[0];
    if (os[0] < 0) os = razy(os, -1);
    staw['osKolana' + s] = os;
  }
  staw['kostka' + s] = mieszaj(
    srodekGdzie(tib, (x, y) => y < rt.mn[1] + 18),
    srodekGdzie(fib, (x, y) => y < rfi.mn[1] + 18),
    0.5,
  );
  const cal = K(`${lr} calcaneus`);
  const rc = ramka(cal);
  staw['pieta' + s] = srodekGdzie(cal, (x, y, z) => z < rc.mn[2] + 10);
  const paluch = K(`distal phalanx of ${lr} big toe`);
  const rp = ramka(paluch);
  staw['palecStopy' + s] = srodekGdzie(paluch, (x, y, z) => z > rp.mx[2] - 6);

  // dłoń
  const PALCE = [
    ['kciuk', 'first', 'thumb'],
    ['wskazujacy', 'second', 'index finger'],
    ['srodkowy', 'third', 'middle finger'],
    ['serdeczny', 'fourth', 'ring finger'],
    ['maly', 'fifth', 'little finger'],
  ];
  const dlon = { nadgarstek: staw['nadgarstek' + s], palce: {} };
  for (const [pl, num, en] of PALCE) {
    const mc = konce(K(`${lr} ${num} metacarpal bone`));
    const pp = konce(K(`proximal phalanx of ${lr} ${en}`));
    const dp = konce(K(`distal phalanx of ${lr} ${en}`));
    const kier = (k) => jednostkowy(odejmij(k.dol, k.gora));
    const o = { podstawa: mc.czubekGora, mcp: mieszaj(mc.czubekDol, pp.czubekGora, 0.5) };
    if (pl === 'kciuk') {
      o.ip = mieszaj(pp.czubekDol, dp.czubekGora, 0.5);
      o.czubek = dodaj(dp.czubekDol, razy(kier(dp), 3));
    } else {
      const mp = konce(K(`middle phalanx of ${lr} ${en}`));
      o.pip = mieszaj(pp.czubekDol, mp.czubekGora, 0.5);
      o.dip = mieszaj(mp.czubekDol, dp.czubekGora, 0.5);
      o.czubek = dodaj(dp.czubekDol, razy(kier(dp), 3));
    }
    dlon.palce[pl] = o;
  }
  staw['dlon' + s] = dlon;
}
// kręgosłup: wysokości do mieszania
const srodekY = (en) => ramka(K(en)).sr[1];
staw.yC1 = srodekY('atlas');
staw.yC7 = srodekY('seventh cervical vertebra');
staw.yT10 = srodekY('tenth thoracic vertebra');
staw.yS1 = ramka(K('sacrum')).mx[1] - 12;
// głowa: żuchwa, oczy, uszy
{
  const man = K('mandible');
  const rm = ramka(man);
  const klL = srodekGdzie(man, (x, y) => y > rm.mx[1] - 8 && x > 0);
  const klP = srodekGdzie(man, (x, y) => y > rm.mx[1] - 8 && x < 0);
  staw.zuchwaOsL = klL;
  staw.zuchwaOsP = klP;
  const oko = K('eyeball');
  staw.okoL = srodekGdzie(oko, (x) => x > 0);
  staw.okoP = srodekGdzie(oko, (x) => x < 0);
  const ucho = poNazwie.ear;
  staw.uchoL = srodekGdzie(ucho, (x) => x > 0);
  staw.uchoP = srodekGdzie(ucho, (x) => x < 0);
  const skora = K('skin');
  // czubek nosa: najdalej wysunięty do przodu punkt skóry głowy blisko płaszczyzny środkowej
  let nos = null;
  for (let i = 0; i < skora.length; i += 3) {
    if (skora[i + 1] > staw.yC1 && Math.abs(skora[i]) < 10 && (!nos || skora[i + 2] > nos[2])) nos = [skora[i], skora[i + 1], skora[i + 2]];
  }
  staw.nos = nos;
  staw.czubekGlowy = [0, ramka(skora).mx[1], staw.uchoL[2]];
}
log('stawy policzone; barki', staw.barkL.map((v) => v.toFixed(0)), staw.barkP.map((v) => v.toFixed(0)), 'biodra', staw.biodroL.map((v) => v.toFixed(0)), 'nos', staw.nos.map((v) => v.toFixed(0)));

// ---------- 3. dopasowanie wzorcowej twarzy MediaPipe do skóry modelu ----------
const kanon = [];
for (const l of fs.readFileSync('surowe/mediapipe/canonical_face_model.obj', 'utf8').split('\n')) {
  if (l.startsWith('v ')) {
    const p = l.trim().split(/\s+/);
    kanon.push([+p[1] * 10, +p[2] * 10, +p[3] * 10]); // cm -> mm
  }
}
if (kanon.length !== 468) throw new Error('wzorcowa twarz ma mieć 468 punktów');
if (!(kanon[33][0] < 0 && kanon[263][0] > 0)) throw new Error('nieoczekiwana orientacja osi X wzorcowej twarzy');
let twarzPunkty;
{
  const skora = K('skin');
  // punkty skóry twarzy: głowa, przednia część
  const pkt = [];
  for (let i = 0; i < skora.length; i += 3) {
    if (skora[i + 1] > staw.nos[1] - 95 && skora[i + 1] < staw.nos[1] + 110 && skora[i + 2] > staw.uchoL[2] + 5) pkt.push([skora[i], skora[i + 1], skora[i + 2]]);
  }
  // siatka do wyszukiwania najbliższego punktu
  const KOM = 6;
  const siatka = new Map();
  const klucz = (a, b, c) => a * 73856093 + b * 19349663 + c * 83492791;
  pkt.forEach((p, i) => {
    const k = klucz(Math.floor(p[0] / KOM), Math.floor(p[1] / KOM), Math.floor(p[2] / KOM));
    let l = siatka.get(k);
    if (!l) siatka.set(k, (l = []));
    l.push(i);
  });
  const najblizszy = (p) => {
    const c = [Math.floor(p[0] / KOM), Math.floor(p[1] / KOM), Math.floor(p[2] / KOM)];
    let naj = -1, najD = Infinity;
    for (let r = 1; r <= 12; r++) {
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (let d = -r; d <= r; d++) {
        if (Math.max(Math.abs(a), Math.abs(b), Math.abs(d)) !== r && r > 1) continue;
        const l = siatka.get(klucz(c[0] + a, c[1] + b, c[2] + d));
        if (!l) continue;
        for (const i of l) {
          const q = pkt[i];
          const dd = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
          if (dd < najD) {
            najD = dd;
            naj = i;
          }
        }
      }
      if (naj >= 0 && Math.sqrt(najD) < (r - 1) * KOM) break;
    }
    return naj < 0 ? null : { p: pkt[naj], d: Math.sqrt(najD) };
  };
  // start: czubek nosa wzorca (punkt 1) na czubek nosa modelu
  let biez = kanon.map((p) => dodaj(odejmij(p, kanon[1]), staw.nos));
  let blad = 0;
  for (let it = 0; it < 60; it++) {
    const pary = [];
    for (let i = 0; i < 468; i++) {
      const n = najblizszy(biez[i]);
      if (n) pary.push({ i, cel: n.p, d: n.d });
    }
    pary.sort((a, b) => a.d - b.d);
    const uzyte = pary.slice(0, Math.floor(pary.length * 0.85));
    blad = uzyte.reduce((s, p) => s + p.d, 0) / uzyte.length;
    const dop = dopasujPodobienstwo(uzyte.map((p) => biez[p.i]), uzyte.map((p) => p.cel));
    biez = biez.map((p) => dodaj(razy(mnozR(dop.R, p), dop.skala), dop.t));
  }
  const skalaKoncowa = dlugosc(odejmij(biez[33], biez[263])) / dlugosc(odejmij(kanon[33], kanon[263]));
  log('twarz wzorcowa dopasowana: średni błąd', blad.toFixed(2), 'mm, skala', skalaKoncowa.toFixed(3));
  twarzPunkty = biez;
}

// ---------- 4. wagi rigu ----------
const liniowo = (v, a, b) => ogranicz((v - a) / (b - a), 0, 1);
function wagiKosci(en, poz) {
  const r = kostRigu(en);
  if (!r) return null;
  const y = ramka(poz).sr[1];
  if (r === 'szyja') {
    const wg = 0.06 + liniowo(y, staw.yC7, staw.yC1) * 0.86;
    return [NR.glowa, NR.klatka, wg];
  }
  if (r === 'ledzwie') {
    const wk = liniowo(y, staw.yS1, staw.yT10);
    return [NR.klatka, NR.miednica, wk];
  }
  if (!(r in NR)) throw new Error('nieznana kość rigu ' + r + ' dla ' + en);
  return [NR[r], NR[r], 1];
}

// chmura punktów kości z wagami, w siatce przestrzennej
const KOM = 14;
const chmura = { x: [], y: [], z: [], b0: [], b1: [], w: [] };
const kraty = new Map();
const kl = (a, b, c) => (a + 512) * 1048576 + (b + 512) * 1024 + (c + 512);
function dodajDoChmury(p, wg) {
  const i = chmura.x.length;
  chmura.x.push(p[0]);
  chmura.y.push(p[1]);
  chmura.z.push(p[2]);
  chmura.b0.push(wg[0]);
  chmura.b1.push(wg[1]);
  chmura.w.push(wg[2]);
  const k = kl(Math.floor(p[0] / KOM), Math.floor(p[1] / KOM), Math.floor(p[2] / KOM));
  let l = kraty.get(k);
  if (!l) kraty.set(k, (l = []));
  l.push(i);
}
for (const c of czesci) {
  if (c.klasa.warstwa !== 'kosci') continue;
  const wg = wagiKosci(c.en, c.m.poz);
  if (!wg) {
    c.miekka = true;
    continue;
  }
  c.wagiStale = wg;
  if (c.klasa.typ === 'chrzastka' && /nasal/.test(c.en)) continue; // chrząstki nosa nie ciągną skóry
  const p = c.m.poz;
  for (let i = 0; i < p.length; i += 3) dodajDoChmury([p[i], p[i + 1], p[i + 2]], wg);
  for (let i = 0; i < c.m.ind.length; i += 3) {
    const a = c.m.ind[i] * 3, b = c.m.ind[i + 1] * 3, d = c.m.ind[i + 2] * 3;
    dodajDoChmury([(p[a] + p[b] + p[d]) / 3, (p[a + 1] + p[b + 1] + p[d + 1]) / 3, (p[a + 2] + p[b + 2] + p[d + 2]) / 3], wg);
  }
}
log('chmura kości', chmura.x.length, 'punktów');
// narządy rozrodcze leżą między udami, więc najbliższą kością bywa udowa; mają jechać na miednicy
for (const c of czesci) if (/penis|testis|epididymis|seminal vesicle|deferent duct|prostate|urethra/.test(c.en)) c.wagiStale = [NR.miednica, NR.miednica, 1];

const wynikKosc = new Float64Array(KOSCI_RIGU.length);
function wagiMiekkie(px, py, pz) {
  const cx = Math.floor(px / KOM), cy = Math.floor(py / KOM), cz = Math.floor(pz / KOM);
  // etap 1: odległość do najbliższego punktu kości
  let dmin = Infinity;
  let r = 0;
  for (; r <= 40; r++) {
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (let c = -r; c <= r; c++) {
      if (r > 0 && Math.max(Math.abs(a), Math.abs(b), Math.abs(c)) !== r) continue;
      const l = kraty.get(kl(cx + a, cy + b, cz + c));
      if (!l) continue;
      for (const i of l) {
        const d = Math.hypot(chmura.x[i] - px, chmura.y[i] - py, chmura.z[i] - pz);
        if (d < dmin) dmin = d;
      }
    }
    if (dmin < r * KOM) break;
  }
  // etap 2: wszystkie punkty w promieniu zależnym od dmin, najlepszy wynik na kość rigu
  const prom = dmin * 1.7 + 10;
  const rr = Math.ceil(prom / KOM);
  wynikKosc.fill(0);
  for (let a = -rr; a <= rr; a++) for (let b = -rr; b <= rr; b++) for (let c = -rr; c <= rr; c++) {
    const l = kraty.get(kl(cx + a, cy + b, cz + c));
    if (!l) continue;
    for (const i of l) {
      const d = Math.hypot(chmura.x[i] - px, chmura.y[i] - py, chmura.z[i] - pz);
      if (d > prom) continue;
      const sila = 1 / (d + 2.5) ** 4;
      const w = chmura.w[i];
      const s0 = sila * w, s1 = sila * (1 - w);
      if (s0 > wynikKosc[chmura.b0[i]]) wynikKosc[chmura.b0[i]] = s0;
      if (s1 > wynikKosc[chmura.b1[i]]) wynikKosc[chmura.b1[i]] = s1;
    }
  }
  let i0 = 0, i1 = -1;
  for (let i = 1; i < wynikKosc.length; i++) if (wynikKosc[i] > wynikKosc[i0]) i0 = i;
  for (let i = 0; i < wynikKosc.length; i++) if (i !== i0 && wynikKosc[i] > 0 && (i1 < 0 || wynikKosc[i] > wynikKosc[i1])) i1 = i;
  if (i1 < 0) return [i0, i0, 1];
  return [i0, i1, wynikKosc[i0] / (wynikKosc[i0] + wynikKosc[i1])];
}

// ---------- 5. składanie warstw ----------
const WARSTWY = ['kosci', 'miesnie', 'narzady', 'naczynia', 'mozg', 'oczy', 'skora'];
const zb = Object.fromEntries(WARSTWY.map((w) => [w, { poz: [], nor: [], kol: [], rig: [], ind: [], ileW: 0 }]));
const opisCzesci = [];
let lp = 0;
for (const c of czesci) {
  const W = zb[c.klasa.warstwa];
  const p = c.m.poz;
  const n = normalne(c.m);
  const ileW = p.length / 3;
  const rig = new Uint8Array(ileW * 4);
  if (c.wagiStale) {
    for (let i = 0; i < ileW; i++) {
      rig[i * 4] = c.wagiStale[0];
      rig[i * 4 + 1] = c.wagiStale[1];
      rig[i * 4 + 2] = Math.round(c.wagiStale[2] * 255);
    }
  } else if (c.klasa.warstwa === 'mozg' || c.klasa.warstwa === 'oczy') {
    for (let i = 0; i < ileW; i++) {
      rig[i * 4] = NR.glowa;
      rig[i * 4 + 1] = NR.glowa;
      rig[i * 4 + 2] = 255;
    }
  } else {
    for (let i = 0; i < ileW; i++) {
      const wg = wagiMiekkie(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
      rig[i * 4] = wg[0];
      rig[i * 4 + 1] = wg[1];
      rig[i * 4 + 2] = Math.round(wg[2] * 255);
    }
  }
  // kolor z lekką różnicą jasności między częściami
  const jas = c.klasa.typ === 'miesien' ? 0.86 + ((lp * 37) % 29) / 100 : 1;
  const kol = c.klasa.kolor.map((v) => Math.min(255, Math.round(v * jas)));
  const wOd = W.ileW;
  const iOd = W.ind.length;
  for (let i = 0; i < ileW; i++) {
    W.poz.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    W.nor.push(Math.round(n[i * 3] * 127), Math.round(n[i * 3 + 1] * 127), Math.round(n[i * 3 + 2] * 127), 0);
    W.kol.push(kol[0], kol[1], kol[2], 255);
    W.rig.push(rig[i * 4], rig[i * 4 + 1], rig[i * 4 + 2], 0);
  }
  for (let i = 0; i < c.m.ind.length; i++) W.ind.push(c.m.ind[i] + wOd);
  W.ileW += ileW;
  c.rig = rig;
  c.nor = n;
  opisCzesci.push({ id: c.id, en: c.en, w: c.klasa.warstwa, typ: c.klasa.typ, wOd, wIle: ileW, iOd, iIle: c.m.ind.length });
  lp++;
  if (lp % 150 === 0) log('wagi i składanie', lp, '/', czesci.length);
}

// ---------- 6. kotwice podpisów ----------
// Nazwa bez strony ciała: wzorce mięśni dopasowują się do "long head of biceps brachii", nie do "... of left ...".
const bezStrony = (en) => en.replace(/\b(left|right) /, '');
const stronaCzesci = (en) => (/\bleft\b/.test(en) ? 'L' : /\bright\b/.test(en) ? 'P' : null);

// Przesłanianie mięśni. Promień wychodzi z punktu na powierzchni mięśnia w kierunku patrzenia; jeśli po drodze
// trafia w inny mięsień albo kość, to z tej strony mięsień leży pod spodem i kropka by myliła.
const KOSC_REKI = KOSCI_RIGU.map((n) => /^(ramie|przedramie|promien|dlon|srodrecze|blizszy|srodkowyp|dalszy)/.test(n));
const przeszkody = czesci
  // bez ścięgien i rozcięgien oraz bez mięśnia szerokiego szyi: to cienkie płaty, przez które mięśnie pod spodem widać
  .filter((c) => (c.klasa.warstwa === 'miesnie' && c.klasa.typ !== 'sciegno' && !/platysma/.test(c.en)) || c.klasa.warstwa === 'kosci')
  .map((c) => {
    const p = c.m.poz;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
    // część ręki: w spoczynku ręka wisi tuż obok tułowia i uda, więc dla promieni w bok nie jest przeszkodą
    let reka = 0;
    for (let i = 0; i < c.rig.length; i += 4) if (KOSC_REKI[c.rig[i + 2] >= 128 ? c.rig[i] : c.rig[i + 1]]) reka++;
    return { c, min, max, reka: reka > c.rig.length / 8 };
  });
// Strona, z której mięsień głęboki ma najbliżej na wierzch: z obrysu mięśni i kości tej samej części ciała (tułów
// z głową, ręka, noga) na wysokości środka mięśnia. Siatka skóry się do tego nie nadaje, bo ma też powierzchnie
// wewnątrz ciała.
const GRUPA_KOSCI = KOSCI_RIGU.map((n) => {
  const st = n.endsWith('L') ? 1 : n.endsWith('P') ? 2 : 0;
  if (/^(ramie|przedramie|promien|dlon|srodrecze|blizszy|srodkowyp|dalszy)/.test(n)) return st;
  if (/^(udo|podudzie|stopa)/.test(n)) return 2 + st;
  return 0;
});
const grupaWierzcholka = (c, i) => GRUPA_KOSCI[c.rig[i * 4 + 2] >= 128 ? c.rig[i * 4] : c.rig[i * 4 + 1]];
const chmuraGrupy = [[], [], [], [], []];
for (const c of czesci) {
  if (c.klasa.warstwa !== 'miesnie' && c.klasa.warstwa !== 'kosci') continue;
  const p = c.m.poz;
  for (let i = 0; i < p.length / 3; i += 3) chmuraGrupy[grupaWierzcholka(c, i)].push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
}
function stronyOdNajblizszej(sr, grupa, s) {
  const ch = chmuraGrupy[grupa];
  let xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < ch.length; i += 3) {
    if (Math.abs(ch[i + 1] - sr[1]) > 20) continue;
    // tułów: tylko ta połowa ciała, po której leży mięsień, żeby bok liczył się do własnego boku
    if (grupa === 0 && s !== 'S' && (s === 'L' ? ch[i] < -5 : ch[i] > 5)) continue;
    if (ch[i] < xmin) xmin = ch[i];
    if (ch[i] > xmax) xmax = ch[i];
    if (ch[i + 2] < zmin) zmin = ch[i + 2];
    if (ch[i + 2] > zmax) zmax = ch[i + 2];
  }
  const odl = [
    ['przod', zmax - sr[2]],
    ['tyl', sr[2] - zmin],
    ['bok', s === 'P' ? sr[0] - xmin : xmax - sr[0]],
  ];
  return odl.sort((a, b) => a[1] - b[1]).map((x) => x[0]);
}
function pierwszeTrafienie(o, d, pomin, zasieg, bezRak = false) {
  const kon = [o[0] + d[0] * zasieg, o[1] + d[1] * zasieg, o[2] + d[2] * zasieg];
  let naj = Infinity;
  for (const pr of przeszkody) {
    if (pomin.has(pr.c) || (bezRak && pr.reka)) continue;
    let poza = false;
    for (let k = 0; k < 3; k++) if (Math.max(o[k], kon[k]) < pr.min[k] || Math.min(o[k], kon[k]) > pr.max[k]) poza = true;
    if (poza) continue;
    const p = pr.c.m.poz, ind = pr.c.m.ind;
    for (let i = 0; i < ind.length; i += 3) {
      const a = ind[i] * 3, b = ind[i + 1] * 3, c = ind[i + 2] * 3;
      const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
      const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      const wyzn = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(wyzn) < 1e-9) continue;
      const odw = 1 / wyzn;
      const tx = o[0] - p[a], ty = o[1] - p[a + 1], tz = o[2] - p[a + 2];
      const u = (tx * px + ty * py + tz * pz) * odw;
      if (u < 0 || u > 1) continue;
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * odw;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * odw;
      if (tt > 0.8 && tt < zasieg && tt < naj) naj = tt;
    }
  }
  return naj;
}

// Kotwice mięśnia po jednej stronie ciała: dla widoku z przodu, z tyłu i z boku punkt na powierzchni zwróconej
// w tę stronę, jak najbliżej osi przechodzącej przez środek mięśnia (czyli środek brzuśca widziany z tego kierunku).
// Zostają tylko punkty, których z tej strony nic nie zasłania. Mięsień zasłonięty zewsząd dostaje jedną kotwicę
// od strony, z której ma najbliżej do skóry, i znacznik "gl" (głęboki): widać go tylko w rentgenie.
function kotwiceMiesnia(kand, s, pasuja, odslon = []) {
  const P = (k) => [k.c.m.poz[k.i * 3], k.c.m.poz[k.i * 3 + 1], k.c.m.poz[k.i * 3 + 2]];
  const N = (k) => [k.c.nor[k.i * 3], k.c.nor[k.i * 3 + 1], k.c.nor[k.i * 3 + 2]];
  const sr = [0, 0, 0];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const k of kand) {
    const p = P(k);
    for (let j = 0; j < 3; j++) {
      sr[j] += p[j] / kand.length;
      if (p[j] < min[j]) min[j] = p[j];
      if (p[j] > max[j]) max[j] = p[j];
    }
  }
  const rozmiar = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const bok = s === 'P' ? -1 : 1;
  const kierunki = [['przod', [0, 0, 1]], ['tyl', [0, 0, -1]], ['bok', [bok, 0, 0]]];
  const pomin = new Set(pasuja);
  let ileWRece = 0;
  for (const k of kand) if (KOSC_REKI[k.c.rig[k.i * 4 + 2] >= 128 ? k.c.rig[k.i * 4] : k.c.rig[k.i * 4 + 1]]) ileWRece++;
  const wRece = ileWRece > kand.length / 2;
  const wynik = [];
  const srodkowe = {};
  for (const [nazwa, D] of kierunki) {
    const oceny = [];
    for (const k of kand) {
      const n = N(k);
      if (iloczyn(n, D) < 0.35) continue;
      const d = odejmij(P(k), sr);
      const wzdluz = iloczyn(d, D);
      const obok = dlugosc(odejmij(d, razy(D, wzdluz)));
      if (obok > 0.45 * rozmiar) continue;
      oceny.push({ k, w: wzdluz - 1.1 * obok });
    }
    oceny.sort((a, b) => b.w - a.w);
    // Do pięciu punktów wokół środka mięśnia, każdy z własnym promieniem. Kierunek liczy się jako odsłonięty,
    // gdy przechodzi większość z nich: pojedyncza szczelina między mięśniami nie robi z głębokiego mięśnia widocznego.
    // Z przodu i z tyłu promień idzie przez całą grubość ciała; w bok krócej i z pominięciem części ręki, która
    // w spoczynku wisi tuż obok tułowia (chyba że sam mięsień jest częścią ręki).
    const probowane = [];
    let odsloniete = 0, pierwszy = null;
    for (const o of oceny) {
      if (probowane.length >= 5) break;
      const p = P(o.k);
      if (probowane.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < Math.max(8, rozmiar * 0.08))) continue;
      probowane.push(p);
      const tt = odslon.includes(nazwa) ? Infinity : pierwszeTrafienie(p, D, pomin, nazwa === 'bok' ? 140 : 400, nazwa === 'bok' && !wRece);
      const kot = { o, D, nazwa, tt };
      if (tt === Infinity) {
        odsloniete++;
        if (!pierwszy) pierwszy = kot;
      }
      // dla mięśnia głębokiego zapamiętujemy środkowy punkt każdego kierunku
      if (probowane.length === 1) srodkowe[nazwa] = kot;
    }
    if (pierwszy && odsloniete >= Math.ceil(probowane.length * 0.6)) wynik.push(pierwszy);
  }
  const gleboki = wynik.length === 0;
  let lista = wynik;
  if (gleboki) {
    // część ciała mięśnia z kości większości jego wierzchołków
    const ile = [0, 0, 0, 0, 0];
    for (const k of kand) ile[grupaWierzcholka(k.c, k.i)]++;
    const grupa = ile.indexOf(Math.max(...ile));
    const zapas = stronyOdNajblizszej(sr, grupa, s).map((n) => srodkowe[n]).find(Boolean);
    lista = zapas ? [zapas] : [];
  }
  return {
    rozmiar,
    gleboki,
    kotwice: lista.map(({ o, D, nazwa }) => {
      const c = o.k.c, i = o.k.i;
      // normalna kotwicy: średnia normalnej powierzchni i kierunku, z którego punkt jest odsłonięty
      const n = jednostkowy(dodaj(N(o.k), D));
      return {
        s,
        z: nazwa,
        p: P(o.k).map((v) => +v.toFixed(1)),
        n: n.map((v) => +v.toFixed(2)),
        rig: [c.rig[i * 4], c.rig[i * 4 + 1], +(c.rig[i * 4 + 2] / 255).toFixed(3)],
      };
    }),
  };
}

const etykiety = [];
let ileGlebokich = 0;
for (const e of ETYKIETY) {
  const pasuja = czesci.filter((c) => c.klasa.warstwa === e.w && (e.re.test(c.en) || e.re.test(bezStrony(c.en))));
  if (!pasuja.length) {
    console.warn('UWAGA: podpis bez części:', e.pl);
    continue;
  }
  const strony = e.strony === 'pary' ? ['L', 'P'] : ['S'];
  const kotwice = [];
  let rozmiar = 0, gleboki = true;
  for (const s of strony) {
    const kand = [];
    for (const c of pasuja) {
      const maStrone = stronaCzesci(c.en);
      if (s !== 'S' && maStrone && maStrone !== s) continue;
      const p = c.m.poz;
      for (let i = 0; i < p.length; i += 3) {
        if (s !== 'S' && !maStrone) {
          if (s === 'L' && p[i] < 3) continue;
          if (s === 'P' && p[i] > -3) continue;
        }
        kand.push({ c, i: i / 3 });
      }
    }
    if (!kand.length) continue;
    if (e.w === 'miesnie' && !e.kier) {
      const m = kotwiceMiesnia(kand, s, pasuja, e.odslon);
      kotwice.push(...m.kotwice);
      rozmiar = Math.max(rozmiar, m.rozmiar);
      if (!m.gleboki) gleboki = false;
      continue;
    }
    gleboki = false;
    const sr = [0, 0, 0];
    for (const k of kand) {
      sr[0] += k.c.m.poz[k.i * 3];
      sr[1] += k.c.m.poz[k.i * 3 + 1];
      sr[2] += k.c.m.poz[k.i * 3 + 2];
    }
    sr[0] /= kand.length;
    sr[1] /= kand.length;
    sr[2] /= kand.length;
    const kier = jednostkowy(s === 'P' ? [-e.kier[0], e.kier[1], e.kier[2]] : e.kier);
    let naj = null, najW = -Infinity;
    for (const k of kand) {
      const d = [k.c.m.poz[k.i * 3] - sr[0], k.c.m.poz[k.i * 3 + 1] - sr[1], k.c.m.poz[k.i * 3 + 2] - sr[2]];
      const wzdluz = iloczyn(d, kier);
      const bok = dlugosc(odejmij(d, razy(kier, wzdluz)));
      const w = wzdluz - 1.1 * bok;
      if (w > najW) {
        najW = w;
        naj = k;
      }
    }
    const c = naj.c;
    kotwice.push({
      s,
      p: [c.m.poz[naj.i * 3], c.m.poz[naj.i * 3 + 1], c.m.poz[naj.i * 3 + 2]].map((v) => +v.toFixed(1)),
      n: [c.nor[naj.i * 3], c.nor[naj.i * 3 + 1], c.nor[naj.i * 3 + 2]].map((v) => +v.toFixed(2)),
      rig: [c.rig[naj.i * 4], c.rig[naj.i * 4 + 1], +(c.rig[naj.i * 4 + 2] / 255).toFixed(3)],
    });
  }
  if (!kotwice.length) {
    console.warn('UWAGA: podpis bez kotwicy:', e.pl);
    continue;
  }
  const auto = e.w === 'miesnie' && !e.kier;
  if (auto && gleboki) ileGlebokich++;
  // Skala i ważność mięśni bez ręcznych wartości: podpis pojawia się, gdy mięsień ma na ekranie ok. 80 pikseli,
  // a większy i powierzchowny mięsień wygrywa z mniejszym i głębokim, gdy w kolumnie brakuje miejsca.
  const skala = e.skala || [+ogranicz((80 / Math.max(rozmiar, 1)) * (gleboki ? 1.4 : 1), 0.22, 2.6).toFixed(2), 99];
  const waga = e.waga ?? ogranicz(Math.round(1 + 4 * Math.min(1, rozmiar / 320)) + (gleboki ? -1 : 1), 1, 7);
  etykiety.push({ pl: e.pl, w: e.w, skala, waga, kotwice, ...(auto && gleboki ? { gl: 1 } : {}) });
}
log('mięśni zasłoniętych z każdej strony', ileGlebokich);
log('podpisy', etykiety.length);

// ---------- 7. zapis ----------
fs.mkdirSync(WYJ, { recursive: true });
const kawalki = [];
let przes = 0;
const dopisz = (tab) => {
  const b = Buffer.from(tab.buffer, tab.byteOffset, tab.byteLength);
  const od = przes;
  kawalki.push(b);
  przes += b.length;
  const dop = (4 - (przes % 4)) % 4;
  if (dop) {
    kawalki.push(Buffer.alloc(dop));
    przes += dop;
  }
  return od;
};
const warstwyOpis = {};
for (const w of WARSTWY) {
  const W = zb[w];
  warstwyOpis[w] = {
    wierzcholki: W.ileW,
    trojkaty: W.ind.length / 3,
    poz: dopisz(new Float32Array(W.poz)),
    nor: dopisz(new Int8Array(W.nor)),
    kol: dopisz(new Uint8Array(W.kol)),
    rig: dopisz(new Uint8Array(W.rig)),
    ind: dopisz(new Uint32Array(W.ind)),
  };
  log(w, 'wierzchołków', W.ileW, 'trójkątów', W.ind.length / 3);
}
fs.writeFileSync(path.join(WYJ, 'cialo.bin'), Buffer.concat(kawalki));
const zaokr = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)));
// wagi punktów twarzy: górna część twarzy jest sztywna, dół rusza się z żuchwą i mimiką
const twarzWagi = kanon.map((p) => (p[1] > -20 ? 1 : p[1] > -45 ? 0.3 : 0.05));
fs.writeFileSync(
  path.join(WYJ, 'cialo.json'),
  JSON.stringify({
    wersja: 1,
    zrodlo: 'BodyParts3D 3.0, (c) The Database Center for Life Science, CC BY-SA 2.1 Japan',
    kosciRigu: KOSCI_RIGU,
    warstwy: warstwyOpis,
    czesci: opisCzesci,
    stawy: zaokr(staw),
    twarz: { punkty: twarzPunkty.map((p) => p.map((v) => +v.toFixed(2))), wagi: twarzWagi },
    etykiety,
  }),
);
log('zapisano', (przes / 1e6).toFixed(1), 'MB');
