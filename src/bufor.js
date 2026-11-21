// Bufor obserwacji. Trzyma surowe wyniki śledzenia z kilkunastu ostatnich klatek i oddaje wynik dla klatki
// sprzed D klatek. Dzięki temu dla wyświetlanej klatki znamy też kilka następnych, więc:
//  - wygładzamy oknem symetrycznym, czyli bez opóźnienia względem obrazu tej klatki,
//  - krótką przerwę w śledzeniu (dłoń albo twarz zgubiona na kilka klatek) wypełniamy z obu stron,
//  - wiemy z wyprzedzeniem, że coś zaraz zniknie, i zdążymy to wygasić.
// Przy D = 0 bufor działa jak zwykły filtr przyczynowy (bez opóźnienia obrazu, ale z gorszym wygładzaniem).
import { slerp } from './matma.js';
import { FiltrPunktowOdporny } from './filtry.js';

// wagi Savitzky'ego-Golaya (wielomian 2. stopnia): wygładzają szum, a nie spłaszczają ruchu
const SG = [
  [1],
  [0.25, 0.5, 0.25],
  [-3, 12, 17, 12, -3].map((v) => v / 35),
  [-2, 3, 6, 7, 6, 3, -2].map((v) => v / 21),
  [-21, 14, 39, 54, 59, 54, 39, 14, -21].map((v) => v / 231),
  [-36, 9, 44, 69, 84, 89, 84, 69, 44, 9, -36].map((v) => v / 429),
];
// odchylenie różnicy (SG - średnia) dla szumu o odchyleniu 1, dla promienia okna 0..5
const ODCH_ROZNICY = [0, 0.2041, 0.5345, 0.4364, 0.3801, 0.3411];
const MAKS_PRZERWA = 6; // najdłuższa przerwa w klatkach (odstęp między sąsiednimi wykryciami), którą wypełniamy
const ogranicz = (v, a, b) => Math.min(b, Math.max(a, v));

function mieszajPunkty(a, b, u) {
  const n = Math.min(a.length, b.length);
  const w = new Array(n);
  for (let i = 0; i < n; i++) w[i] = [a[i][0] + (b[i][0] - a[i][0]) * u, a[i][1] + (b[i][1] - a[i][1]) * u, a[i][2] + (b[i][2] - a[i][2]) * u];
  return w;
}

class StanKanalu {
  // maksR: największy promień okna wygładzania; adaptacja: czy przy dużym szumie zastępować wygładzanie zwykłą średnią
  constructor(parametry, { maksR = 5, adaptacja = true } = {}) {
    this.filtr = new FiltrPunktowOdporny(parametry);
    this.maksR = maksR;
    this.adaptacja = adaptacja;
    this.zeruj();
  }
  zeruj() {
    this.filtr.zeruj();
    this.szum2 = null; // wariancja szumu każdego punktu (piksele do kwadratu)
    this.ileSzumu = 0;
    this.ostatniNr = -1;
  }
}

export class Bufor {
  constructor() {
    this.kl = [];
    this.maks = 18;
    this.kanaly = {
      poza: new StanKanalu({ min: 1.1, beta: 0.06, minZ: 0.45, betaZ: 0.003 }),
      dlon0: new StanKanalu({ min: 4, beta: 0.2, minZ: 1.5, betaZ: 0.03 }, { maksR: 2 }),
      dlon1: new StanKanalu({ min: 4, beta: 0.2, minZ: 1.5, betaZ: 0.03 }, { maksR: 2 }),
    };
    this.zeruj();
  }

  zeruj() {
    this.kl.length = 0;
    this.licznik = 0;
    this.ostatniOdczyt = -1;
    for (const k of Object.values(this.kanaly)) k.zeruj();
  }

  // rekord: { t, klatka, poza: {p, w} | null, twarz: {q, skala, c, zuchwa, p} | null, dlonie: [{p, strona} | null, {…} | null] }
  dodaj(rekord) {
    rekord.nr = this.licznik++;
    this.kl.push(rekord);
    if (this.kl.length > this.maks) this.kl.shift();
  }
  get ile() {
    return this.kl.length;
  }

