// Test z prawdziwą kamerą. Prowadzi przez kolejne ruchy (tekstem i głosem), po drodze przełącza opcje aplikacji,
// a w tle zapisuje dwie rzeczy: surowy obraz z kamery, dokładnie te klatki, które przeszły przez śledzenie
// (plik MP4 w surowe/test, po jednej klatce na każdą przetworzoną), oraz pomiary każdej klatki (plik JSON
// w surowe/zrzuty). Z nagrania da się potem odtworzyć każdą klatkę z dowolnymi ustawieniami, bez kamery.
// Nic nie wychodzi poza ten komputer: pliki zapisuje serwer deweloperski w folderze projektu.
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

const SZKIELET = { kosci: true, miesnie: false, narzady: false, naczynia: false, mozg: true, oczy: true, skora: true };
const WSZYSTKO = { kosci: true, miesnie: true, narzady: true, naczynia: true, mozg: true, oczy: true, skora: true };
const PODSTAWA = { warstwy: SZKIELET, tryb: 'rentgen', odslona: 'calosc', kadr: 'poziomy', podpisy: true, gest: true, zasiegSoczewki: 0.5, czesci: null };

// czas: ile sekund trwa ruch (liczony po zakończeniu czytania instrukcji), ust: ustawienia aplikacji na ten krok
export const KROKI = [
  { id: 'przod', czas: 5, tekst: 'Stań przodem, mniej więcej metr od kamery. Ręce w dół.', ust: PODSTAWA },
  { id: 'glowa', czas: 9, tekst: 'Powoli obróć głowę w lewo, potem w prawo, w górę i w dół.' },
  { id: 'usta', czas: 8, tekst: 'Otwórz szeroko usta i zamknij. Trzy razy, raz powoli, potem szybciej.' },
  { id: 'jezyk', czas: 10, tekst: 'Wysuń język prosto, potem w lewo, w prawo i w górę. Na końcu schowaj.' },
  { id: 'dlonie', czas: 9, tekst: 'Pokaż obie dłonie przed sobą. Otwórz je szeroko i zaciśnij w pięści, kilka razy.' },
  { id: 'zaslona', czas: 9, tekst: 'Zasłoń twarz dłonią na dwie sekundy i odsłoń. Potem to samo drugą dłonią.' },
  { id: 'soczewka', czas: 14, tekst: 'Soczewka. Jedną dłonią prowadź koło po twarzy, szyi i klatce piersiowej. Zbieraj i otwieraj palce.', ust: { odslona: 'soczewka' } },
  { id: 'soczewka2', czas: 9, tekst: 'Tą samą dłonią nakieruj soczewkę na drugą dłoń.' },
  { id: 'polowa', czas: 7, tekst: 'Teraz widać tylko połowę ciała. Przechyl głowę w lewo i w prawo.', ust: { odslona: 'lewa' } },
  { id: 'cale', czas: 9, tekst: 'Odejdź dwa, trzy kroki do tyłu, żeby było widać jak najwięcej ciała. Ręce lekko na boki.', ust: { odslona: 'calosc', warstwy: WSZYSTKO } },
  { id: 'obrot', czas: 14, tekst: 'Bardzo powoli obróć się w miejscu o pełny obrót: bokiem, tyłem, drugim bokiem i znów przodem.' },
  { id: 'tyl', czas: 8, tekst: 'Stań tyłem do kamery i unieś ręce na boki. Potem je opuść.' },
  { id: 'rece', czas: 9, tekst: 'Przodem. Podnieś obie ręce nad głowę i opuść. Potem zegnij łokcie.', ust: { warstwy: SZKIELET } },
  { id: 'przysiad', czas: 9, tekst: 'Zrób dwa spokojne przysiady.', ust: { tryb: 'bryla' } },
  { id: 'wyjscie', czas: 8, tekst: 'Wyjdź z kadru w bok, policz do dwóch i wróć.', ust: { tryb: 'rentgen' } },
  { id: 'szybko', czas: 6, tekst: 'Pomachaj szybko obiema rękami.' },
  { id: 'pion', czas: 8, tekst: 'Obraz jest teraz pionowy. Podejdź bliżej i stań przodem.', ust: { kadr: 'pionowy', warstwy: WSZYSTKO } },
];

const czekaj = (ms) => new Promise((ok) => setTimeout(ok, ms));

export class TestKamery {
  // api: { plotnoKlatki, ust, st, sledzenie, odswiezPanel, kamera: { etykieta, ustawienia } }
  constructor(api, { szybko = false } = {}) {
    this.api = api;
    this.szybko = szybko; // skrócone kroki i bez głosu: do sprawdzenia samego testu na strumieniu z pliku
    this.el = document.querySelector('#test');
    this.klatki = [];
    this.kroki = [];
    this.bledy = [];
    this.krok = -1;
    this.przerwany = false;
    this.poprzT = 0;
    this.poprzPokazane = null;
    this.naBlad = (e) => this.bledy.push({ t: Math.round(performance.now() - this.t0), tekst: String(e.error?.stack || e.reason?.stack || e.message || e.reason || e) });
  }

