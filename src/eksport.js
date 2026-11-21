// Eksport całego nagrania klatka po klatce: film jest przewijany co 1/30 s, każda klatka przechodzi
// śledzenie i rysowanie, a gotowy obraz trafia do kodera H.264. Nie zależy od tempa komputera,
// więc nie gubi klatek, a dźwięk z oryginału zostaje zsynchronizowany.
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

const przewin = (wideo, t) =>
  new Promise((ok) => {
    if (Math.abs(wideo.currentTime - t) < 1e-4 && wideo.readyState >= 2) return ok();
    wideo.addEventListener('seeked', ok, { once: true });
    wideo.currentTime = t;
  });

async function dzwiekZPliku(wideo) {
  try {
    const dane = await (await fetch(wideo.currentSrc || wideo.src)).arrayBuffer();
    const kontekst = new (window.AudioContext || window.webkitAudioContext)();
    const bufor = await kontekst.decodeAudioData(dane);
    kontekst.close();
    return bufor;
  } catch {
    return null; // plik bez ścieżki dźwiękowej albo w formacie, którego przeglądarka nie dekoduje
  }
}

// krokowo: obiekt z main.js (start, klatka, dociag, koniec). Wynik wychodzi z opóźnieniem kilku klatek,
// bo wygładzanie ruchu korzysta z klatek po obu stronach tej, która trafia do pliku.
// przedKlatka(t): wołane przed policzeniem klatki, która wyjdzie do pliku w chwili t filmu (do zmiany ustawień w czasie).
// odKlatki, doKlatki: zakres klatek filmu (jedno ujęcie), domyślnie całość.
// zapisz(blob, nazwa): jeśli podane, plik idzie tam zamiast do pobrania przez przeglądarkę. przeplywnosc w bitach na sekundę.
export async function eksportujNagranie({ wideo, plotno, stan, zDzwiekiem, krokowo, opoznienie, postep, kls = 30, przedKlatka = null, zapisz = null, przeplywnosc = 14_000_000, odKlatki = 0, doKlatki = null }) {
  if (!('VideoEncoder' in window)) throw new Error('ta przeglądarka nie ma kodera wideo (potrzebny Chrome)');
  // tryb krokowy ustawia też wymiary płótna według bieżącego kadru, więc czytamy je dopiero po nim
  krokowo.start(opoznienie);
  const szer = plotno.width;
  const wys = plotno.height;
  const dlugosc = wideo.duration;
  if (!Number.isFinite(dlugosc) || !(dlugosc > 0)) {
    krokowo.koniec();
    throw new Error('nie znam długości tego nagrania');
  }
  const PRZEPLYWNOSC = przeplywnosc;
  if ((dlugosc * PRZEPLYWNOSC) / 8 > 1.5e9) {
    krokowo.koniec();
    throw new Error('nagranie jest za długie na jeden eksport (ponad ok. 14 minut), podziel je na części');
  }
  const wszystkich = Math.max(1, Math.floor(dlugosc * kls));
  const pierwsza = Math.max(0, Math.min(wszystkich - 1, odKlatki));
  const ileKlatek = Math.max(1, Math.min(wszystkich, doKlatki ?? wszystkich) - pierwsza);
  const bylaPauza = wideo.paused;
  const czasPrzed = wideo.currentTime;
  wideo.pause();

  postep(0, 'przygotowanie');
  const dzwiek = zDzwiekiem ? await dzwiekZPliku(wideo) : null;
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: szer, height: wys, frameRate: kls },
    audio: dzwiek ? { codec: 'aac', numberOfChannels: Math.min(2, dzwiek.numberOfChannels), sampleRate: dzwiek.sampleRate } : undefined,
    fastStart: 'in-memory',
  });
  let bladKodera = null;
  const koder = new VideoEncoder({ output: (porcja, meta) => muxer.addVideoChunk(porcja, meta), error: (e) => (bladKodera = e) });
  koder.configure({ codec: 'avc1.64002A', width: szer, height: wys, bitrate: PRZEPLYWNOSC, framerate: kls });

  let wyszlo = 0;
  const zakoduj = () => {
    const klatka = new VideoFrame(plotno, { timestamp: Math.round((wyszlo * 1e6) / kls), duration: Math.round(1e6 / kls) });
    koder.encode(klatka, { keyFrame: wyszlo % (kls * 2) === 0 });
    klatka.close();
    wyszlo++;
  };
  const start = performance.now();
  try {
    // rozbieg: pierwsze klatki przeliczone na sucho, żeby śledzenie było pewne już od pierwszej klatki pliku
    for (let i = 0; i < Math.min(5, ileKlatek); i++) {
      await przewin(wideo, Math.min(dlugosc - 0.001, (pierwsza + i + 0.5) / kls));
      krokowo.rozbieg(kls);
    }
    for (let i = 0; i < ileKlatek; i++) {
      if (stan.przerwij || bladKodera) break;
      // środek klatki, a nie jej granica: na granicy przeglądarka potrafi oddać poprzednią klatkę i film się zacina
      await przewin(wideo, Math.min(dlugosc - 0.001, (pierwsza + i + 0.5) / kls));
      // do pliku wychodzi teraz klatka sprzed `opoznienie` klatek, więc ustawienia dobieramy do jej czasu
      if (przedKlatka) przedKlatka(Math.max(0, (pierwsza + i - opoznienie + 0.5) / kls));
      if (krokowo.klatka(kls)) zakoduj();
      // koder nie może dostać więcej, niż zdąży przerobić
      while (koder.encodeQueueSize > 4) await new Promise((ok) => setTimeout(ok, 4));
      if (i % 5 === 0) {
        const minelo = (performance.now() - start) / 1000;
        const zostalo = (minelo / (i + 1)) * (ileKlatek - i - 1);
        postep((i + 1) / ileKlatek, `zostało ok. ${Math.ceil(zostalo)} s`);
        await new Promise((ok) => setTimeout(ok, 0));
      }
    }
    // klatki, które jeszcze czekają w buforze wygładzania
    if (!stan.przerwij && !bladKodera) {
      for (;;) {
        if (przedKlatka) przedKlatka((pierwsza + wyszlo + 0.5) / kls);
        if (!krokowo.dociag(kls)) break;
        zakoduj();
      }
    }
  } finally {
    krokowo.koniec();
  }
  const przerwano = stan.przerwij;
  try {
    if (bladKodera) throw bladKodera;
    if (!przerwano) {
      await koder.flush();
      if (dzwiek) {
        postep(1, 'dźwięk');
        const kan = Math.min(2, dzwiek.numberOfChannels);
        const koderD = new AudioEncoder({ output: (porcja, meta) => muxer.addAudioChunk(porcja, meta), error: (e) => (bladKodera = e) });
        koderD.configure({ codec: 'mp4a.40.2', numberOfChannels: kan, sampleRate: dzwiek.sampleRate, bitrate: 160_000 });
        const ile = Math.min(dzwiek.length, Math.floor((wyszlo / kls) * dzwiek.sampleRate));
        const PORCJA = 8192;
        for (let od = 0; od < ile; od += PORCJA) {
          const n = Math.min(PORCJA, ile - od);
          const dane = new Float32Array(n * kan);
          for (let k = 0; k < kan; k++) dane.set(dzwiek.getChannelData(k).subarray(od, od + n), k * n);
          const ad = new AudioData({ format: 'f32-planar', sampleRate: dzwiek.sampleRate, numberOfFrames: n, numberOfChannels: kan, timestamp: Math.round((od / dzwiek.sampleRate) * 1e6), data: dane });
          koderD.encode(ad);
          ad.close();
        }
        await koderD.flush();
        koderD.close();
      }
    }
  } finally {
    if (koder.state !== 'closed') koder.close();
    // powrót do miejsca, w którym film był przed eksportem
    await przewin(wideo, czasPrzed);
    if (!bylaPauza) wideo.play().catch(() => {});
  }
  if (przerwano) return null;
  if (bladKodera) throw bladKodera;
  muxer.finalize();
  const d = new Date();
  const dwa = (n) => String(n).padStart(2, '0');
  const nazwa = `lustro-rentgen-${d.getFullYear()}${dwa(d.getMonth() + 1)}${dwa(d.getDate())}-${dwa(d.getHours())}${dwa(d.getMinutes())}${dwa(d.getSeconds())}.mp4`;
  const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
  if (zapisz) {
    await zapisz(blob, nazwa);
    return nazwa;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nazwa;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  return nazwa;
}
