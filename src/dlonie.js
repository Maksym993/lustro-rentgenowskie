// Dłonie: stałe tory (ta sama dłoń trzyma ten sam tor z klatki na klatkę), stabilna strona lewa albo prawa
// i miara otwarcia dłoni dla gestu, który steruje rozmiarem soczewki.
import { odleglosc } from './matma.js';

const OPUSZKI = [4, 8, 12, 16, 20];
const PODSTAWA = [0, 5, 9, 13, 17];

function srednia(p, indeksy) {
  const c = [0, 0, 0];
  for (const i of indeksy) {
    c[0] += p[i][0];
    c[1] += p[i][1];
    c[2] += p[i][2];
  }
  return [c[0] / indeksy.length, c[1] / indeksy.length, c[2] / indeksy.length];
}
export const srodekDloni = (p) => srednia(p, PODSTAWA);
export const srodekOpuszkow = (p) => srednia(p, OPUSZKI);

// Rozstaw opuszków względem wielkości dłoni. Palce zebrane w jeden punkt dają ok. 0,15, dłoń szeroko otwarta ok. 0,7.
export function rozstawOpuszkow(p) {
  const L = odleglosc(p[0], p[9]) || 1;
  const c = srodekOpuszkow(p);
  let s = 0;
  for (const i of OPUSZKI) s += odleglosc(p[i], c);
  return s / OPUSZKI.length / L;
}