  // Wynik dla klatki sprzed D klatek (D = 0: najnowsza). opcje: { dlugiBok } dłuższy bok obrazu w pikselach sceny.
  odczyt(D, opcje) {
    const n = this.kl.length;
    if (!n) return null;
    return this._wynik(Math.max(0, n - 1 - D), D, opcje);
  }
  // Do opróżniania bufora na końcu eksportu: klatka o k bliżej końca niż zwykły odczyt.
  odczytKoncowy(D, k, opcje) {
    const n = this.kl.length;
    if (!n) return null;
    return this._wynik(ogranicz(n - 1 - D + k, 0, n - 1), D, opcje);
  }

  _wynik(i, D, opcje = {}) {
    const kl = this.kl;
    const rek = kl[i];
    const pierwszyRaz = rek.nr !== this.ostatniOdczyt;
    let dt = 1 / 30;
    if (i > 0 && pierwszyRaz) dt = ogranicz(rek.t - kl[i - 1].t, 1 / 120, 0.2);
    this.ostatniOdczyt = rek.nr;
    const dlugiBok = opcje.dlugiBok || 1920;
    const wyn = { nr: rek.nr, t: rek.t, dt, klatka: rek.klatka, surowe: rek, poza: null, twarz: null, dlonie: [], wid: { poza: 1, twarz: 1 } };

    // sylwetka
    // punkty słabo widoczne (poza kadrem, zasłonięte) model zgaduje i mocno nimi trzęsie: dostają większą bezwładność
    const ufnosc = rek.poza?.w ? rek.poza.w.map((w) => 0.12 + 0.88 * ogranicz((w - 0.45) / 0.4, 0, 1)) : null;
    // wyjątek: nogi. Model daje im niską widoczność także wtedy, gdy są całe w kadrze (ciemne spodnie), a z dużą
    // bezwładnością spóźniałyby się za krokiem. Gdy biodro tej strony jest pewne, punkty nogi nie są hamowane.
    if (ufnosc) {
      for (const [biodro, punkty] of [[23, [25, 27, 29, 31]], [24, [26, 28, 30, 32]]]) {
        if (rek.poza.w[biodro] > 0.6) for (const p of punkty) ufnosc[p] = Math.max(ufnosc[p], 0.55);
      }
    }
    const pz = this._punkty('poza', (k) => kl[k].poza?.p, i, D, dt, pierwszyRaz, 0.035 * dlugiBok, ufnosc);
    if (pz) {
      // widoczność punktów: średnia z okna, żeby progi nie migały
      const w = new Array(33).fill(0);
      let ile = 0;
      for (let k = Math.max(0, i - pz.r); k <= Math.min(kl.length - 1, i + pz.r); k++) {
        const ww = kl[k].poza?.w;
        if (!ww) continue;
        for (let j = 0; j < 33; j++) w[j] += ww[j];
        ile++;
      }
      const wPoza = ile ? w.map((v) => v / ile) : (rek.poza?.w || w);
      wyn.poza = { p: pz.p, w: wPoza, v: pz.v };
      wyn.wid.poza = pz.wid;
    }
    // dłonie: dwa tory
    for (let s = 0; s < 2; s++) {
      const dl = this._punkty('dlon' + s, (k) => (this._dlonTrwala(s, k) ? kl[k].dlonie[s].p : null), i, D, dt, pierwszyRaz, 0.06 * dlugiBok);
      if (!dl) continue;
      // strona z najbliższej klatki, w której dłoń była naprawdę wykryta
      let strona = null;
      for (let o = 0; o < kl.length && !strona; o++) strona = kl[i - o]?.dlonie?.[s]?.strona || kl[i + o]?.dlonie?.[s]?.strona || null;
      wyn.dlonie.push({ p: dl.p, v: dl.v, strona, tor: s, wid: dl.wid });
    }
    // twarz
    wyn.twarz = this._twarz(i, D, dt);
    if (wyn.twarz) wyn.wid.twarz = wyn.twarz.wid;
    return wyn;
  }

