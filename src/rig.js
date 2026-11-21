// Rig: z punktów śledzenia (układ sceny: piksele, Y w górę, Z do kamery) liczy macierze kości.
// Każda kość rigu dostaje macierz 4x4, która przenosi geometrię z pozycji spoczynkowej (mm) na ekran.
//
// Trzy zasady, które trzymają obraz bez przeskoków:
//  1. Głębia z modelu sylwetki jest niepewna (w zbliżeniu zmienia się losowo z klatki na klatkę), więc bierzemy z niej
//     tylko mocno wygładzoną stronę wychylenia, a wielkość liczymy ze skrótu perspektywicznego przy znanej długości kości.
//  2. Ustawienie głowy wygładzamy wokół środka twarzy, a nie wokół początku układu modelu.
//  3. Gdy kość zmienia źródło (np. dłoń z modelu dłoni na dłoń z sylwetki), różnicę między starym a nowym ustawieniem
//     wygaszamy w ćwierć sekundy, zamiast przeskakiwać.
import {
  odejmij, razy, iloczyn, wektorowy, dlugosc, odleglosc, mieszaj, jednostkowy, prostopadly, ogranicz, gladki,
  dopasujPodobienstwo, obrotZKwaternionu, obrotWokolOsi, slerp, mnozR, mnozRT, qMnoz, qSprzezony,
  m4Jednostkowa, m4ZLiniowej, m4Mnoz, m4Punkt, m4Kierunek, m4Odcinka, m4OdwrotnaAfiniczna, ukladZOsi,
} from './matma.js';
import { FiltrEuro } from './filtry.js';
import { rozstawOpuszkow, srodekOpuszkow } from './dlonie.js';

// numery punktów sylwetki MediaPipe
const PZ = {
  L: { bark: 11, lokiec: 13, nadg: 15, maly: 17, wsk: 19, kciuk: 21, biodro: 23, kolano: 25, kostka: 27, pieta: 29, palec: 31, oko: 2, ucho: 7 },
  P: { bark: 12, lokiec: 14, nadg: 16, maly: 18, wsk: 20, kciuk: 22, biodro: 24, kolano: 26, kostka: 28, pieta: 30, palec: 32, oko: 5, ucho: 8 },
};
// o ile milimetrów ciała przed płaszczyzną barków leży nadgarstek ręki wysuniętej przed tułów (mostek modelu jest
// ok. 125 mm przed barkami, nos ok. 145 mm; reszta to zapas na palce zgięte do tyłu)
const WYSUN_REKI = 300;
// punkty dłoni MediaPipe dla każdego palca
const PALCE = [
  ['kciuk', [1, 2, 3, 4]],
  ['wskazujacy', [5, 6, 7, 8]],
  ['srodkowy', [9, 10, 11, 12]],
  ['serdeczny', [13, 14, 15, 16]],
  ['maly', [17, 18, 19, 20]],
];
const OSIE = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const CZAS_PRZEJSCIA = 0.26; // sekundy, w których znika różnica po zmianie źródła kości
const srodek = (a, b) => mieszaj(a, b, 0.5);
const odl2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const alfa = (odciecie, dt) => 1 / (1 + 1 / (2 * Math.PI * odciecie) / dt);

export class Rig {
  constructor(opis) {
    this.opis = opis;
    this.nazwy = opis.kosciRigu;
    this.n = this.nazwy.length;
    this.nr = Object.fromEntries(this.nazwy.map((n, i) => [n, i]));
    this.macierze = new Float32Array(this.n * 16);
    this.widok = new Float32Array(this.n);
    this.cel = new Float32Array(this.n);
    this.skala = new Float32Array(this.n); // piksele na milimetr dla każdej kości
    // poprawka perspektywy: dla każdej kości głębia odniesienia i włącznik (głowa i tułów)
    this.glebia = new Float32Array(this.n * 2);
    this.persp = [960, 540, 1500]; // środek obrazu x, y i ogniskowa w pikselach
    this.mnoznikOgniskowej = 1; // kalibracja z twarzy, względem ogniskowej bazowej
    // przejścia: źródło każdej kości, różnica do wygaszenia i jej postęp
    this.tryb = new Int8Array(this.n);
    this.roznica = new Float32Array(this.n * 16);
    this.zanik = new Float32Array(this.n);
    this.ostatnio = new Int32Array(this.n).fill(-10);
    this.nrKlatki = 0;
    for (let i = 0; i < this.n; i++) m4Jednostkowa(this.macierze.subarray(i * 16, i * 16 + 16));
    const s = (this.s = opis.stawy);
    // punkt bioder w spoczynku: MediaPipe stawia biodra szerzej niż środki głów kości udowych
    this.biodro0 = { L: [88, s.biodroL[1], s.biodroL[2]], P: [-88, s.biodroP[1], s.biodroP[2]] };
    this.Ot0 = srodek(s.barkL, s.barkP);
    this.Op0 = srodek(this.biodro0.L, this.biodro0.P);
    this.szerBark0 = odleglosc(s.barkL, s.barkP);
    this.szerBioder0 = odleglosc(this.biodro0.L, this.biodro0.P);
    this.dlTul0 = odleglosc(this.Ot0, this.Op0);
    this.srodekGlowy0 = srodek(s.uchoL, s.uchoP);
    this.szyja0 = [0, s.yC1, s.uchoL[2] - 12];
    this.dlSzyi0 = Math.hypot(this.srodekGlowy0[0] - this.Ot0[0], this.srodekGlowy0[1] - this.Ot0[1]);
    this.dl0 = {};
    for (const st of ['L', 'P']) {
      this.dl0['ram' + st] = odleglosc(s['bark' + st], s['lokiec' + st]);
      this.dl0['prz' + st] = odleglosc(s['lokiec' + st], s['nadgarstek' + st]);
      this.dl0['udo' + st] = odleglosc(this.biodro0[st], s['kolano' + st]);
      this.dl0['pod' + st] = odleglosc(s['kolano' + st], s['kostka' + st]);
    }
    this.twarz0 = opis.twarz.punkty;
    this.twarzWagi = opis.twarz.wagi;
    {
      // środek sztywnej części twarzy (głębia odniesienia dla perspektywy głowy) i środek ważony wszystkich punktów:
      // wokół niego dopasowanie twarzy jest najpewniejsze, więc to on jest punktem, który wygładzamy
      const c = [0, 0, 0], cw = [0, 0, 0];
      let n = 0, sw = 0;
      this.twarz0.forEach((p, i) => {
        const w = this.twarzWagi[i];
        sw += w;
        for (let k = 0; k < 3; k++) cw[k] += p[k] * w;
        if (w >= 1) {
          for (let k = 0; k < 3; k++) c[k] += p[k];
          n++;
        }
      });
      this.srodekTwarzy0 = c.map((v) => v / n);
      this.osTwarzy0 = cw.map((v) => v / sw);
    }
    // Kolejność „dziecko po rodzicu”: kość, której w danej klatce nie da się ustawić, jedzie na rodzicu (i jest wygaszona).
    // Bez tego mięśnie i skóra rozpięte między widoczną kością a zapomnianą rozciągają się w smugi przez pół kadru.
    this.rodzice = [['miednica', 'klatka']];
    for (const st of ['L', 'P']) {
      this.rodzice.push(['ramie' + st, 'klatka'], ['przedramie' + st, 'ramie' + st], ['promien' + st, 'przedramie' + st], ['dlon' + st, 'przedramie' + st]);
      for (const [palec] of PALCE) {
        this.rodzice.push([`srodrecze_${palec}${st}`, 'dlon' + st], [`blizszy_${palec}${st}`, 'dlon' + st], [`dalszy_${palec}${st}`, 'dlon' + st]);
        if (palec !== 'kciuk') this.rodzice.push([`srodkowyp_${palec}${st}`, 'dlon' + st]);
      }
      this.rodzice.push(['udo' + st, 'miednica'], ['podudzie' + st, 'udo' + st], ['stopa' + st, 'podudzie' + st]);
    }
    this.rodzice = this.rodzice.map(([d, r]) => [this.nr[d], this.nr[r], d]);
    // kości przedramienia i dłoni każdej strony: gasną szybciej niż reszta, gdy śledzenie je zgubi
    this.kosciReki = { L: [], P: [] };
    for (const st of ['L', 'P']) {
      const lista = ['przedramie' + st, 'promien' + st, 'dlon' + st];
      for (const [palec] of PALCE) {
        lista.push(`srodrecze_${palec}${st}`, `blizszy_${palec}${st}`, `dalszy_${palec}${st}`);
        if (palec !== 'kciuk') lista.push(`srodkowyp_${palec}${st}`);
      }
      this.kosciReki[st] = lista.map((n) => this.nr[n]);
    }
    this.szybkoGasnie = new Uint8Array(this.n);
    for (const st of ['L', 'P']) for (const i of this.kosciReki[st]) this.szybkoGasnie[i] = 1;
    // Punkt odniesienia każdej kości (w spoczynku) i największa odległość w milimetrach ciała, którą przejście może
    // pokonać płynnie. Dalej kość ustawia się od razu: szybka dłoń nie ma „dolatywać” z miejsca sprzed kilku klatek.
    this.punkt0 = new Array(this.n).fill(null);
    this.zasieg0 = new Float32Array(this.n).fill(90);
    const odn = (nazwa, p, zasieg) => {
      this.punkt0[this.nr[nazwa]] = p;
      this.zasieg0[this.nr[nazwa]] = zasieg;
    };
    odn('klatka', this.Ot0, 140);
    odn('miednica', this.Op0, 140);
    odn('glowa', this.osTwarzy0, 140);
    odn('zuchwa', this.osTwarzy0, 140);
    for (const st of ['L', 'P']) {
      odn('ramie' + st, s['bark' + st], 90);
      odn('przedramie' + st, s['lokiec' + st], 90);
      odn('promien' + st, s['lokiec' + st], 90);
      odn('udo' + st, this.biodro0[st], 90);
      odn('podudzie' + st, s['kolano' + st], 90);
      odn('stopa' + st, s['kostka' + st], 90);
      const rd = s['dlon' + st];
      odn('dlon' + st, rd.nadgarstek, 45);
      for (const [palec] of PALCE) {
        const rp = rd.palce[palec];
        odn(`srodrecze_${palec}${st}`, rp.podstawa, 45);
        odn(`blizszy_${palec}${st}`, rp.mcp, 45);
        if (palec !== 'kciuk') odn(`srodkowyp_${palec}${st}`, rp.pip, 45);
        odn(`dalszy_${palec}${st}`, palec === 'kciuk' ? rp.ip : rp.dip, 45);
      }
    }
    // Żuchwa: kąt otwarcia liczymy z położenia punktów brody względem czaszki (obrót wokół osi stawów
    // skroniowo-żuchwowych), a nie z ogólnego wskaźnika mimiki. Dla każdego punktu trzymamy jego promień w spoczynku.
    this.osZuchwy0 = jednostkowy(odejmij(s.zuchwaOsL, s.zuchwaOsP));
    this.srodekOsiZuchwy0 = srodek(s.zuchwaOsL, s.zuchwaOsP);
    this.punktyZuchwy = [152, 175, 199, 200, 148, 377, 176, 400, 18].map((i) => ({
      i,
      v0: prostopadly(odejmij(this.twarz0[i], this.srodekOsiZuchwy0), this.osZuchwy0),
    }));
    this.info = {}; // dane dla podpisów, odsłony i panelu śledzenia
    this.zeruj(true);
  }

