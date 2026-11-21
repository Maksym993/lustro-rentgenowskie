// Podpisy struktur z liniami prowadzącymi, rysowane na płótnie 2D, które scena nakłada na obraz.
import { m4Punkt, m4Kierunek, jednostkowy } from './matma.js';

const KOLORY = {
  kosci: '#e8f1ff',
  miesnie: '#ff7a6e',
  narzady: '#ffc48a',
  naczynia: '#ff5a66',
  mozg: '#ff9ccb',
  oczy: '#ffe9a8',
  skora: '#6aa8ff',
};

export class Etykiety {
  constructor(opis, rig) {
    this.rig = rig;
    // krotko: nazwa do wąskiego (pionowego) kadru, ze skrótem „m.” jak w atlasach anatomicznych
    this.lista = opis.etykiety.map((e, i) => ({ ...e, i, alfa: 0, y: null, x: null, kol: null, kotw: -1, px: 0, py: 0, krotko: e.pl.replace(/^Mięsień /, 'm. ').replace(/^Mięśnie /, 'mm. ') }));
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.kol = { L: { x: null }, P: { x: null } };
    this.srodekX = null;
    // skala każdej kości z martwą strefą: od niej zależy, czy pokazujemy podpis ogólny, czy szczegółowe
    this.skH = new Float32Array(rig.n);
    this.czesc = null; // widoczność części ciała (ta sama tablica co w scenie)
    // wyciszenie podpisów części ciała, 0 do 1: anatomia zostaje, znikają same podpisy (ręka, która prowadzi soczewkę)
    this.bezPodpisow = new Float32Array(32);
  }

  ustawRozmiar(W, H) {
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
  }

  // punkt kotwicy na ekranie (układ sceny) razem z widocznością i skalą kości
  _kotwica(k) {
    const r = this.rig;
    const [b0, b1, w] = k.rig;
    const m0 = r.macierze.subarray(b0 * 16, b0 * 16 + 16);
    const p0 = m4Punkt(m0, k.p);
    let p = p0;
    let n = m4Kierunek(m0, k.n);
    if (b1 !== b0 && w < 0.999) {
      const m1 = r.macierze.subarray(b1 * 16, b1 * 16 + 16);
      const p1 = m4Punkt(m1, k.p);
      const n1 = m4Kierunek(m1, k.n);
      p = [p0[0] * w + p1[0] * (1 - w), p0[1] * w + p1[1] * (1 - w), p0[2] * w + p1[2] * (1 - w)];
      n = [n[0] * w + n1[0] * (1 - w), n[1] * w + n1[1] * (1 - w), n[2] * w + n1[2] * (1 - w)];
    }
    p = r.zPerspektywa(p, b0, b1, w);
    const cz = k.czesc ?? 0;
    const wid = (r.widok[b0] * w + r.widok[b1] * (1 - w)) * (this.czesc ? this.czesc[cz] : 1) * (1 - this.bezPodpisow[cz]);
    const sk = this.skH[b0] * w + this.skH[b1] * (1 - w);
    return { p, nz: jednostkowy(n, [0, 0, 1])[2], wid, sk };
  }