  // Dłoń wykryta tylko na klatce albo dwóch to w szybkim ruchu zwykle pomyłka: model dłoni łapie rozmazany ślad
  // w starym miejscu i na chwilę przyciąga do siebie nadgarstek. Liczy się dłoń, która w sąsiednich klatkach
  // (6 wstecz, 2 w przód) pojawia się co najmniej 3 razy. Dłoń szybko migającą, np. w języku migowym, to zostawia.
  _dlonTrwala(s, k) {
    const kl = this.kl;
    if (!kl[k]?.dlonie?.[s]) return false;
    let jest = 0, okno = 0;
    for (let j = Math.max(0, k - 6); j <= Math.min(kl.length - 1, k + 2); j++) {
      okno++;
      if (kl[j].dlonie?.[s]) jest++;
    }
    return jest >= Math.min(3, okno);
  }

  // Próbka kanału w klatce k: surowa, a w krótkiej przerwie wyliczona z sąsiadów po obu stronach. null, gdy jej nie ma.
  _wypelniona(g, k, mieszaj) {
    const kl = this.kl;
    if (k < 0 || k >= kl.length) return null;
    const x = g(k);
    if (x) return x;
    let p = k - 1;
    while (p >= 0 && k - p < MAKS_PRZERWA && !g(p)) p--;
    if (p < 0 || !g(p)) return null;
    let q = k + 1;
    while (q < kl.length && q - p <= MAKS_PRZERWA && !g(q)) q++;
    if (q >= kl.length || q - p > MAKS_PRZERWA || !g(q)) return null;
    const u = (kl[k].t - kl[p].t) / Math.max(1e-6, kl[q].t - kl[p].t);
    return mieszaj(g(p), g(q), ogranicz(u, 0, 1));
  }