const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export class ToryDloni {
  constructor() {
    this.tory = [null, null];
  }
  zeruj() {
    this.tory = [null, null];
  }

  // wykrycia: [{ p, strona, pewnosc }] w układzie sceny, poza: { p, w } albo null (ta sama klatka), nr: numer klatki.
  // Zwraca dwa tory: [{ p, strona, pewnosc } | null, { ... } | null].
  aktualizuj(wykrycia, poza, nr) {
    let det = wykrycia.map((d) => ({ ...d, sr: srodekDloni(d.p), rozm: Math.max(1, odleglosc(d.p[0], d.p[9])), tor: -1 }));
    // ta sama dłoń wykryta dwa razy: zostaje pewniejsze wykrycie
    if (det.length === 2 && d2(det[0].sr, det[1].sr) < 0.5 * Math.max(det[0].rozm, det[1].rozm)) {
      det = [det[0].pewnosc >= det[1].pewnosc ? det[0] : det[1]];
    }
    // przypisanie wykryć do torów po odległości od ostatniego położenia
    const pary = [];
    for (let ti = 0; ti < 2; ti++) {
      const t = this.tory[ti];
      if (!t) continue;
      for (let di = 0; di < det.length; di++) {
        const k = d2(det[di].sr, t.sr) / Math.max(t.rozm, det[di].rozm);
        if (k < 2.2 + 0.7 * Math.max(0, nr - t.nr - 1)) pary.push({ ti, di, k });
      }
    }
    pary.sort((a, b) => a.k - b.k);
    const zajetyTor = [false, false];
    for (const par of pary) {
      if (zajetyTor[par.ti] || det[par.di].tor >= 0) continue;
      zajetyTor[par.ti] = true;
      det[par.di].tor = par.ti;
    }
    // Pozostałe wykrycia zajmują tory, które w tej klatce nie dostały dłoni: najpierw pusty, potem ten, na którym
    // dłoń była widziana najdawniej. Tor po krótkiej przerwie zachowuje swoją historię (to zwykle ta sama dłoń,
    // która przesunęła się szybciej, niż pozwala bramka odległości), po dłuższej zaczyna od zera.
    for (const d of det) {
      if (d.tor >= 0) continue;
      let wolny = -1;
      for (let ti = 0; ti < 2; ti++) {
        if (zajetyTor[ti]) continue;
        const t = this.tory[ti];
        if (!t) {
          wolny = ti;
          break;
        }
        if (wolny < 0 || t.nr < this.tory[wolny].nr) wolny = ti;
      }
      if (wolny < 0) continue;
      const t = this.tory[wolny];
      if (!t || nr - t.nr > 8) this.tory[wolny] = { sr: d.sr, rozm: d.rozm, nr, glosy: { L: 0, P: 0 }, strona: null };
      zajetyTor[wolny] = true;
      d.tor = wolny;
    }
    for (let ti = 0; ti < 2; ti++) if (this.tory[ti] && nr - this.tory[ti].nr > 45) this.tory[ti] = null;

    const wyn = [null, null];
    for (const d of det) {
      if (d.tor < 0) continue;
      const t = this.tory[d.tor];
      // Wiarygodność: dłoń przy krawędzi kadru model potrafi na klatkę albo dwie „zobaczyć” w innym miejscu i w innym
      // rozmiarze. Prawdziwa dłoń nie zmienia wielkości o kilkanaście procent w jednej klatce, więc takie wykrycie
      // pomijamy (bufor wypełni przerwę z sąsiednich klatek). Gdy trwa dłużej, uznajemy je za nowy stan.
      const dlug = odleglosc(d.p[0], d.p[9]); // nadgarstek do nasady palca środkowego, w 3D
      const szer = d2(d.p[5], d.p[17]); // szerokość dłoni na obrazie
      const swiezy = t.dlug && nr - t.nr <= 3;
      // ostrożnie: odrzucamy tylko wyraźny skok rozmiaru razem ze skokiem położenia i najwyżej dwie klatki z rzędu,
      // żeby zwykły szybki ruch albo obrót dłoni nie wyłączał jej śledzenia
      const innyRozmiar = swiezy && Math.abs(dlug / t.dlug - 1) > 0.25;
      if (innyRozmiar && d2(d.sr, t.sr) > 0.5 * t.rozm && (t.odrzucone || 0) < 2) {
        t.odrzucone = (t.odrzucone || 0) + 1;
        continue;
      }
      t.odrzucone = 0;
      t.dlug = swiezy ? t.dlug + (dlug - t.dlug) * 0.2 : dlug;
      t.szer = swiezy ? t.szer + (szer - t.szer) * 0.2 : szer;
      t.sr = d.sr;
      t.rozm = d.rozm;
      t.nr = nr;
      // głosy na stronę: etykieta z modelu dłoni i bliskość nadgarstka z modelu sylwetki
      t.glosy.L *= 0.9;
      t.glosy.P *= 0.9;
      if (d.strona) t.glosy[d.strona] += Math.max(0.3, d.pewnosc || 0.5);
      if (poza) {
        const oL = poza.w[15] > 0.5 ? d2(d.p[0], poza.p[15]) / d.rozm : Infinity;
        const oP = poza.w[16] > 0.5 ? d2(d.p[0], poza.p[16]) / d.rozm : Infinity;
        if (oL < 1.2 && oL < 0.6 * oP) t.glosy.L += oL < 0.7 ? 2 : 1;
        if (oP < 1.2 && oP < 0.6 * oL) t.glosy.P += oP < 0.7 ? 2 : 1;
        // dłoń leży na nadgarstku jednej ręki, a od drugiej jest daleko: strona jest pewna od razu
        if (oL < 0.7 && oP > 2.5) t.glosy.L = Math.max(t.glosy.L, t.glosy.P * 1.25 + 1);
        if (oP < 0.7 && oL > 2.5) t.glosy.P = Math.max(t.glosy.P, t.glosy.L * 1.25 + 1);
      }
      const inna = t.strona === 'L' ? 'P' : 'L';
      if (!t.strona) t.strona = t.glosy.L >= t.glosy.P ? 'L' : 'P';
      else if (t.glosy[inna] > t.glosy[t.strona] * 1.25 + 0.5) t.strona = inna;
      wyn[d.tor] = { p: d.p, strona: t.strona, pewnosc: d.pewnosc };
    }
    // dwie dłonie nie mogą być po tej samej stronie: ustępuje ta, której strona jest mniej pewna
    if (wyn[0] && wyn[1] && wyn[0].strona === wyn[1].strona) {
      const zapas = (ti) => {
        const t = this.tory[ti];
        return t.glosy[t.strona] - t.glosy[t.strona === 'L' ? 'P' : 'L'];
      };
      const ti = zapas(0) < zapas(1) ? 0 : 1;
      const t = this.tory[ti];
      const inna = t.strona === 'L' ? 'P' : 'L';
      t.glosy[inna] = t.glosy[t.strona] + 0.5;
      t.strona = inna;
      wyn[ti].strona = inna;
    }
    return wyn;
  }
}