  async uruchom() {
    const { api } = this;
    this.kopiaUstawien = structuredClone(api.ust);
    // czekamy na pierwszą przetworzoną klatkę: wtedy znamy wymiary obrazu z kamery
    for (let i = 0; i < 100 && !(api.plotnoKlatki.width > 2 && api.st.obs); i++) await czekaj(50);
    const szer = api.plotnoKlatki.width & ~1;
    const wys = api.plotnoKlatki.height & ~1;
    if (!('VideoEncoder' in window)) throw new Error('ta przeglądarka nie ma kodera wideo (potrzebny Chrome)');
    this.muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: szer, height: wys, frameRate: 30 }, fastStart: 'in-memory' });
    this.koder = new VideoEncoder({ output: (porcja, meta) => this.muxer.addVideoChunk(porcja, meta), error: (e) => this.bledy.push({ t: 0, tekst: 'koder: ' + e.message }) });
    this.koder.configure({ codec: 'avc1.640028', width: szer, height: wys, bitrate: 10_000_000, framerate: 30, latencyMode: 'realtime' });
    this.t0 = performance.now();
    this.poprzT = this.t0;
    window.addEventListener('error', this.naBlad);
    window.addEventListener('unhandledrejection', this.naBlad);
    api.st.poKlatce = (dane) => this._poKlatce(dane);
    this.el.hidden = false;
    document.querySelector('#testStop').onclick = () => (this.przerwany = true);
    let wynik = null;
    try {
      for (let i = 0; i < KROKI.length && !this.przerwany; i++) await this._krok(i);
      wynik = await this._zapisz();
    } finally {
      api.st.poKlatce = null;
      window.removeEventListener('error', this.naBlad);
      window.removeEventListener('unhandledrejection', this.naBlad);
      window.speechSynthesis?.cancel();
      // ustawienia wracają do stanu sprzed testu (test niczego nie zapisuje w ustawieniach)
      Object.assign(api.ust, structuredClone(this.kopiaUstawien));
      api.odswiezPanel(true);
      if (this.koder.state !== 'closed') this.koder.close();
    }
    return wynik;
  }

  async _krok(i) {
    const k = KROKI[i];
    const { api } = this;
    if (k.ust) {
      const kadrPrzed = api.ust.kadr;
      Object.assign(api.ust, structuredClone(k.ust));
      api.odswiezPanel(api.ust.kadr !== kadrPrzed);
    }
    this.krok = i;
    this.kroki.push({ i, id: k.id, odKlatki: this.klatki.length, t: Math.round(performance.now() - this.t0), ust: { warstwy: Object.keys(api.ust.warstwy).filter((w) => api.ust.warstwy[w]).join(','), tryb: api.ust.tryb, odslona: api.ust.odslona, kadr: api.ust.kadr, stabilizacja: api.ust.stabilizacja } });
    document.querySelector('#testKrok').textContent = `Krok ${i + 1} z ${KROKI.length}`;
    document.querySelector('#testTekst').textContent = k.tekst;
    const pasek = document.querySelector('#testPasek i');
    pasek.style.width = '0%';
    await this._powiedz(k.tekst);
    const czas = (this.szybko ? Math.min(1.2, k.czas * 0.15) : k.czas) * 1000;
    const start = performance.now();
    while (performance.now() - start < czas && !this.przerwany) {
      pasek.style.width = Math.min(100, ((performance.now() - start) / czas) * 100) + '%';
      await czekaj(80);
    }
  }

  // Czyta instrukcję na głos (po polsku, jeśli system ma polski głos). Wraca, gdy skończy, najpóźniej po 9 sekundach.
  _powiedz(tekst) {
    if (this.szybko || !window.speechSynthesis) return czekaj(this.szybko ? 50 : 2500);
    return new Promise((ok) => {
      const u = new SpeechSynthesisUtterance(tekst);
      const glosy = speechSynthesis.getVoices();
      const pl = glosy.find((g) => g.lang?.toLowerCase().startsWith('pl'));
      if (pl) u.voice = pl;
      u.lang = 'pl-PL';
      u.rate = 1.05;
      const zegar = setTimeout(ok, 9000);
      u.onend = u.onerror = () => {
        clearTimeout(zegar);
        ok();
      };
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    });
  }

  // Wywoływane z pętli głównej po każdej przetworzonej klatce: koduje surowy obraz i zapisuje pomiary.
  _poKlatce({ krokMs, obs, ciecie, meta, teraz }) {
    const { api } = this;
    const nr = this.klatki.length;
    try {
      const kl = new VideoFrame(api.plotnoKlatki, { timestamp: Math.round((nr * 1e6) / 30), duration: Math.round(1e6 / 30) });
      this.koder.encode(kl, { keyFrame: nr % 30 === 0 });
      kl.close();
    } catch (e) {
      this.bledy.push({ t: Math.round(teraz - this.t0), tekst: 'klatka: ' + e.message });
    }
    const info = api.st.info || {};
    const sur = obs?.surowe || {};
    const c = api.sledzenie.czasy;
    const pokazane = meta?.presentedFrames ?? null;
    this.klatki.push({
      t: Math.round(teraz - this.t0),
      dt: +(teraz - this.poprzT).toFixed(1),
      krok: this.krok,
      ms: +krokMs.toFixed(1),
      cz: [+c.poza.toFixed(1), +c.twarz.toFixed(1), +c.dlonie.toFixed(1)],
      // ile klatek kamery minęło od poprzedniej przetworzonej (1 = żadna nie przepadła) i ile ms od zdjęcia do przetworzenia
      kam: pokazane !== null && this.poprzPokazane !== null ? pokazane - this.poprzPokazane : null,
      opk: meta?.captureTime ? Math.round(teraz - meta.captureTime) : null,
      kol: this.koder.encodeQueueSize,
      c: ciecie ? 1 : 0,
      tw: sur.twarz ? 1 : 0,
      pz: sur.poza ? 1 : 0,
      dl: (sur.dlonie || []).map((d) => (d ? d.strona : '-')).join(''),
      zg: info.zrodloGlowy || '',
      mt: info.maTulow ? 1 : 0,
      sg: +(info.skalaGlowy || 0).toFixed(3),
      g: +(info.g || 0).toFixed(3),
      ogn: Math.round(info.ogniskowa || 0),
      zu: +(((info.katZuchwy || 0) * 180) / Math.PI).toFixed(1),
      usta: sur.twarz ? +(sur.twarz.usta || 0).toFixed(2) : null,
      roz: (info.dlonie || []).map((d) => d.strona + d.rozstaw.toFixed(2)).join(' '),
      reka: api.st.reka ? api.st.reka.strona + (api.st.reka.jest ? '' : '?') : '',
    });
    this.poprzT = teraz;
    this.poprzPokazane = pokazane;
  }

  async _zapisz() {
    const { api } = this;
    document.querySelector('#testKrok').textContent = this.przerwany ? 'Test przerwany' : 'Koniec testu';
    document.querySelector('#testTekst').textContent = 'Zapisuję nagranie i pomiary. Nie zamykaj karty.';
    if (!this.szybko && window.speechSynthesis && !this.przerwany) this._powiedz('Koniec testu. Zapisuję nagranie.');
    api.st.poKlatce = null;
    await this.koder.flush();
    this.muxer.finalize();
    const d = new Date();
    const dwa = (n) => String(n).padStart(2, '0');
    const nazwa = `kamera-${d.getFullYear()}${dwa(d.getMonth() + 1)}${dwa(d.getDate())}-${dwa(d.getHours())}${dwa(d.getMinutes())}${dwa(d.getSeconds())}`;
    const film = new Blob([this.muxer.target.buffer], { type: 'video/mp4' });
    const opis = {
      nazwa,
      start: d.toISOString(),
      przegladarka: navigator.userAgent,
      kamera: api.kamera(),
      obraz: [api.plotnoKlatki.width, api.plotnoKlatki.height],
      przerwany: this.przerwany,
      szybko: this.szybko,
      trwanie: Math.round((performance.now() - this.t0) / 1000),
      kroki: this.kroki,
      klatki: this.klatki,
      bledy: this.bledy,
    };
    const a = await fetch(`/__zrzut?nazwa=${nazwa}&typ=mp4&kat=test`, { method: 'POST', body: film });
    const b = await fetch(`/__zrzut?nazwa=${nazwa}&typ=json`, { method: 'POST', body: JSON.stringify(opis) });
    const ok = a.ok && b.ok;
    document.querySelector('#testTekst').textContent = ok
      ? `Zapisane: ${nazwa} (${this.klatki.length} klatek, ${(film.size / 1e6).toFixed(0)} MB). Wróć do rozmowy z Claude i napisz, że test jest gotowy.`
      : 'Nie udało się zapisać plików. Sprawdź, czy serwer aplikacji działa (npm run dev), i powtórz test.';
    document.querySelector('#testStop').textContent = 'Zamknij';
    document.querySelector('#testStop').onclick = () => (this.el.hidden = true);
    return { ok, nazwa, klatek: this.klatki.length, rozmiar: film.size, bledy: this.bledy.length };
  }
}