  // Czyści pamięć między klatkami. Po zerowaniu najbliższa klatka ustawia wszystko od razu, bez przejść.
  zeruj(pelne = false) {
    const lg = this.pam?.lgOgn, ile = this.pam?.ileOgn, zero = this.pam?.zeroZuchwy, kBark = this.pam?.kBark;
    this.pam = {}; // pamięć między klatkami (osie zawiasów, skala)
    if (!pelne && lg !== undefined) {
      this.pam.lgOgn = lg;
      this.pam.ileOgn = ile;
    }
    if (!pelne && zero !== undefined) this.pam.zeroZuchwy = zero;
    if (!pelne && kBark !== undefined) this.pam.kBark = kBark;
    if (pelne) this.mnoznikOgniskowej = 1;
    this.filtry = {};
    this.gladkie = {};
    this.wl = {};
    this.glowa = null; // { q, skala, c } po wygładzeniu
    this.kor = null; // poprawka głowy liczonej z punktów sylwetki, wyuczona, gdy widać też twarz
    this.relPalcow = { L: null, P: null };
    this.tryb.fill(0);
    this.zanik.fill(0);
    this.ostatnio.fill(-10);
    this.ciecie = true;
  }

  // Zapisuje macierz kości. tryb mówi, z jakiego źródła pochodzi; przy zmianie źródła różnica znika płynnie.
  _ustaw(nazwa, m, skala, tryb = 1) {
    const i = this.nr[nazwa];
    const o = i * 16;
    for (let k = 0; k < 16; k++) if (!Number.isFinite(m[k])) return false; // zła klatka: zostaje poprzednie ustawienie
    const przerwa = this.ostatnio[i] < this.nrKlatki - 1;
    if (this.tryb[i] !== tryb || przerwa) {
      let plynnie = !this.ciecie && this.widok[i] > 0.05;
      const p0 = this.punkt0[i];
      if (plynnie && p0) {
        const st = this.macierze;
        const dx = (st[o] - m[0]) * p0[0] + (st[o + 4] - m[4]) * p0[1] + (st[o + 8] - m[8]) * p0[2] + st[o + 12] - m[12];
        const dy = (st[o + 1] - m[1]) * p0[0] + (st[o + 5] - m[5]) * p0[1] + (st[o + 9] - m[9]) * p0[2] + st[o + 13] - m[13];
        if (Math.hypot(dx, dy) > this.zasieg0[i] * Math.max(skala, 0.05)) plynnie = false;
      }
      if (plynnie) {
        for (let k = 0; k < 16; k++) this.roznica[o + k] = this.macierze[o + k] - m[k];
        this.zanik[i] = Math.max(0, 1 - this.dt / CZAS_PRZEJSCIA);
      } else this.zanik[i] = 0;
      this.tryb[i] = tryb;
    }
    this.ostatnio[i] = this.nrKlatki;
    const z = this.zanik[i];
    if (z > 0) {
      const w = z * z * (3 - 2 * z);
      for (let k = 0; k < 16; k++) this.macierze[o + k] = m[k] + this.roznica[o + k] * w;
    } else this.macierze.set(m, o);
    this.skala[i] = skala;
    return true;
  }
  _glebia(nazwa, z, wl = 1) {
    const i = this.nr[nazwa];
    this.glebia[i * 2] = z;
    this.glebia[i * 2 + 1] = wl;
  }
  // ta sama poprawka perspektywy co w programie cieniującym, dla punktów liczonych na procesorze (kotwice podpisów)
  zPerspektywa(p, b0, b1, w) {
    const z0 = this.glebia[b0 * 2] * w + this.glebia[b1 * 2] * (1 - w);
    const wl = this.glebia[b0 * 2 + 1] * w + this.glebia[b1 * 2 + 1] * (1 - w);
    if (wl <= 0) return p;
    const [cx, cy, f] = this.persp;
    const wsp = 1 / Math.max(0.4, 1 - (p[2] - z0) / f);
    return [p[0] + (cx + (p[0] - cx) * wsp - p[0]) * wl, p[1] + (cy + (p[1] - cy) * wsp - p[1]) * wl, p[2]];
  }
  _m(nazwa) {
    const i = this.nr[nazwa];
    return this.macierze.subarray(i * 16, i * 16 + 16);
  }
  _filtr(klucz, x, dt, odc = 2, beta = 0.05) {
    const f = this.filtry[klucz] || (this.filtry[klucz] = new FiltrEuro(odc, beta));
    return f.filtruj(x, dt);
  }
  // zwykłe wygładzanie o podanej częstotliwości odcięcia
  _gladz(klucz, x, odc, dt) {
    const y = this.gladkie[klucz];
    this.gladkie[klucz] = y === undefined ? x : y + (x - y) * alfa(odc, dt);
    return this.gladkie[klucz];
  }
  // włącznik z histerezą: włącza się powyżej progu + szer, wyłącza poniżej progu - szer
  _wl(klucz, wart, prog = 0.5, szer = 0.1) {
    const byl = this.wl[klucz];
    const jest = byl === undefined ? wart > prog : byl ? wart > prog - szer : wart > prog + szer;
    this.wl[klucz] = jest;
    return jest;
  }
  // oś zawiasu: z iloczynu wektorowego, a gdy staw jest prawie wyprostowany, z pamięci albo z zapasu
  _osZawiasu(klucz, u, f, zapas, dt) {
    let os = wektorowy(u, f);
    const sil = dlugosc(os);
    const poprz = this.pam[klucz] || zapas;
    const waga = gladki(0.1, 0.35, sil);
    os = sil > 1e-6 ? razy(os, 1 / sil) : poprz;
    let wyn = jednostkowy(mieszaj(poprz, os, waga), poprz);
    // wygładzenie w czasie, niezależne od liczby klatek na sekundę
    wyn = jednostkowy(mieszaj(poprz, wyn, 1 - Math.exp(-dt / 0.06)), wyn);
    this.pam[klucz] = wyn;
    return wyn;
  }
  // Odcinek kończyny w 3D: z punktu a do punktu b (liczą się x i y), dzSurowe to różnica głębi z modelu sylwetki,
  // dl0 długość kości w spoczynku (mm), g skala ciała (px/mm). Zwraca wektor [dx, dy, dz].
  _odcinek(klucz, a, b, dzSurowe, dl0, g, dt) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = Math.hypot(dx, dy);
    const L = dl0 * g;
    const dzG = this._filtr('dz' + klucz, dzSurowe, dt, 0.7, 0.002);
    const strona = Math.tanh(dzG / (0.3 * L + 1e-6));
    return [dx, dy, strona * Math.sqrt(Math.max(0, L * L - l2 * l2))];
  }

  // Dopasowanie wzorcowej twarzy do punktów twarzy z jednej klatki. Zwraca { q, skala, c }, gdzie c to położenie
  // środka twarzy na ekranie, albo null. Wywoływane dla każdej surowej klatki, przed buforem.
  // otwarcieUst: wskaźnik mimiki 0..1 (jawOpen), służy tylko do nauczenia się, jak ta twarz wygląda z zamkniętymi ustami.
  dopasujTwarz(obs, ogniskowaBazowa, dt, kalibruj = true, otwarcieUst = 0) {
    const n = this.twarz0.length;
    if (!obs || obs.length < n) return null;
    const w = dopasujPodobienstwo(this.twarz0, obs.length > n ? obs.slice(0, n) : obs, this.twarzWagi);
    if (!Number.isFinite(w.skala) || !(w.skala > 1e-4) || !w.q.every(Number.isFinite)) return null;
    if (kalibruj) this._kalibrujOgniskowa(w, obs, ogniskowaBazowa, dt);
    const rc = mnozR(w.R, this.osTwarzy0);
    let q = w.q;
    // znak kwaternionu zgodny z poprzednią klatką, żeby dało się je uśredniać
    const pq = this.pam.qTwarzy;
    if (pq && q[0] * pq[0] + q[1] * pq[1] + q[2] * pq[2] + q[3] * pq[3] < 0) q = q.map((v) => -v);
    this.pam.qTwarzy = q;
    return { q, skala: w.skala, zuchwa: this._katZuchwy(w, obs, otwarcieUst, dt), c: [w.skala * rc[0] + w.t[0], w.skala * rc[1] + w.t[1], w.skala * rc[2] + w.t[2]] };
  }
  // Kąt otwarcia żuchwy w radianach: o ile punkty brody obróciły się wokół osi stawów względem ułożenia w spoczynku.
  _katZuchwy(w, obs, otwarcieUst, dt) {
    const os = this.osZuchwy0;
    const katy = [];
    for (const { i, v0 } of this.punktyZuchwy) {
      // punkt brody w układzie czaszki (odwrócenie dopasowania głowy)
      const lok = razy(mnozRT(w.R, odejmij(obs[i], w.t)), 1 / w.skala);
      const v = prostopadly(odejmij(lok, this.srodekOsiZuchwy0), os);
      katy.push(Math.atan2(iloczyn(wektorowy(v0, v), os), iloczyn(v0, v)));
    }
    katy.sort((a, b) => a - b);
    const surowy = katy[katy.length >> 1];
    if (!Number.isFinite(surowy)) return 0;
    // Zero tej twarzy: broda każdego leży trochę inaczej niż we wzorcu. Uczymy się go, gdy usta są zamknięte.
    if (otwarcieUst < 0.04) {
      const z = this.pam.zeroZuchwy;
      this.pam.zeroZuchwy = z === undefined ? surowy : z + (surowy - z) * (1 - Math.exp(-dt / 1.2));
    }
    const zero = this.pam.zeroZuchwy ?? surowy - otwarcieUst * 0.5;
    // lekkie wzmocnienie (skóra brody przesuwa się trochę mniej niż kość) i mała martwa strefa przy zamkniętych ustach
    const zBrody = (surowy - zero) * 1.15 - 0.01;
    // Druga miara: rozchylenie warg w milimetrach. Wargi rozchylają się wyraźniej, niż opada broda, a to po nich
    // widać otwarte usta, więc zęby czaszki mają się rozchylić razem z nimi (siekacze leżą ok. 88 mm od osi stawów).
    const szpara = odleglosc(obs[13], obs[14]) / w.skala;
    const zWarg = ((szpara - 3) * 0.85) / 88;
    return ogranicz(Math.max(zBrody, zWarg), 0, 0.62);
  }
  // Ustawienie głowy z pięciu punktów sylwetki (nos, oczy, uszy), w tej samej postaci co dopasowanie twarzy.
  _glowaZPozy(P) {
    const s = this.s;
    const w = dopasujPodobienstwo([s.nos, s.okoL, s.okoP, s.uchoL, s.uchoP], [P(0), P(2), P(5), P(7), P(8)]);
    if (!Number.isFinite(w.skala) || !(w.skala > 1e-4) || !w.q.every(Number.isFinite)) return null;
    const rc = mnozR(w.R, this.osTwarzy0);
    return { q: w.q, skala: w.skala, R: w.R, c: [w.skala * rc[0] + w.t[0], w.skala * rc[1] + w.t[1], w.skala * rc[2] + w.t[2]] };
  }

  // Główna funkcja. we = { poza: {p, w, v} | null, twarz: {q, skala, c, zuchwa, v} | null,
  //   dlonie: [{p, strona, wid}], wid: {poza, twarz}, dt, dopasowanie, persp, ciecie,
  //   kadr: [szerokość, wysokość] obrazu w pikselach sceny }
  aktualizuj(we) {
    const dt = (this.dt = we.dt || 1 / 30);
    if (we.ciecie) this.zeruj();
    const s = this.s;
    this.nrKlatki++;
    const ub = dt / CZAS_PRZEJSCIA;
    for (let i = 0; i < this.n; i++) if (this.zanik[i] > 0) this.zanik[i] = Math.max(0, this.zanik[i] - ub);
    this.cel.fill(0);
    if (we.persp) this.persp = [we.persp[0], we.persp[1], we.persp[2] * this.mnoznikOgniskowej];
    const poza = we.poza;
    const P = (i) => poza.p[i];
    const Wd = (i) => poza.w[i];
    const info = (this.info = { g: 0, maTulow: false, maGlowe: false, dlonie: [] });
    const widPoza = we.wid?.poza ?? 1;
    const widTwarz = we.wid?.twarz ?? 1;
    const wlasnyWid = new Uint8Array(this.n); // kości, których widoczność nie zależy od sylwetki

    // ---------- tułów ----------
    let g = this.pam.g || 1;
    let Mk = null, Mp = null;
    let xT = OSIE[0], yT = OSIE[1];
    let zTul = this.pam.zTul || 0;
    this.pam.czasBezTwarzy = we.twarz ? 0 : (this.pam.czasBezTwarzy ?? 99) + dt;
    const maTulow = !!poza && this._wl('tulow', Math.min(Wd(11), Wd(12)));
    if (maTulow) {
      const Ls = P(11), Rs = P(12), Lh = P(23), Rh = P(24);
      // biodra poza kadrem (zbliżenie): głębia barków jest wtedy przypadkowa, więc prawie ją pomijamy
      const ufn = gladki(0.2, 0.55, Math.min(Wd(23), Wd(24)));
      const szer2 = odl2(Ls, Rs);
      zTul = this.pam.zTul = this._filtr('zTul', (Ls[2] + Rs[2]) / 2, dt, 0.5, 0.001);
      const Ot = [(Ls[0] + Rs[0]) / 2, (Ls[1] + Rs[1]) / 2, zTul];
      const srBioder = [(Lh[0] + Rh[0]) / 2, (Lh[1] + Rh[1]) / 2];
      const dlTul2 = odl2(Ot, srBioder);
      // Obrót tułowia wokół osi pionowej. Gdy ktoś staje bokiem, barki zbliżają się do siebie na obrazie. Wielkość
      // obrotu liczymy z tego skrótu (szerokość barków znamy ze skali tułowia, której obrót nie zmienia), a z głębi
      // modelu sylwetki bierzemy stronę obrotu. W zbliżeniu, bez bioder w kadrze, skali odniesienia nie ma,
      // więc przyjmujemy to, co widać: tułów przodem.
      // Skale liczymy z samego obrazu. Głębia z modelu sylwetki bywa przy skokach i skłonach kilka razy za duża,
      // a wliczona w długość tułowia zawyżała skalę odniesienia i obracała tułów bokiem u osoby stojącej przodem.
      const sx2 = szer2 / this.szerBark0;
      const sy2 = dlTul2 / this.dlTul0;
      // Skala, której obrót wokół osi pionowej nie zmienia: odległość środka uszu od środka barków. Jej stosunek
      // do szerokości barków jest inny u każdego, więc uczymy się go, gdy ciało stoi przodem (wtedy jest największy).
      let zSzyi = 0;
      if (Wd(7) > 0.5 && Wd(8) > 0.5) {
        const gSzyi = this._gladz('gSzyi', odl2(srodek(P(7), P(8)), Ot) / this.dlSzyi0, 1.2, dt);
        const stos = sx2 / Math.max(gSzyi, 1e-6);
        let kB = this.pam.kBark ?? Math.max(stos, 0.85);
        if (stos > kB) kB += (stos - kB) * (1 - Math.exp(-dt / 0.4));
        else if (stos > 0.75 * kB) kB -= (kB - stos) * (1 - Math.exp(-dt / 8));
        this.pam.kBark = kB = ogranicz(kB, 0.6, 1.6);
        zSzyi = gSzyi * kB;
      }
      // z biodrami w kadrze odniesieniem jest długość tułowia; skala z szyi zmienia się przy pochylaniu głowy,
      // więc zostaje tylko dla zbliżeń, gdzie innej nie ma
      const gOdn = this._gladz('gOdn', Math.max(sx2, zSzyi * (1 - ufn), sx2 + (sy2 - sx2) * ufn), 1.5, dt);
      // Pochylenie tułowia do kamery albo od niej: wielkość ze skrótu długości tułowia na obrazie, strona z głębi
      // modelu sylwetki. Ta sama zasada co przy obrocie barków: głębia modelu nie może dać więcej, niż wynika z obrazu.
      const dzT = this._filtr('dzTul', (Lh[2] + Rh[2] - Ls[2] - Rs[2]) / 2, dt, 0.5, 0.001);
      const Lt = this.dlTul0 * gOdn;
      const skrotT = Math.sqrt(Math.max(0, Lt * Lt - dlTul2 * dlTul2));
      const dzPoch = Math.tanh(dzT / (0.25 * Lt + 1e-6)) * Math.min(skrotT, Math.abs(dzT) * 1.3);
      const OpObs = [srBioder[0], srBioder[1], zTul + dzPoch];
      const wGore = odejmij(Ot, OpObs);
      const syPom = dlugosc(wGore) / this.dlTul0;
      const Lb = this.szerBark0 * gOdn;
      const dzB = this._filtr('dzBark', Ls[2] - Rs[2], dt, 0.5, 0.001);
      const skrot = Math.sqrt(Math.max(0, Lb * Lb - szer2 * szer2));
      const dzBark = Math.tanh(dzB / (0.25 * Lb + 1e-6)) * Math.min(skrot, Math.abs(dzB) * 1.3);
      xT = jednostkowy([Ls[0] - Rs[0], Ls[1] - Rs[1], dzBark]);
      let sx = Math.hypot(szer2, dzBark) / this.szerBark0;
      // W zbliżeniu barki wychodzą poza kadr i śledzenie je ścieśnia. Skala tułowia nie może być dużo mniejsza
      // od skali głowy z siatki twarzy. Dolna granica pojawia się i znika płynnie.
      // Z biodrami w kadrze barki są całe w obrazie i skala z sylwetki jest pewna, więc granica nie działa.
      const celDolnej = this.pam.skalaTwarzy && this.pam.czasBezTwarzy < 2 ? this.pam.skalaTwarzy * 0.74 * (1 - ufn) : 0;
      const dolna = this._gladz('dolnaSx', celDolnej, 0.6, dt);
      if (sx < dolna) sx = dolna;
      // „góra” tułowia, gdy bioder nie widać: góra ekranu po odjęciu składowej wzdłuż barków. Nie zależy od tego,
      // w którą stronę wskazuje oś barków, więc tułów nie odwraca się do góry nogami, gdy ktoś staje tyłem.
      const zapasGora = jednostkowy(prostopadly([0, 1, 0], xT), [0, 1, 0]);
      const syObs = ogranicz(syPom, sx * 0.75, sx * 1.4);
      const sy = this._filtr('sy', sx + (syObs - sx) * ufn, dt, 1, 0.02);
      const gora = jednostkowy(mieszaj(zapasGora, jednostkowy(wGore, zapasGora), ufn), zapasGora);
      yT = jednostkowy(prostopadly(gora, xT), [0, 1, 0]);
      const zT = wektorowy(xT, yT);
      g = this._filtr('g', (sx + sy) / 2, dt, 1, 0.02);
      Mk = m4Odcinka(this.Ot0, OSIE, Ot, [xT, yT, zT], [sx, sy, g]);
      this._ustaw('klatka', Mk, g, 1);
      // Poprawka perspektywy tułowia ma sens w zbliżeniu i przy ustawieniu przodem. Przy obrocie barki leżą na
      // różnych głębiach, a ich położenie na obrazie już zawiera perspektywę, więc druga poprawka by je rozsuwała.
      const wlPersp = (1 - ufn) * (1 - Math.min(1, Math.abs(xT[2]) * 1.5));
      this._glebia('klatka', Ot[2], wlPersp);
      this.cel[this.nr.klatka] = 1;
      // miednica
      const Op = mieszaj(odejmij(Ot, razy(yT, this.dlTul0 * sy)), OpObs, ufn);
      // obrót miednicy tak samo jak barków: wielkość ze skrótu rozstawu bioder na obrazie, strona z głębi modelu
      const dzBioSur = this._filtr('dzBio', Lh[2] - Rh[2], dt, 0.5, 0.001);
      const szerBio2 = odl2(Lh, Rh);
      const Lbio = this.szerBioder0 * gOdn;
      const skrotBio = Math.sqrt(Math.max(0, Lbio * Lbio - szerBio2 * szerBio2));
      const dzBio = Math.tanh(dzBioSur / (0.25 * Lbio + 1e-6)) * Math.min(skrotBio, Math.abs(dzBioSur) * 1.3);
      const xP = jednostkowy(mieszaj(xT, jednostkowy([Lh[0] - Rh[0], Lh[1] - Rh[1], dzBio], xT), ufn), xT);
      const yP = jednostkowy(prostopadly(gora, xP), yT);
      const zP = wektorowy(xP, yP);
      let sxP = Math.hypot(odl2(Lh, Rh), dzBio) / this.szerBioder0;
      sxP = ogranicz(sx + (sxP - sx) * ufn, g * 0.8, g * 1.3);
      Mp = m4Odcinka(this.Op0, OSIE, Op, [xP, yP, zP], [sxP, sy, g]);
      this._ustaw('miednica', Mp, g, 1);
      this._glebia('miednica', Op[2], wlPersp);
      this.cel[this.nr.miednica] = this._wl('miednica', Math.min(Wd(23), Wd(24)), 0.45, 0.12) ? 1 : 0;
      this.pam.g = g;
      this.pam.xP = xP;
      info.diag = { sx2, sy2, syPom, zSzyi, gOdn, dzB, dzBark, dzT, dzPoch, dzBio, sx, sy, ufn, kB: this.pam.kBark };
      info.maTulow = true;
      info.srodekTulowia = srodek(Ot, Op);
      info.osTulowia = yT;
    }
    info.g = g;

    // ---------- głowa ----------
    let Mg = null;
    let skG = g;
    const dop = we.dopasowanie || {};
    const punktyGlowyZPozy = !!poza && this._wl('glowaPoza', Math.min(Wd(0), Wd(7) + 0.3, Wd(8) + 0.3), 0.6, 0.08);
    let stanGlowy = null;
    if (we.twarz) {
      // poprawka dla głowy z sylwetki: uczymy się, czym różni się od głowy z twarzy, żeby po utracie twarzy nie było skoku
      if (punktyGlowyZPozy) {
        const fp = this._glowaZPozy(P);
        const ro = fp ? Math.log(we.twarz.skala / fp.skala) : 0;
        // obie głowy różnią się ponad trzykrotnie: jedna z nich jest pomyłką śledzenia, z takiej pary się nie uczymy
        if (fp && Math.abs(ro) < 1.1) {
          const qd = qMnoz(qSprzezony(fp.q), we.twarz.q);
          const d = razy(mnozRT(fp.R, odejmij(we.twarz.c, fp.c)), 1 / fp.skala);
          if (!this.kor) this.kor = { ro, qd, d, wiek: 0 };
          else {
            const a = 1 - Math.exp(-dt / 0.8);
            this.kor.ro += (ro - this.kor.ro) * a;
            this.kor.qd = slerp(this.kor.qd, qd, a);
            this.kor.d = mieszaj(this.kor.d, d, a);
            this.kor.wiek = 0;
          }
        }
      }
      stanGlowy = this._wygladzGlowe(we.twarz, dt, we.twarz.v ?? 0);
      this.pam.skalaTwarzy = stanGlowy.skala;
      info.zrodloGlowy = 'twarz';
    } else if (punktyGlowyZPozy) {
      const fp = this._glowaZPozy(P);
      if (fp) {
        let w = { q: fp.q, skala: fp.skala, c: fp.c };
        // skala z punktów sylwetki bywa niestabilna, więc trzymamy ją blisko skali ciała
        if (maTulow) w.skala = ogranicz(w.skala, g * 0.85, g * 1.2);
        if (this.kor) {
          this.kor.wiek += dt;
          const ufn = 1 - gladki(4, 10, this.kor.wiek);
          if (ufn > 0) {
            const zKor = {
              q: qMnoz(fp.q, this.kor.qd),
              skala: fp.skala * Math.exp(this.kor.ro),
              c: [0, 1, 2].map((k) => fp.c[k] + fp.skala * mnozR(fp.R, this.kor.d)[k]),
            };
            w = { q: slerp(w.q, zKor.q, ufn), skala: Math.exp(Math.log(w.skala) + (Math.log(zKor.skala) - Math.log(w.skala)) * ufn), c: mieszaj(w.c, zKor.c, ufn) };
          }
        }
        stanGlowy = this._wygladzGlowe(w, dt, poza.v ? poza.v[0] : 0);
        // Głowa z sylwetki siedzi na uszach. Punkt zaczepienia głowy leży na twarzy, więc gdy obrót z pięciu punktów
        // sylwetki jest błędny (widok z tyłu i z boku, gdzie nos i oczy są zgadywane), czaszka odjeżdżała od głowy
        // nawet o jej szerokość. Środek uszu model sylwetki podaje pewnie z każdej strony.
        {
          const s0 = this.s;
          const R = obrotZKwaternionu(stanGlowy.q);
          const d = razy(mnozR(R, odejmij(srodek(s0.uchoL, s0.uchoP), this.osTwarzy0)), stanGlowy.skala);
          const u = srodek(P(7), P(8));
          stanGlowy = { q: stanGlowy.q, skala: stanGlowy.skala, c: [u[0] - d[0], u[1] - d[1], stanGlowy.c[2]] };
        }
        info.zrodloGlowy = 'sylwetka';
      }
    }
    if (!stanGlowy) this.glowa = null;
    else {
      Mg = this._macierzGlowy(stanGlowy);
      skG = stanGlowy.skala;
    }
    info.ogniskowa = this.persp[2];
    if (Mg) {
      // głębia głowy zgodna z tułowiem: podstawa czaszki ma leżeć tam, gdzie szczyt szyi na klatce
      if (Mk) {
        const roz = m4Punkt(Mk, this.szyja0)[2] - m4Punkt(Mg, this.szyja0)[2];
        Mg[14] += this._filtr('zGlowy', roz, dt, 1, 0.01);
      }
      // dopasowanie ręczne: rozmiar, proporcje i przesunięcie względem środka głowy
      const r = dop.rozmiar ?? 1;
      const L = [
        [r * (dop.szer ?? 1), 0, 0],
        [0, r * (dop.wys ?? 1), 0],
        [0, 0, r * (dop.gleb ?? 1)],
      ];
      const c = this.srodekGlowy0;
      const prz = [dop.x ?? 0, dop.y ?? 0, dop.z ?? 0];
      const A = m4ZLiniowej(L, [c[0] + prz[0] - L[0][0] * c[0], c[1] + prz[1] - L[1][1] * c[1], c[2] + prz[2] - L[2][2] * c[2]]);
      Mg = m4Mnoz(Mg, A);
      const trybGlowy = info.zrodloGlowy === 'twarz' ? 1 : 2;
      this._ustaw('glowa', Mg, skG * r, trybGlowy);
      const zTwarzy = m4Punkt(Mg, this.srodekTwarzy0)[2];
      this._glebia('glowa', zTwarzy);
      this._glebia('zuchwa', zTwarzy);
      // żuchwa: obrót wokół osi przez stawy skroniowo-żuchwowe
      const kat = this._filtr('zuchwa', we.twarz?.zuchwa ?? 0, dt, 6, 5);
      const os = this.osZuchwy0;
      const os0 = this.srodekOsiZuchwy0;
      const R = obrotWokolOsi(os, kat);
      const Ro = mnozR(R, os0);
      this._ustaw('zuchwa', m4Mnoz(Mg, m4ZLiniowej(R, odejmij(os0, Ro))), skG * r, trybGlowy);
      // twarz, która zaraz zniknie, gaśnie z wyprzedzeniem tylko wtedy, gdy nie ma jej czym zastąpić
      const celG = we.twarz && !punktyGlowyZPozy ? widTwarz : 1;
      this.cel[this.nr.glowa] = celG;
      this.cel[this.nr.zuchwa] = celG;
      if (we.twarz) wlasnyWid[this.nr.glowa] = wlasnyWid[this.nr.zuchwa] = 1;
      info.maGlowe = true;
      info.skalaGlowy = skG * r;
      info.srodekGlowy = m4Punkt(Mg, this.srodekGlowy0);
      info.katZuchwy = kat;
      info.osGlowy = jednostkowy(m4Kierunek(Mg, [0, 1, 0]));
      if (!maTulow) {
        // sama głowa w kadrze: szyja schodzi prosto w dół i gaśnie
        const pkt = m4Punkt(Mg, this.szyja0);
        const sk = skG * r;
        this._ustaw('klatka', m4ZLiniowej([[sk, 0, 0], [0, sk, 0], [0, 0, sk]], [pkt[0] - sk * this.szyja0[0], pkt[1] - sk * this.szyja0[1], pkt[2] - sk * this.szyja0[2]]), sk, 2);
        this._glebia('klatka', zTwarzy);
      }
    } else if (maTulow) {
      // tułów bez głowy: głowa jedzie na klatce, ale jest wygaszona
      this._ustaw('glowa', Mk, g, 3);
      this._ustaw('zuchwa', Mk, g, 3);
      this._glebia('glowa', zTul);
      this._glebia('zuchwa', zTul);
    }

    // Widoczność z modelu sylwetki bywa niska dla nóg w ciemnych spodniach (0,1 do 0,4 przy nogach w pełni
    // widocznych) i dla stawu przy krawędzi kadru, choć jego położenie jest dobre. Dalszy koniec odcinka (kolano,
    // kostka, łokieć) uznajemy więc za użyteczny także wtedy, gdy bliższy staw jest pewny, a długość odcinka
    // na obrazie zgadza się ze skalą ciała. Nadgarstka i dłoni to nie dotyczy: tam zgadnięty nadgarstek dawał
    // rękę „znikąd”.
    // Reguła działa aż do widoczności 0,8, nie tylko poniżej 0,5: kolano z widocznością 0,55 dawało kostce gorszą
    // ocenę niż kolano z widocznością 0,1 i łydka bliższej nogi gasła w przysiadzie bokiem (nagranie z 21.11.2026).
    const odcinekPewny = (pewnoscBlizszego, blizszy, dalszy, dl0) => {
      const w = poza ? Wd(dalszy) : 0;
      if (!poza || w >= 0.8) return w;
      const zgodny = odl2(P(blizszy), P(dalszy)) < 1.5 * dl0 * g ? 1 : 0;
      return Math.max(w, 0.8 * gladki(0.015, 0.04, w) * zgodny * gladki(0.45, 0.65, pewnoscBlizszego));
    };

    // ---------- ręce ----------
    for (const st of ['L', 'P']) {
      const k = PZ[st];
      let wykryta = (we.dlonie || []).find((d) => d.strona === st) || null;
      this.pam['wiekPalcow' + st] = (this.pam['wiekPalcow' + st] ?? 99) + dt;
      let dlon = null; // dłoń z modelu dłoni przypięta do ręki z sylwetki
      let wolna = null; // dłoń z modelu dłoni bez pewnej ręki z sylwetki
      const [kW, kH] = we.kadr || [1920, 1080];
      const duzaDlon = g * 185 > 0.07 * Math.max(kW, kH);
      if (wykryta) {
        let przypieta = false;
        if (poza && Wd(k.nadg) > 0.3) {
          const rozm = Math.max(1, odleglosc(wykryta.p[0], wykryta.p[9]));
          przypieta = this._wl('przyp' + st, -odl2(wykryta.p[0], P(k.nadg)) / rozm, -1.9, 0.5);
        } else this.wl['przyp' + st] = undefined;
        // Z daleka dłoń z modelu dłoni, która leży daleko od nadgarstka szybko poruszającej się ręki, została w tyle:
        // model dłoni trzyma rozmazany ślad w starym miejscu. Rysowana osobno wisiałaby obok ręki, więc ją pomijamy.
        // W zbliżeniu jest odwrotnie (dłoń jest duża i wyraźna, a nadgarstek z sylwetki zgrubny), więc tam zostaje.
        const zostalaWTyle = !duzaDlon && !!poza?.v && Wd(k.nadg) > 0.6 && poza.v[k.nadg] > 3.5 * g * 185;
        if (przypieta) dlon = wykryta.p;
        else if (!zostalaWTyle) wolna = wykryta.p;
        else wykryta = null;
      } else this.wl['przyp' + st] = undefined;

      // Model sylwetki potrafi przypisać tę samą dłoń do drugiej ręki albo zgadnąć rękę, której nie ma w kadrze.
      // Dwa zabezpieczenia: (1) jeśli na nadgarstku tej ręki leży dłoń wykryta jako dłoń drugiej strony, to jest to
      // ta sama dłoń i tej ręki nie rysujemy drugi raz; (2) w zbliżeniu dłoń liczoną z samej sylwetki rysujemy tylko
      // wtedy, gdy model jest jej pewny albo model dłoni widział ją przed chwilą.
      const swiezaDlon = !!wykryta || this.pam['wiekPalcow' + st] < 1.5;
      let rekaZgadnieta = false;
      const inna = (we.dlonie || []).find((d) => d.strona && d.strona !== st);
      if (poza && !wykryta && inna) {
        rekaZgadnieta = odl2(inna.p[0], P(k.nadg)) < 1.4 * Math.max(1, odleglosc(inna.p[0], inna.p[9]));
      }
      const pewnaDlonZPozy = !!poza && Math.min(Wd(k.nadg), Wd(k.wsk), Wd(k.maly)) > 0.8;
      // w zbliżeniu przy szybkim ruchu (machanie) punkty dłoni z sylwetki są rozmazane: gdy model nie jest ich pewny,
      // lepiej nie rysować dłoni niż rysować ją obok. Z daleka dłoń z sylwetki rysujemy zawsze, bo innej nie ma.
      const szybkiRuch = !!poza?.v && poza.v[k.nadg] > 3.5 * g * 185;
      let Mprzed = null;
      let fObs = null;
      let gR = g;
      let nadgarstek = null;
      const maRamie = maTulow && this._wl('ram' + st, Math.min(Wd(k.bark), odcinekPewny(Wd(k.bark), k.bark, k.lokiec, this.dl0['ram' + st])));
      // Łokieć za krawędzią kadru ma niską widoczność przy pewnym barku i nadgarstku (w nagraniu z 21.11.2026 model
      // dokładny dawał 0,3 do 0,5), więc bierzemy go tak jak przy ramieniu. Nadgarstek musi być pewny sam z siebie.
      const pewnyLokiec = poza ? odcinekPewny(Wd(k.bark), k.bark, k.lokiec, this.dl0['ram' + st]) : 0;
      const maPrzedramie = !!poza && this._wl('prz' + st, Math.min(pewnyLokiec, Wd(k.nadg)));
      if (maRamie || maPrzedramie) {
        // bark bierzemy z klatki piersiowej, żeby głowa kości ramiennej siedziała w stawie
        const a = Mk ? m4Punkt(Mk, s['bark' + st]) : [P(k.bark)[0], P(k.bark)[1], zTul];
        const bS = P(k.lokiec);
        const cS = dlon ? dlon[0] : P(k.nadg);
        const u3 = this._odcinek('ram' + st, a, bS, bS[2] - P(k.bark)[2], this.dl0['ram' + st], g, dt);
        const b = [bS[0], bS[1], a[2] + u3[2]];
        const f3 = this._odcinek('prz' + st, b, cS, P(k.nadg)[2] - bS[2], this.dl0['prz' + st], g, dt);
        const c = [cS[0], cS[1], b[2] + f3[2]];
        const u = jednostkowy(u3);
        const f = (fObs = jednostkowy(f3));
        const zapas = Mk ? jednostkowy(m4Kierunek(Mk, s['osLokcia' + st])) : [-1, 0, 0];
        const os = this._osZawiasu('osLok' + st, u, f, zapas, dt);
        if (maRamie) {
          const sk = dlugosc(u3) / this.dl0['ram' + st];
          gR = ogranicz(g, sk * 0.6, sk * 1.5);
          this._ustaw('ramie' + st, m4Odcinka(s['bark' + st], ukladZOsi(odejmij(s['lokiec' + st], s['bark' + st]), s['osLokcia' + st]), a, ukladZOsi(u3, os), [gR, sk, gR]), gR, 1);
          this.cel[this.nr['ramie' + st]] = 1;
        }
        if (maPrzedramie) {
          const sk = dlugosc(f3) / this.dl0['prz' + st];
          const gP = ogranicz(gR, sk * 0.6, sk * 1.5);
          Mprzed = m4Odcinka(s['lokiec' + st], ukladZOsi(odejmij(s['nadgarstek' + st], s['lokiec' + st]), s['osLokcia' + st]), b, ukladZOsi(f3, os), [gP, sk, gP]);
          this._ustaw('przedramie' + st, Mprzed, gP, dlon ? 2 : 1);
          this.cel[this.nr['przedramie' + st]] = rekaZgadnieta ? 0 : 1;
          this.cel[this.nr['promien' + st]] = rekaZgadnieta ? 0 : 1;
          gR = gP;
          nadgarstek = c;
        }
      }
      // dłoń
      let reka = null; // { Md, gh, hObs }
      if (dlon) {
        // głębia dłoni dosunięta do nadgarstka z łańcucha ręki
        const dz = (nadgarstek ? nadgarstek[2] : zTul) - dlon[0][2];
        dlon = dlon.map((p) => [p[0], p[1], p[2] + dz]);
        reka = this._dlonZPunktow(st, dlon, dt);
      } else if (wolna) {
        reka = this._dlonZPunktow(st, wolna.map((p) => [p[0], p[1], p[2] + zTul - wolna[0][2]]), dt);
        dlon = wolna;
        if (!Mprzed) {
          // przedramię przy samej dłoni nie jest znane: jedzie z dłonią i jest wygaszone
          this._ustaw('przedramie' + st, reka.Md, reka.gh, 3);
          this._ustaw('promien' + st, reka.Md, reka.gh, 3);
        }
      } else if (nadgarstek && !rekaZgadnieta && (!duzaDlon || pewnaDlonZPozy || (swiezaDlon && !szybkiRuch)) && this._wl('dlonPoza' + st, Math.min(Wd(k.nadg) - 0.1, Wd(k.wsk), Wd(k.maly)), 0.5, 0.07)) {
        reka = this._dlonZPozy(st, nadgarstek, P(k.wsk), P(k.maly), gR);
      }
      if (reka) {
        // dłoń z modelu dłoni, która zaraz zniknie, gaśnie z wyprzedzeniem, chyba że zastąpi ją dłoń z sylwetki
        const zastepstwo = !!nadgarstek && Math.min(Wd(k.nadg), Wd(k.wsk), Wd(k.maly)) > 0.6;
        const celD = wykryta && !zastepstwo ? (wykryta.wid ?? 1) : 1;
        const ustawCel = (nazwa) => {
          const i = this.nr[nazwa];
          this.cel[i] = celD;
          if (wykryta) wlasnyWid[i] = 1;
        };
        ustawCel('dlon' + st);
        for (const [palec] of PALCE) {
          ustawCel(`srodrecze_${palec}${st}`);
          ustawCel(`blizszy_${palec}${st}`);
          if (palec !== 'kciuk') ustawCel(`srodkowyp_${palec}${st}`);
          ustawCel(`dalszy_${palec}${st}`);
        }
        if (wykryta) {
          info.dlonie.push({ strona: st, wskazujacy: dlon[8], rozmiar: odleglosc(dlon[0], dlon[9]), nadgarstek: dlon[0], opuszki: srodekOpuszkow(dlon), rozstaw: rozstawOpuszkow(dlon) });
        }
      }
      // kość promieniowa: nawracanie przedramienia z ustawienia dłoni
      if (Mprzed) {
        const x0 = odejmij(s['dlon' + st].palce.wskazujacy.mcp, s['dlon' + st].palce.maly.mcp);
        let fi = this.pam['fi' + st] ?? 0;
        if (reka?.hObs) {
          const h0 = jednostkowy(prostopadly(x0, jednostkowy(odejmij(s['nadgarstek' + st], s['lokiec' + st]))));
          const hnp = jednostkowy(prostopadly(m4Kierunek(Mprzed, h0), fObs));
          const h = jednostkowy(prostopadly(reka.hObs, fObs));
          const cel = Math.atan2(iloczyn(wektorowy(hnp, h), fObs), iloczyn(hnp, h));
          // wygładzenie kąta z uwzględnieniem przejścia przez 180 stopni
          let r = cel - fi;
          if (r > Math.PI) r -= 2 * Math.PI;
          if (r < -Math.PI) r += 2 * Math.PI;
          fi += r * (1 - Math.exp(-dt / 0.08));
        }
        this.pam['fi' + st] = fi;
        const os = jednostkowy(odejmij(s['lokciowaDol' + st], s['promienGora' + st]));
        const R = obrotWokolOsi(os, fi);
        const pk = s['promienGora' + st];
        this._ustaw('promien' + st, m4Mnoz(Mprzed, m4ZLiniowej(R, odejmij(pk, mnozR(R, pk)))), gR, 1);
      }
      // Dłoń i przedramię, które widać w obrazie, leżą przed tułowiem i głową. Łańcuch ręki w zbliżeniu ma głębię
      // barku, więc w bryle klatka piersiowa zasłaniała śródręcze i kciuk dłoni trzymanej przed sobą. Przesuwamy te
      // kości w stronę kamery (sama głębia: rzut jest prostokątny, obraz na płaszczyźnie się nie zmienia).
      if (reka || Mprzed) {
        const zJest = nadgarstek ? nadgarstek[2] : zTul;
        const wysun = Math.max(0, zTul + WYSUN_REKI * g - zJest);
        if (wysun > 0) {
          const kosci = ['przedramie' + st, 'promien' + st, 'dlon' + st];
          for (const [palec] of PALCE) kosci.push(`srodrecze_${palec}${st}`, `blizszy_${palec}${st}`, `srodkowyp_${palec}${st}`, `dalszy_${palec}${st}`);
          for (const nazwa of kosci) {
            const i = this.nr[nazwa];
            if (i !== undefined && this.ostatnio[i] === this.nrKlatki) this.macierze[i * 16 + 14] += wysun;
          }
        }
      }
    }

    // ---------- nogi ----------
    if (maTulow) {
      const xP = this.pam.xP || xT;
      // kierunek „w dół tułowia” na obrazie: od środka barków do środka bioder
      const srB = srodek(P(11), P(12)), srH = srodek(P(23), P(24));
      const dlT = Math.hypot(srH[0] - srB[0], srH[1] - srB[1]) || 1;
      const dolT = [(srH[0] - srB[0]) / dlT, (srH[1] - srB[1]) / dlT];
      const kierUda = (kk) => {
        const h = P(kk.biodro), n = P(kk.kolano);
        const d = Math.hypot(n[0] - h[0], n[1] - h[1]) || 1;
        return [(n[0] - h[0]) / d, (n[1] - h[1]) / d];
      };
      for (const st of ['L', 'P']) {
        const k = PZ[st];
        // Kolano, którego model sylwetki nie widzi (poza kadrem albo zasłonięte), bywa zgadnięte przy dłoni opartej
        // na biodrze i udo skręca wtedy w bok (nagranie z 21.11.2026, stojąca osoba blisko kamery). Takiemu kolanu
        // wierzymy tylko wtedy, gdy udo idzie mniej więcej w dół tułowia albo równolegle do drugiego uda, które jest
        // wiarygodne (przysiad bokiem). Inaczej udo rysujemy prosto w dół od biodra, a goleni wcale.
        let kolanoS = P(k.kolano);
        let udoZgadniete = false;
        if (Wd(k.kolano) < 0.5) {
          const k2 = PZ[st === 'L' ? 'P' : 'L'];
          const d = kierUda(k), d2 = kierUda(k2);
          const wDol = d[0] * dolT[0] + d[1] * dolT[1];
          const druga = Wd(k2.kolano) >= 0.5 || d2[0] * dolT[0] + d2[1] * dolT[1] > 0.7;
          const zgodne = Math.max(wDol, druga ? d[0] * d2[0] + d[1] * d2[1] : -1);
          // Zgadnięte kolano wypada też tuż pod biodrem i udo rysuje się wtedy skrócone, jakby szło prosto w kamerę.
          // Niewidocznemu kolanu wierzymy więc tylko przy udzie, które na obrazie ma ponad połowę swojej długości.
          const skrot = odl2(P(k.biodro), P(k.kolano)) / (this.dl0['udo' + st] * g);
          udoZgadniete = !this._wl('kierUda' + st, Math.min(zgodne, 0.7 + (skrot - 0.55)), 0.7, 0.06);
          if (udoZgadniete) {
            const h = P(k.biodro), L = this.dl0['udo' + st] * g;
            kolanoS = [h[0] + dolT[0] * L, h[1] + dolT[1] * L, h[2]];
          }
        } else this.wl['kierUda' + st] = undefined;
        // To samo dla goleni: kostka z widocznością 0,03 (nogi poza kadrem) bywa zgadnięta gdziekolwiek i goleń
        // rysowała się jako smuga w poprzek bioder. Goleń z niewidoczną kostką przechodzi tylko wtedy, gdy idzie
        // mniej więcej w dół tułowia albo równolegle do drugiej goleni, której kostkę model widzi.
        let golenZgadnieta = udoZgadniete;
        if (!udoZgadniete && Wd(k.kostka) < 0.5) {
          const k2 = PZ[st === 'L' ? 'P' : 'L'];
          const kier = (a, b) => {
            const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
            return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
          };
          const d = kier(P(k.kolano), P(k.kostka)), d2 = kier(P(k2.kolano), P(k2.kostka));
          const zgodne = Math.max(d[0] * dolT[0] + d[1] * dolT[1], Wd(k2.kostka) >= 0.5 ? d[0] * d2[0] + d[1] * d2[1] : -1);
          golenZgadnieta = !this._wl('kierGoleni' + st, zgodne, 0.7, 0.06);
        } else this.wl['kierGoleni' + st] = undefined;
        const pewneKolano = udoZgadniete ? 0.8 * gladki(0.45, 0.65, Wd(k.biodro)) : odcinekPewny(Wd(k.biodro), k.biodro, k.kolano, this.dl0['udo' + st]);
        const pewnaKostka = golenZgadnieta ? 0 : odcinekPewny(pewneKolano, k.kolano, k.kostka, this.dl0['pod' + st]);
        const maUdo = this._wl('udo' + st, Math.min(Wd(k.biodro), pewneKolano));
        const maPodudzie = this._wl('pod' + st, Math.min(pewneKolano, pewnaKostka));
        if (!maUdo && !maPodudzie) continue;
        // biodro z miednicy, żeby głowa kości udowej siedziała w panewce
        const a = m4Punkt(Mp, this.biodro0[st]);
        // goleń, której nie rysujemy, nie ustawia też osi kolana: liczymy ją jak przy wyprostowanej nodze
        const bS = kolanoS;
        const cS = maPodudzie ? P(k.kostka) : [bS[0] + dolT[0] * this.dl0['pod' + st] * g, bS[1] + dolT[1] * this.dl0['pod' + st] * g, bS[2]];
        const t3 = this._odcinek('udo' + st, a, bS, bS[2] - P(k.biodro)[2], this.dl0['udo' + st], g, dt);
        const b = [bS[0], bS[1], a[2] + t3[2]];
        const s3 = this._odcinek('pod' + st, b, cS, cS[2] - bS[2], this.dl0['pod' + st], g, dt);
        const c = [cS[0], cS[1], b[2] + s3[2]];
        const t = jednostkowy(t3);
        const sd = jednostkowy(s3);
        let os;
        // Oś kolana (czyli skręt uda wokół własnej osi) liczymy z kierunku goleni tylko wtedy, gdy model sylwetki
        // widzi kolano i kostkę. Zgadnięta kostka dawała przypadkową oś: kość udowa wyglądała dobrze, ale skóra
        // między miednicą a udem skręcała się w niebieski wachlarz („obkręcone biodro”, nagranie z 21.11.2026).
        if (maPodudzie && Wd(k.kolano) >= 0.5 && Wd(k.kostka) >= 0.5) os = this._osZawiasu('osKol' + st, t, sd, xP, dt);
        else {
          // bez pewnej goleni oś wraca do osi poprzecznej miednicy (noga ustawiona neutralnie)
          const poprz = this.pam['osKol' + st] || xP;
          os = this.pam['osKol' + st] = jednostkowy(mieszaj(poprz, xP, 1 - Math.exp(-dt / 0.15)), xP);
        }
        let gN = g;
        if (maUdo) {
          const sk = dlugosc(t3) / this.dl0['udo' + st];
          gN = ogranicz(g, sk * 0.6, sk * 1.5);
          this._ustaw('udo' + st, m4Odcinka(this.biodro0[st], ukladZOsi(odejmij(s['kolano' + st], this.biodro0[st]), s['osKolana' + st]), a, ukladZOsi(t3, os), [gN, sk, gN]), gN, 1);
          this.cel[this.nr['udo' + st]] = 1;
        }
        if (maPodudzie) {
          const sk = dlugosc(s3) / this.dl0['pod' + st];
          gN = ogranicz(gN, sk * 0.6, sk * 1.5);
          let os2 = os;
          const wStopy = Math.min(Wd(k.pieta), Wd(k.palec));
          const maStope = this._wl('stopa' + st, Math.max(wStopy, 0.8 * gladki(0.015, 0.04, wStopy) * gladki(0.45, 0.65, pewnaKostka)));
          let dS = null;
          if (maStope) {
            const dzS = this._filtr('dzSt' + st, P(k.palec)[2] - P(k.pieta)[2], dt, 0.7, 0.002);
            dS = [P(k.palec)[0] - P(k.pieta)[0], P(k.palec)[1] - P(k.pieta)[1], dzS];
            const osS = jednostkowy(wektorowy(dS, sd), os);
            if (iloczyn(osS, os) > 0) os2 = jednostkowy(mieszaj(os, osS, 0.35), os);
          }
          this._ustaw('podudzie' + st, m4Odcinka(s['kolano' + st], ukladZOsi(odejmij(s['kostka' + st], s['kolano' + st]), s['osKolana' + st]), b, ukladZOsi(s3, os2), [gN, sk, gN]), gN, 1);
          this.cel[this.nr['podudzie' + st]] = 1;
          if (maStope) {
            const z0 = jednostkowy(odejmij(s['palecStopy' + st], s['pieta' + st]));
            const y0 = jednostkowy(prostopadly(odejmij(s['kostka' + st], s['pieta' + st]), z0));
            const x0 = wektorowy(y0, z0);
            const z = jednostkowy(dS);
            const pieta = [P(k.pieta)[0], P(k.pieta)[1], c[2] - dS[2] * 0.25];
            const y = jednostkowy(prostopadly(odejmij(c, pieta), z), [0, 1, 0]);
            const x = wektorowy(y, z);
            const skZ = ogranicz(dlugosc(dS) / odleglosc(s['palecStopy' + st], s['pieta' + st]), gN * 0.6, gN * 1.5);
            this._ustaw('stopa' + st, m4Odcinka(s['kostka' + st], [x0, y0, z0], c, [x, y, z], [gN, gN, skZ]), gN, 1);
            this.cel[this.nr['stopa' + st]] = 1;
          }
        }
      }
    }

    // kości bez własnych danych w tej klatce jadą na rodzicu
    for (const [d, r, nazwa] of this.rodzice) {
      if (this.ostatnio[d] === this.nrKlatki || this.ostatnio[r] !== this.nrKlatki) continue;
      this._ustaw(nazwa, this.macierze.slice(r * 16, r * 16 + 16), this.skala[r], 9);
    }
    // sylwetka, która zaraz zniknie, gaśnie z wyprzedzeniem (poza tym, co ma własne źródło: twarz i dłonie)
    if (widPoza < 1) for (let i = 0; i < this.n; i++) if (!wlasnyWid[i]) this.cel[i] *= widPoza;
    this.ciecieTeraz = this.ciecie;
    this.ciecie = false;
    return info;
  }

  // Płynne pojawianie się i znikanie. Po cięciu obrazu wszystko ustawia się od razu.
  krokWidocznosci(dt) {
    if (this.ciecieTeraz) {
      this.widok.set(this.cel);
      this.ciecieTeraz = false;
      return;
    }
    for (let i = 0; i < this.n; i++) {
      // zgubiona dłoń albo przedramię gaśnie w jedną, dwie klatki: inaczej przy machaniu zostaje po niej cień
      const tau = this.cel[i] > this.widok[i] ? 0.1 : this.szybkoGasnie[i] ? 0.03 : 0.07;
      this.widok[i] += (this.cel[i] - this.widok[i]) * (1 - Math.exp(-dt / tau));
    }
  }

  // Dłoń i palce z 21 punktów modelu dłoni.
  _dlonZPunktow(st, dlon, dt) {
    const rd = this.s['dlon' + st];
    const W0 = rd.nadgarstek;
    const y0 = odejmij(rd.palce.srodkowy.mcp, W0);
    const x0 = odejmij(rd.palce.wskazujacy.mcp, rd.palce.maly.mcp);
    const B0 = ukladZOsi(y0, x0);
    const Wp = dlon[0];
    const B = ukladZOsi(odejmij(dlon[9], Wp), odejmij(dlon[5], dlon[17]));
    const skY = odleglosc(dlon[9], Wp) / dlugosc(y0);
    const skX = ogranicz(odleglosc(dlon[5], dlon[17]) / dlugosc(x0), skY * 0.75, skY * 1.3);
    const gh = this._filtr('gh' + st, (skX + skY) / 2, dt, 1.5, 0.05);
    const Md = m4Odcinka(W0, B0, Wp, B, [skX, skY, gh]);
    this._ustaw('dlon' + st, Md, gh, 1);
    // ułożenie palców względem dłoni zapamiętujemy: przyda się, gdy model dłoni na chwilę zgubi rękę
    const odw = m4OdwrotnaAfiniczna(Md);
    const rel = (this.relPalcow[st] = this.relPalcow[st] || {});
    for (const [palec, pk] of PALCE) {
      const rp = rd.palce[palec];
      const kciuk = palec === 'kciuk';
      const odn0 = kciuk ? B0[2] : B0[0];
      const odn = kciuk ? B[2] : B[0];
      const gp = gh * 1.1;
      const odc = (nazwa, a0, b0, a, b, wydluz = 0) => {
        if (wydluz) b = [b[0] + (b[0] - a[0]) * wydluz, b[1] + (b[1] - a[1]) * wydluz, b[2] + (b[2] - a[2]) * wydluz];
        const sk = odleglosc(a, b) / odleglosc(a0, b0);
        const m = m4Odcinka(a0, ukladZOsi(odejmij(b0, a0), odn0), a, ukladZOsi(odejmij(b, a), odn), [gp, ogranicz(sk, gh * 0.4, gh * 2.4), gp]);
        if (this._ustaw(nazwa, m, gh, 1) && odw) rel[nazwa] = m4Mnoz(odw, m);
      };
      const podst = kciuk ? dlon[pk[0]] : m4Punkt(Md, rp.podstawa);
      odc(`srodrecze_${palec}${st}`, rp.podstawa, rp.mcp, podst, dlon[kciuk ? pk[1] : pk[0]]);
      if (kciuk) {
        odc(`blizszy_${palec}${st}`, rp.mcp, rp.ip, dlon[pk[1]], dlon[pk[2]]);
        odc(`dalszy_${palec}${st}`, rp.ip, rp.czubek, dlon[pk[2]], dlon[pk[3]], 0.18);
      } else {
        odc(`blizszy_${palec}${st}`, rp.mcp, rp.pip, dlon[pk[0]], dlon[pk[1]]);
        odc(`srodkowyp_${palec}${st}`, rp.pip, rp.dip, dlon[pk[1]], dlon[pk[2]]);
        odc(`dalszy_${palec}${st}`, rp.dip, rp.czubek, dlon[pk[2]], dlon[pk[3]], 0.18);
      }
    }
    this.pam['wiekPalcow' + st] = 0;
    return { Md, gh, hObs: odejmij(dlon[5], dlon[17]) };
  }

  // Dłoń z trzech punktów sylwetki (nadgarstek, palec wskazujący, mały). Palce zostają w ostatnim znanym ułożeniu.
  _dlonZPozy(st, Wp, wsk, maly, gR) {
    const rd = this.s['dlon' + st];
    const W0 = rd.nadgarstek;
    const x0 = odejmij(rd.palce.wskazujacy.mcp, rd.palce.maly.mcp);
    const sr0 = srodek(rd.palce.wskazujacy.mcp, rd.palce.maly.mcp);
    const kier = [(wsk[0] + maly[0]) / 2 - Wp[0], (wsk[1] + maly[1]) / 2 - Wp[1], 0];
    const bok = [wsk[0] - maly[0], wsk[1] - maly[1], 0];
    const B = ukladZOsi(kier, bok);
    const sk = ogranicz(Math.hypot(kier[0], kier[1]) / odleglosc(sr0, W0), gR * 0.7, gR * 1.4);
    const Md = m4Odcinka(W0, ukladZOsi(odejmij(sr0, W0), x0), Wp, B, [sk, sk, sk]);
    this._ustaw('dlon' + st, Md, sk, 2);
    const rel = this.pam['wiekPalcow' + st] < 2.5 ? this.relPalcow[st] : null;
    const palec = (nazwa) => this._ustaw(nazwa, rel?.[nazwa] ? m4Mnoz(Md, rel[nazwa]) : Md, sk, 2);
    for (const [p] of PALCE) {
      palec(`srodrecze_${p}${st}`);
      palec(`blizszy_${p}${st}`);
      if (p !== 'kciuk') palec(`srodkowyp_${p}${st}`);
      palec(`dalszy_${p}${st}`);
    }
    return { Md, gh: sk, hObs: bok };
  }

  // Ogniskowa kamery z samej twarzy: przy właściwej ogniskowej rzut dopasowanego modelu najlepiej
  // trafia w punkty twarzy (nos jest bliżej kamery niż uszy, więc perspektywa go powiększa).
  // Wynik to mnożnik względem ogniskowej bazowej. Pierwsze pomiary uśredniamy, potem wartość zmienia się bardzo powoli.
  _kalibrujOgniskowa(wynik, obs, bazowa, dt) {
    if (wynik.skala < 1.1) return;
    const src = this.twarz0;
    const W = this.twarzWagi;
    const n = src.length;
    const mod = new Array(n);
    let zr = 0, ile = 0;
    for (let i = 0; i < n; i++) {
      const r = mnozR(wynik.R, src[i]);
      mod[i] = [r[0] * wynik.skala + wynik.t[0], r[1] * wynik.skala + wynik.t[1], r[2] * wynik.skala + wynik.t[2]];
      if (W[i] >= 1) {
        zr += mod[i][2];
        ile++;
      }
    }
    zr /= ile;
    const [cx, cy] = this.persp;
    const MN = [0.5, 0.7, 1, 1.4, 2, 2.8, 4, 6, 9];
    const bl = MN.map((mn) => {
      const f = bazowa * mn;
      let sw = 0, ax = 0, ay = 0, bx = 0, by = 0;
      const pr = new Array(n);
      for (let i = 0; i < n; i++) {
        const w = 1 / (1 - (mod[i][2] - zr) / f);
        pr[i] = [cx + (mod[i][0] - cx) * w, cy + (mod[i][1] - cy) * w];
        sw += W[i];
        ax += pr[i][0] * W[i];
        ay += pr[i][1] * W[i];
        bx += obs[i][0] * W[i];
        by += obs[i][1] * W[i];
      }
      ax /= sw; ay /= sw; bx /= sw; by /= sw;
      let licz = 0, mian = 0;
      for (let i = 0; i < n; i++) {
        licz += W[i] * ((pr[i][0] - ax) * (obs[i][0] - bx) + (pr[i][1] - ay) * (obs[i][1] - by));
        mian += W[i] * ((pr[i][0] - ax) ** 2 + (pr[i][1] - ay) ** 2);
      }
      const sk = licz / mian;
      let e = 0;
      for (let i = 0; i < n; i++) e += W[i] * Math.hypot((pr[i][0] - ax) * sk + bx - obs[i][0], (pr[i][1] - ay) * sk + by - obs[i][1]);
      return e / sw;
    });
    let k = 0;
    for (let i = 1; i < bl.length; i++) if (bl[i] < bl[k]) k = i;
    // dokładniejsze minimum: parabola przez trzy sąsiednie punkty na osi logarytmicznej
    let lg = Math.log(MN[k]);
    if (k > 0 && k < bl.length - 1) {
      const a = bl[k - 1], b = bl[k], c = bl[k + 1];
      const mian = a - 2 * b + c;
      if (mian > 1e-9) {
        const przes = (0.5 * (a - c)) / mian;
        lg += przes * (przes > 0 ? Math.log(MN[k + 1] / MN[k]) : Math.log(MN[k] / MN[k - 1]));
      }
    }
    if (!Number.isFinite(lg)) return;
    const ileO = (this.pam.ileOgn = (this.pam.ileOgn || 0) + 1);
    const poprz = this.pam.lgOgn;
    const wsp = Math.max(1 / ileO, 1 - Math.exp(-dt / 8));
    this.pam.lgOgn = poprz === undefined ? lg : poprz + (lg - poprz) * wsp;
    this.mnoznikOgniskowej = Math.exp(this.pam.lgOgn);
  }

  // Wygładzenie ustawienia głowy. Obrót, skala i położenie środka twarzy mają osobne filtry; ponieważ punkt,
  // wokół którego liczymy, leży na twarzy, opóźnienie obrotu albo skali nie odsuwa czaszki od twarzy.
  _wygladzGlowe(w, dt, predkosc) {
    if (!this.glowa) {
      this.glowa = { q: w.q.slice(), skala: w.skala, c: w.c.slice() };
      for (const k of ['gx', 'gy', 'gz']) delete this.gladkie[k];
      delete this.filtry.gs;
    }
    const g = this.glowa;
    // obrót: im szybszy ruch, tym mniej wygładzania
    const cos = Math.abs(g.q[0] * w.q[0] + g.q[1] * w.q[1] + g.q[2] * w.q[2] + g.q[3] * w.q[3]);
    const kat = 2 * Math.acos(Math.min(1, cos));
    const odc = 2.5 + (kat / dt) * 9;
    g.q = slerp(g.q, w.q, alfa(odc, dt));
    g.skala = Math.exp(this._filtr('gs', Math.log(w.skala), dt, 1.5, 30));
    const odcC = 3 + 0.08 * (predkosc || 0);
    g.c = [this._gladz('gx', w.c[0], odcC, dt), this._gladz('gy', w.c[1], odcC, dt), this._gladz('gz', w.c[2], 1.5, dt)];
    return g;
  }
  _macierzGlowy(g) {
    const R = obrotZKwaternionu(g.q);
    const L = R.map((w) => w.map((v) => v * g.skala));
    const lc = mnozR(L, this.osTwarzy0);
    return m4ZLiniowej(L, [g.c[0] - lc[0], g.c[1] - lc[1], g.c[2] - lc[2]]);
  }

  // Pozycja spoczynkowa na środku kadru (do podglądu modelu bez kamery).
  spoczynek(W, H, kat = 0, powiekszenie = 1, srodekY = 815) {
    const sk = ((H * 0.92) / 1660) * powiekszenie;
    const R = obrotWokolOsi([0, 1, 0], kat);
    const L = R.map((w) => w.map((v) => v * sk));
    const c = [0, srodekY, 60];
    const Lc = mnozR(L, c);
    const m = m4ZLiniowej(L, [W / 2 - Lc[0], H / 2 - Lc[1], -Lc[2]]);
    this.glebia.fill(0);
    for (let i = 0; i < this.n; i++) {
      this.macierze.set(m, i * 16);
      this.widok[i] = 1;
      this.cel[i] = 1;
      this.skala[i] = sk;
    }
    this.info = { g: sk, maTulow: true, maGlowe: true, skalaGlowy: sk, srodekGlowy: m4Punkt(m, this.srodekGlowy0), srodekTulowia: m4Punkt(m, [0, 1080, 60]), osTulowia: [0, 1, 0], osGlowy: [0, 1, 0], dlonie: [] };
    return this.info;
  }
}