  // we: { W, H, pokaz, warstwy, lustro, tryb, dt, ciecie, odslonieta(x, y) -> odległość w pikselach od granicy odsłony (dodatnia w środku),
  //   soczewka: [x, y, r] | null, punkty: [[x, y]] | null, srodekX }
  rysuj(we) {
    const { W, H, dt } = we;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    const naEkran = (p) => [we.lustro ? W - p[0] : p[0], H - p[1]];
    const czc = Math.max(11, Math.round((H / 1080) * 19 * (W < H ? 0.92 : 1) * (we.skalaNapisow || 1)));
    const odstep = Math.round(czc * 1.42);
    const margines = Math.round(czc * 0.9);
    // pasy u góry i u dołu obrazu bez podpisów (ułamek wysokości): miejsce na napisy filmu albo panel nad obrazem
    const gora = Math.max(margines, Math.round((we.poleGora || 0) * H));
    const dolPola = Math.max(margines, Math.round((we.poleDol || 0) * H));
    // to samo z boków (ułamek szerokości): podpisy nie wchodzą w pas przycinany przez podgląd w aplikacjach
    const bokPola = Math.max(margines, Math.round((we.poleBok || 0) * W));

    // punkty śledzenia (podgląd diagnostyczny)
    if (we.punkty) {
      ctx.fillStyle = 'rgba(120, 255, 190, 0.9)';
      for (const p of we.punkty) {
        const [x, y] = naEkran(p);
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
      }
    }
    // obręcz soczewki
    if (we.soczewka && we.soczewka[2] > 3) {
      const [x, y] = naEkran(we.soczewka);
      ctx.lineWidth = Math.max(1, H / 900);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.arc(x, y, we.soczewka[2], 0, Math.PI * 2);
      ctx.stroke();
    }

    // --- wybór podpisów ---
    const kand = [];
    // Skala z martwą strefą: zestaw podpisów zmienia się dopiero, gdy skala kości odejdzie o 7% od zapamiętanej.
    // Bez tego na granicy zakresu podpis ogólny i szczegółowe migają na zmianę.
    const rg = this.rig;
    for (let b = 0; b < rg.n; b++) {
      const h = this.skH[b];
      if (!(h > 0) || we.ciecie || Math.abs(rg.skala[b] / h - 1) > 0.07) this.skH[b] = rg.skala[b];
    }
    for (const e of this.lista) {
      e.byl = e.wybrany && e.alfa > 0.25;
      e.wybrany = false;
    }
    if (we.pokaz) {
      for (const e of this.lista) {
        if (!we.warstwy[e.w]) continue;
        // mięsień zasłonięty z każdej strony widać tylko w rentgenie; na bryle podpis wskazywałby inny mięsień
        if (e.gl && we.tryb === 'bryla') continue;
        let naj = null;
        for (let ki = 0; ki < e.kotwice.length; ki++) {
          const k = this._kotwica(e.kotwice[ki]);
          // podpis, który już widać, trzyma się dłużej niż nowy potrzebuje, żeby się pojawić (histereza)
          const trzyma = e.byl && ki === e.kotw;
          if (k.wid < (trzyma ? 0.35 : 0.6) || k.sk < e.skala[0] || k.sk >= e.skala[1]) continue;
          const brzeg = trzyma ? -6 : 10;
          if (k.p[0] < brzeg || k.p[0] > W - brzeg || k.p[1] < brzeg || k.p[1] > H - brzeg) continue;
          if (we.tryb === 'bryla' && k.nz < (trzyma ? -0.35 : -0.2)) continue;
          // Mięsień podpisujemy tylko od strony, z której go widać. Kropka z tyłu ciała prześwitywała w rentgenie
          // i wyglądała, jakby wskazywała coś z przodu (mięsień czworoboczny „na policzku”).
          if (e.w === 'miesnie' && k.nz < (trzyma ? 0.05 : 0.25)) continue;
          if (we.odslonieta && we.odslonieta(k.p[0], k.p[1]) < (trzyma ? -8 : 8)) continue;
          const [fx, fy] = naEkran(k.p);
          // ocena: poprzednio wybrana kotwica ma pierwszeństwo, potem ta zwrócona do widza,
          // a przy remisie parzyste podpisy idą na lewo, nieparzyste na prawo
          let ocena = k.nz * 1.0 + (ki === e.kotw ? 0.6 : 0);
          if (e.kotwice.length > 1) ocena += ((e.i % 2 === 0) === (fx < (we.srodekX ?? W / 2)) ? 0.25 : 0);
          if (!naj || ocena > naj.ocena) naj = { ki, fx, fy, ocena };
        }
        if (naj) kand.push({ e, ...naj });
      }
    }
    // --- kolumny ---
    const cx = we.srodekX ?? W / 2;
    this.srodekX = this.srodekX === null || we.ciecie ? cx : this.srodekX + (cx - this.srodekX) * (1 - Math.exp(-dt / 0.15));
    const kolumny = { L: [], P: [] };
    for (const k of kand) {
      let kol = k.fx < this.srodekX ? 'L' : 'P';
      if (k.e.kol && k.e.alfa > 0.3 && Math.abs(k.fx - this.srodekX) < czc * 2) kol = k.e.kol;
      k.kol = kol;
      kolumny[kol].push(k);
    }
    ctx.font = `500 ${czc}px Inter, "Helvetica Neue", Arial, sans-serif`;
    ctx.textBaseline = 'middle';
    const ileMax = Math.min(we.maksNaKolumne || 13, Math.max(3, Math.floor((H - gora - dolPola) / odstep)));
    const napis = (e) => (W < H ? e.krotko : e.pl);
    for (const strona of ['L', 'P']) {
      let kol = kolumny[strona];
      // podpis szerszy niż miejsce obok ciała nachodziłby na ciało i na drugą kolumnę, więc odpada
      if (kol.length) {
        const brzeg = strona === 'L' ? Math.min(...kol.map((k) => k.fx)) : Math.max(...kol.map((k) => k.fx));
        const miejsce = Math.max(W * 0.3 - bokPola, (strona === 'L' ? brzeg : W - brzeg) - czc * 2.2 - bokPola);
        kol = kol.filter((k) => ctx.measureText(napis(k.e)).width <= miejsce);
      }
      if (kol.length > ileMax) {
        kol.sort((a, b) => b.e.waga - a.e.waga || a.e.i - b.e.i);
        kol = kol.slice(0, ileMax);
      }
      if (!kol.length) continue;
      // kolejność według wygładzonej wysokości kotwicy: drobne drgania śledzenia nie zamieniają podpisów miejscami
      for (const k of kol) {
        const e = k.e;
        e.fyG = e.fyG === undefined || e.alfa < 0.05 ? k.fy : e.fyG + (k.fy - e.fyG) * (1 - Math.exp(-dt / 0.35));
      }
      // klucz kolejności idzie za kotwicą dopiero, gdy ta odsunie się o ponad pół odstępu (martwa strefa)
      for (const k of kol) {
        const e = k.e;
        if (e.klucz === undefined || e.alfa < 0.05 || e.kol !== strona) e.klucz = e.fyG;
        else if (Math.abs(e.fyG - e.klucz) > odstep * 0.55) e.klucz = e.fyG - Math.sign(e.fyG - e.klucz) * odstep * 0.3;
      }
      kol.sort((a, b) => a.e.klucz - b.e.klucz || a.e.i - b.e.i);
      // rozsunięcie w pionie
      const ys = kol.map((k) => k.e.fyG);
      for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + odstep);
      const dol = H - dolPola;
      for (let i = ys.length - 1; i >= 0; i--) ys[i] = Math.min(ys[i], i === ys.length - 1 ? dol : ys[i + 1] - odstep);
      for (let i = 0; i < ys.length; i++) ys[i] = Math.max(ys[i], i === 0 ? gora : ys[i - 1] + odstep);
      // położenie kolumny: obok najdalej wysuniętej kotwicy, ale tak, żeby najdłuższy podpis mieścił się w kadrze.
      // Tekst zawsze kończy się od strony ciała, więc kolumna przesuwa się płynnie i nigdy nie przeskakuje do krawędzi.
      let szer = 0;
      for (const k of kol) szer = Math.max(szer, ctx.measureText(napis(k.e)).width);
      const odl = czc * 3.4;
      let x;
      if (strona === 'L') x = Math.max(Math.min(...kol.map((k) => k.fx)) - odl, bokPola + szer);
      else x = Math.min(Math.max(...kol.map((k) => k.fx)) + odl, W - bokPola - szer);
      const st = this.kol[strona];
      if (st.x === null || we.ciecie) st.x = x;
      else st.x += (x - st.x) * (1 - Math.exp(-dt / 0.25));
      kol.forEach((k, i) => {
        const e = k.e;
        e.wybrany = true;
        e.kotw = k.ki;
        if (e.kol !== strona || e.y === null || e.alfa < 0.02 || we.ciecie) e.y = ys[i];
        else e.y += (ys[i] - e.y) * (1 - Math.exp(-dt / 0.12));
        e.kol = strona;
        e.px = k.fx;
        e.py = k.fy;
      });
      // wygładzone pozycje też muszą trzymać odstęp, inaczej podpisy nachodzą na siebie w trakcie zamiany miejsc
      const yr = kol.map((k) => k.e.y);
      for (let i = 1; i < yr.length; i++) yr[i] = Math.max(yr[i], yr[i - 1] + odstep);
      for (let i = yr.length - 1; i >= 0; i--) yr[i] = Math.min(yr[i], i === yr.length - 1 ? dol : yr[i + 1] - odstep);
      for (let i = 0; i < yr.length; i++) yr[i] = Math.max(yr[i], i === 0 ? gora : yr[i - 1] + odstep);
      kol.forEach((k, i) => (k.e.y = yr[i]));
    }
    // --- rysowanie ---
    for (const e of this.lista) {
      // pojawianie się łagodne, znikanie szybkie, żeby gasnący podpis nie stał długo pod nowym
      if (we.ciecie) e.alfa = e.wybrany ? 1 : 0;
      else e.alfa += ((e.wybrany ? 1 : 0) - e.alfa) * (1 - Math.exp(-dt / (e.wybrany ? 0.14 : 0.06)));
      if (e.alfa < 0.02 || e.y === null || !e.kol) continue;
      const lewa = e.kol === 'L';
      const kolumna = this.kol[e.kol];
      const x = kolumna.x;
      if (x === null) continue;
      const a = e.alfa;
      // tekst kończy się od strony ciała
      ctx.textAlign = lewa ? 'right' : 'left';
      // koniec tekstu od strony ciała i znacznik warstwy
      const kierunek = lewa ? 1 : -1;
      const koniec = x;
      const xz = koniec + kierunek * czc * 0.5;
      const xl = koniec + kierunek * czc * 0.95;
      const zal = lewa ? Math.min(xl + czc * 1.6, e.px) : Math.max(xl - czc * 1.6, e.px);
      const gr = Math.max(1, H / 900);
      // linia prowadząca: najpierw ciemny obrys, potem jasna kreska, żeby była czytelna na każdym tle
      for (const [szer, styl] of [[gr * 3, `rgba(0,0,0,${0.45 * a})`], [gr, `rgba(255,255,255,${0.8 * a})`]]) {
        ctx.lineWidth = szer;
        ctx.strokeStyle = styl;
        ctx.beginPath();
        ctx.moveTo(e.px, e.py);
        ctx.lineTo(zal, e.y);
        ctx.lineTo(xl, e.y);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(0,0,0,${0.5 * a})`;
      ctx.beginPath();
      ctx.arc(e.px, e.py, Math.max(3, czc * 0.22), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.95 * a})`;
      ctx.beginPath();
      ctx.arc(e.px, e.py, Math.max(2, czc * 0.14), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = a;
      ctx.fillStyle = KOLORY[e.w] || '#fff';
      ctx.beginPath();
      ctx.arc(xz, e.y, czc * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = czc * 0.35;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(W < H ? e.krotko : e.pl, x, e.y + 1);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }
}