  // Wygładzony zestaw punktów dla klatki i. Zwraca { p, v, r, wid } albo null.
  _punkty(nazwa, g, i, D, dt, pierwszyRaz, progSkoku, ufnosc = null) {
    const kl = this.kl;
    const n = kl.length;
    const stan = this.kanaly[nazwa];
    const pamiec = new Map();
    const W = (k) => {
      if (!pamiec.has(k)) pamiec.set(k, this._wypelniona(g, k, mieszajPunkty));
      return pamiec.get(k);
    };
    const x0 = W(i);
    if (!x0) {
      stan.zeruj();
      return null;
    }
    const ileP = x0.length;
    if (stan.ostatniNr >= 0 && kl[i].nr - stan.ostatniNr > 1) stan.zeruj(); // kanał wrócił po przerwie
    // zasięg okna: tyle klatek w tył i w przód, ile jest ciągłych danych
    let rp = 0;
    while (rp < 7 && W(i - rp - 1)) rp++;
    let rf = 0;
    while (rf < D && W(i + rf + 1)) rf++;
    const r = Math.min(rp, rf, stan.maksR);

    // szum każdego punktu z drugiej różnicy surowych próbek (nie zależy od prędkości ruchu)
    if (!stan.szum2 || stan.szum2.length !== ileP) {
      stan.szum2 = new Float64Array(ileP);
      stan.ileSzumu = 0;
    }
    if (pierwszyRaz && rp >= 1 && rf >= 1) {
      const a = W(i - 1), b = W(i + 1);
      stan.ileSzumu++;
      const al = Math.max(1 - Math.exp(-dt / 1.5), 1 / stan.ileSzumu);
      for (let j = 0; j < ileP; j++) {
        const rx = x0[j][0] - 0.5 * (a[j][0] + b[j][0]);
        const ry = x0[j][1] - 0.5 * (a[j][1] + b[j][1]);
        const r2 = (rx * rx + ry * ry) / 3;
        // Pierwsze pomiary uśredniamy. Potem próbka dużo większa od dotychczasowego szumu to raczej prawdziwy,
        // gwałtowny ruch niż szum, więc tylko lekko podnosi ocenę (gdyby szum naprawdę urósł, ocena go dogoni).
        if (stan.ileSzumu <= 8) stan.szum2[j] += (Math.min(r2, 4 * stan.szum2[j] + 400) - stan.szum2[j]) * al;
        else if (r2 < 3 * stan.szum2[j] + 1) stan.szum2[j] += (r2 - stan.szum2[j]) * al;
        else stan.szum2[j] *= 1.03;
      }
    }
    // Skok punktu na jedną albo dwie klatki i z powrotem (model na chwilę „widzi” dłoń albo staw gdzie indziej)
    // zastępujemy medianą z sąsiednich klatek: z pięciu, gdy po obu stronach są po dwie, inaczej z trzech.
    const C = (k) => {
      const x = W(k);
      let m = 0;
      while (m < 2 && W(k - m - 1) && W(k + m + 1)) m++;
      if (!m) return x;
      const probki = [];
      for (let o = -m; o <= m; o++) probki.push(W(k + o));
      let wyn = null;
      const wart = new Array(2 * m + 1);
      for (let j = 0; j < ileP; j++) {
        const prog = Math.max(progSkoku, 6 * Math.sqrt(stan.szum2[j]));
        for (let o = 0; o < 2; o++) {
          for (let q = 0; q <= 2 * m; q++) wart[q] = probki[q][j][o];
          wart.sort((a, b) => a - b);
          const med = wart[m];
          if (Math.abs(x[j][o] - med) > prog) {
            if (!wyn) wyn = x.map((p) => [p[0], p[1], p[2]]);
            wyn[j][o] = med;
          }
        }
      }
      return wyn || x;
    };
    const okno = [];
    for (let k = -r; k <= r; k++) okno.push(C(i + k));
    const sg = SG[r];
    const rowne = 1 / (2 * r + 1);
    // prędkość z prostej dopasowanej do okna (więcej klatek wstecz niż w przód): mniej szumu niż z różnicy dwóch klatek
    const od = Math.max(-rp, -6), dok = rf;
    const ileK = dok - od + 1;
    const srK = (od + dok) / 2;
    let skk = 0;
    for (let k = od; k <= dok; k++) skk += (k - srK) * (k - srK);
    const pr = [];
    if (ileK >= 2) for (let k = od; k <= dok; k++) pr.push(k >= -r && k <= r ? okno[k + r] : W(i + k));

    const p = new Array(ileP);
    const v = new Float64Array(ileP);
    for (let j = 0; j < ileP; j++) {
      let sx = 0, sy = 0, bx = 0, by = 0, bz = 0;
      for (let k = 0; k <= 2 * r; k++) {
        const q = okno[k][j];
        sx += sg[k] * q[0];
        sy += sg[k] * q[1];
        bx += q[0];
        by += q[1];
        bz += q[2];
      }
      bx *= rowne;
      by *= rowne;
      bz *= rowne;
      const szum = Math.sqrt(stan.szum2[j]);
      // gdy różnica między wygładzaniem zachowującym ruch a zwykłą średnią mieści się w szumie, bierzemy średnią
      let udzial = 1;
      if (stan.adaptacja && r >= 1 && szum > 0.05) udzial = ogranicz((Math.hypot(sx - bx, sy - by) / (ODCH_ROZNICY[r] * szum) - 1.5) / 2.5, 0, 1);
      let wx = bx + (sx - bx) * udzial, wy = by + (sy - by) * udzial;
      // Zachowanie gwałtownych ruchów: jeśli wygładzanie przesunęło punkt dużo dalej, niż tłumaczy szum,
      // to ścięło prawdziwy ruch (np. szybkie otwarcie dłoni), więc wracamy w stronę surowego punktu.
      if (r >= 1) {
        const q0 = okno[r][j];
        const odchyl = Math.hypot(q0[0] - wx, q0[1] - wy);
        const zaufaj = ogranicz((odchyl - (2.5 * szum + 2)) / (3.5 * szum + 4), 0, 1);
        wx += (q0[0] - wx) * zaufaj;
        wy += (q0[1] - wy) * zaufaj;
      }
      p[j] = [wx, wy, bz];
      if (ileK >= 2) {
        let vx = 0, vy = 0;
        for (let k = od; k <= dok; k++) {
          const q = pr[k - od][j];
          vx += (k - srK) * q[0];
          vy += (k - srK) * q[1];
        }
        const pred = Math.hypot(vx, vy) / skk / dt;
        const szumPred = (2.2 * szum) / Math.sqrt(skk) / dt;
        // prędkość chwilowa z dwóch sąsiednich klatek: prosta przez całe okno gubi szybki ruch tam i z powrotem
        const qa = rp >= 1 ? pr[-1 - od][j] : pr[-od][j];
        const qb = rf >= 1 ? pr[1 - od][j] : pr[-od][j];
        const ileOdst = (rp >= 1 ? 1 : 0) + (rf >= 1 ? 1 : 0);
        const chwil = ileOdst ? Math.hypot(qb[0] - qa[0], qb[1] - qa[1]) / ileOdst / dt : 0;
        const szumChwil = ileOdst ? (2.2 * szum * Math.SQRT2) / ileOdst / dt : 0;
        v[j] = Math.max(0, pred - szumPred, chwil - szumChwil) * (ufnosc ? ufnosc[j] : 1);
      }
    }
    stan.ostatniNr = kl[i].nr;
    const wyn = stan.filtr.filtruj(p, v, dt);
    return { p: wyn, v, r, wid: this._wid((k) => !!W(k), i, D) };
  }

  // 1, gdy kanał jest dostępny w całym oknie do przodu; mniej, gdy za chwilę zniknie
  _wid(jest, i, D) {
    if (D < 1) return 1;
    const n = this.kl.length;
    for (let k = i + 1; k < n && k <= i + D; k++) if (!jest(k)) return ogranicz((k - i) / D, 0, 1);
    return 1;
  }

  _twarz(i, D, dt) {
    const kl = this.kl;
    const g = (k) => kl[k].twarz;
    const mieszaj = (a, b, u) => ({
      q: slerp(a.q, b.q, u),
      skala: a.skala + (b.skala - a.skala) * u,
      c: [a.c[0] + (b.c[0] - a.c[0]) * u, a.c[1] + (b.c[1] - a.c[1]) * u, a.c[2] + (b.c[2] - a.c[2]) * u],
      zuchwa: a.zuchwa + (b.zuchwa - a.zuchwa) * u,
      p: null,
    });
    const pamiec = new Map();
    const W = (k) => {
      if (!pamiec.has(k)) pamiec.set(k, this._wypelniona(g, k, mieszaj));
      return pamiec.get(k);
    };
    const x0 = W(i);
    if (!x0) return null;
    let rp = 0;
    while (rp < 6 && W(i - rp - 1)) rp++;
    let rf = 0;
    while (rf < D && W(i + rf + 1)) rf++;
    const r = Math.min(rp, rf, 5);
    const sg = SG[r];
    const rowne = 1 / (2 * r + 1);
    const q = [0, 0, 0, 0];
    const c = [0, 0, 0];
    let skala = 0, zuchwa = 0;
    for (let k = -r; k <= r; k++) {
      const x = W(i + k);
      const w = sg[k + r];
      const znak = x.q[0] * x0.q[0] + x.q[1] * x0.q[1] + x.q[2] * x0.q[2] + x.q[3] * x0.q[3] < 0 ? -1 : 1;
      for (let o = 0; o < 4; o++) q[o] += w * znak * x.q[o];
      c[0] += w * x.c[0];
      c[1] += w * x.c[1];
      c[2] += rowne * x.c[2];
      skala += w * x.skala;
      zuchwa += w * x.zuchwa;
    }
    const dq = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    // prędkość środka twarzy z prostej przez okno
    const od = -rp, dok = rf;
    let v = 0;
    if (dok > od) {
      const srK = (od + dok) / 2;
      let skk = 0, vx = 0, vy = 0;
      for (let k = od; k <= dok; k++) {
        const x = W(i + k);
        skk += (k - srK) * (k - srK);
        vx += (k - srK) * x.c[0];
        vy += (k - srK) * x.c[1];
      }
      v = Math.hypot(vx, vy) / skk / dt;
    }
    return {
      q: q.map((x) => x / dq),
      skala,
      c,
      zuchwa: Math.max(0, zuchwa),
      v,
      p: kl[i].twarz?.p || null,
      wid: this._wid((k) => !!W(k), i, D),
    };
  }
}
