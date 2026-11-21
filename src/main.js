// Lustro rentgenowskie: pętla główna, źródło obrazu, panel i nagrywanie.
//
// Przebieg jednej klatki: kopia obrazu z kamery albo pliku trafia na płótno, z tego samego płótna korzysta śledzenie
// i wyświetlanie (anatomia nigdy nie jest liczona z innej klatki niż ta, którą widać). Wynik śledzenia idzie do bufora,
// a na ekran wychodzi klatka sprzed kilku klatek, wygładzona oknem po obu jej stronach.
import { wczytajAnatomie, Scena, WARSTWY } from './scena.js';
import { Rig } from './rig.js';
import { Sledzenie } from './sledzenie.js';
import { Etykiety } from './etykiety.js';
import { Bufor } from './bufor.js';
import { ToryDloni, srodekOpuszkow } from './dlonie.js';
import { CZESCI, GRUPY, NR_CZESCI } from './czesci.js';
import { StraznikPozy, StraznikStron } from './straznik.js';
import { Zanik } from './filtry.js';
import { ogranicz, gladki } from './matma.js';
import { eksportujNagranie } from './eksport.js';
import { TestKamery } from './test-kamery.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const adres = new URLSearchParams(location.search);

const DOMYSLNE = {
  warstwy: { kosci: true, miesnie: false, narzady: false, naczynia: false, mozg: true, oczy: true, skora: true },
  podpisy: true,
  tryb: 'rentgen',
  jasnosc: 1,
  przenikanie: 0.3,
  pioro: 18,
  odslona: 'calosc',
  ciecie: 0,
  zasiegSoczewki: 0.5, // promień soczewki przy w pełni otwartej dłoni, jako część wysokości obrazu
  gest: true,
  czesci: null, // null: całe ciało, inaczej lista zaznaczonych części (identyfikatory z czesci.js)
  wielkoscPodpisow: 1,
  ilePodpisow: 13, // najwięcej podpisów w jednej kolumnie
  odliczanie: false, // 3 sekundy przed startem nagrywania
  modelSylwetki: 'auto', // 'auto' | 'szybki' | 'dokladny': który model sylwetki pracuje (opis przy chcianyDokladnyModel)
  zakladka: 'warstwy', // otwarta zakładka panelu
  panel: true, // czy panel ustawień jest widoczny
  lustro: true,
  kadr: 'poziomy',
  rozdzielczosc: '1080',
  stabilizacja: 'zrownowazona',
  dane: false,
  dzwiek: false,
  perspektywa: 1,
  dop: { rozmiar: 1, szer: 1, wys: 1, gleb: 1, x: 0, y: 0, z: 0 },
};
const ZESTAWY = {
  szkielet: ['kosci', 'skora'],
  miesnie: ['miesnie', 'skora'],
  narzady: ['narzady', 'naczynia', 'kosci', 'skora'],
  glowa: ['mozg', 'oczy', 'kosci', 'skora'],
  wszystko: WARSTWY,
};
// o ile klatek obraz wychodzi później niż przyszedł; w zamian ruch jest wygładzony bez opóźnienia względem obrazu
const OPOZNIENIE = { szybka: 0, zrownowazona: 2, maksymalna: 4 };
const OPOZNIENIE_EKSPORTU = 4;
// rozstaw opuszków (względem wielkości dłoni), przy którym soczewka jest zamknięta i w pełni otwarta
// (na nagraniu z gestem: palce zebrane 0,20, dłoń otwarta 0,80)
const ROZSTAW_MIN = 0.26;
const ROZSTAW_MAKS = 0.72;
const KLUCZ = 'lustro-rentgen-ustawienia-2';
const ZAKLADKI = ['warstwy', 'czesci', 'odslona', 'obraz', 'glowa', 'zapis', 'kontrola'];
const MA_RVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
const BEZ_BIODER = adres.has('bezbioder');

function wczytajUstawienia() {
  const u = structuredClone(DOMYSLNE);
  try {
    const z = JSON.parse(localStorage.getItem(KLUCZ) || 'null');
    if (z) {
      Object.assign(u, z, { warstwy: { ...u.warstwy, ...z.warstwy }, dop: { ...u.dop, ...z.dop } });
    }
  } catch {
    /* brak zapisanych ustawień */
  }
  if (!(u.stabilizacja in OPOZNIENIE)) u.stabilizacja = DOMYSLNE.stabilizacja;
  if (!ZAKLADKI.includes(u.zakladka)) u.zakladka = DOMYSLNE.zakladka;
  return u;
}
const ust = wczytajUstawienia();
const zapisz = () => {
  try {
    localStorage.setItem(KLUCZ, JSON.stringify(ust));
  } catch {
    /* pamięć przeglądarki niedostępna */
  }
};

const plotno = $('#plotno');
const wideo = $('#wideo');
const stanEl = $('#stan');
// kopia bieżącej klatki obrazu: z niej korzysta i śledzenie, i wyświetlanie
const plotnoKlatki = document.createElement('canvas');
const ctxKlatki = plotnoKlatki.getContext('2d', { alpha: false });
const st = {
  zrodlo: null, // 'kamera' | 'plik'
  strumien: null,
  pokolenie: 0,
  nowaKlatka: false,
  ciecie: false, // najbliższa klatka zaczyna od zera (nowe źródło, przewinięcie, zmiana kadru)
  ciecieRigu: false,
  W: 1920,
  H: 1080,
  kadr: { k: 1, ox: 0, oy: 0, vw: 1920, vh: 1080 },
  kluczWymiarow: '',
  slotWgrany: -1,
  slotPokazu: -1,
  obs: null,
  info: null,
  soczewka: null,
  liniaPoprz: null,
  zGlowy: false,
  kls: 0,
  czasToru: 0,
  znacznik: 0,
  nrKlatki: 0,
  czasOstatniej: 0,
  czasRysunku: 0,
  czasWideo: 0,
  ozywienieDo: 0,
  czasKroku: 0,
  spoczynek: adres.has('spoczynek'),
  katSpoczynku: +(adres.get('kat') ?? 'NaN'),
  eksport: null,
  krokowo: null,
};
let anat, rig, scena, etykiety;
const sledzenie = new Sledzenie();
const bufor = new Bufor();
const toryDloni = new ToryDloni();
const straznik = new StraznikPozy();
const straznikStron = new StraznikStron();
const zanikLinii = new Zanik(0.3);
const opoznienie = () => OPOZNIENIE[ust.stabilizacja] ?? 2;
const ozyw = (ms = 900) => (st.ozywienieDo = Math.max(st.ozywienieDo, performance.now() + ms));

// ---------- komunikaty ----------
let zegarKomunikatu = null;
function komunikat(tekst, trwaly = false) {
  const el = $('#komunikat');
  if (!el) return;
  clearTimeout(zegarKomunikatu);
  el.textContent = tekst || '';
  el.hidden = !tekst;
  if (tekst && !trwaly) zegarKomunikatu = setTimeout(() => (el.hidden = true), 7000);
}
let ileBledow = 0;
function zglosBlad(e) {
  ileBledow++;
  if (ileBledow <= 5) console.error(e);
  komunikat('Wystąpił błąd: ' + (e?.message || e) + '. Jeśli obraz stanął, odśwież stronę.', true);
}
window.addEventListener('error', (e) => zglosBlad(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => zglosBlad(e.reason));

// ---------- panel ----------
// ustawienia, po których bieżącą klatkę trzeba policzyć od nowa
const OD_NOWA = new Set(['kadr', 'rozdzielczosc', 'stabilizacja']);
// suwaki: [id pola, klucz ustawienia, opis wartości]
const SUWAKI = [
  ['jasnosc', 'jasnosc', (v) => Math.round(v * 100) + '%'],
  ['przenikanie', 'przenikanie', (v) => Math.round(v * 100) + '%'],
  ['pioro', 'pioro', (v) => v + ' px'],
  ['ciecie', 'ciecie', (v) => (v > 0 ? '+' : '') + Math.round(v * 100)],
  ['soczewka', 'zasiegSoczewki', (v) => Math.round(v * 100) + '% wysokości'],
  ['wielkoscPodpisow', 'wielkoscPodpisow', (v) => Math.round(v * 100) + '%'],
  ['ilePodpisow', 'ilePodpisow', (v) => String(v)],
];
// odNowa: po zmianie kadru albo opóźnienia bieżącą klatkę trzeba policzyć jeszcze raz
function odswiezPanel(odNowa = false) {
  ozyw();
  if (odNowa === true) {
    st.ciecie = true;
    st.nowaKlatka = true;
  }
  // zakładki: widać jedną naraz, a panel da się schować
  for (const b of $$('#zakladki [data-zakladka]')) b.classList.toggle('wybrany', ust.panel && b.dataset.zakladka === ust.zakladka);
  for (const sek of $$('#panel [data-panel]')) sek.hidden = sek.dataset.panel !== ust.zakladka;
  $('#aplikacja').classList.toggle('bezPanelu', !ust.panel);
  for (const el of $$('[data-warstwa]')) el.checked = !!ust.warstwy[el.dataset.warstwa];
  for (const el of $$('[data-znacznik]')) el.checked = !!ust[el.dataset.znacznik];
  for (const g of $$('[data-ust]')) for (const b of g.querySelectorAll('button')) b.classList.toggle('wybrany', String(ust[g.dataset.ust]) === b.dataset.wart);
  for (const [id, klucz, opis] of SUWAKI) {
    const el = $('#' + id);
    el.value = ust[klucz];
    el.parentElement.querySelector('output').textContent = opis(ust[klucz]);
  }
  // sylwetka z częściami ciała: w lustrze lewa strona osoby jest po lewej stronie ekranu
  const wyb = ust.czesci ? new Set(ust.czesci) : null;
  $('#sylwetka').classList.toggle('cale', !wyb);
  $('#sylwetka').classList.toggle('lustro', !!ust.lustro);
  for (const el of $$('#sylwetka [data-czesc]')) el.classList.toggle('wybrana', !!wyb && wyb.has(el.dataset.czesc));
  for (const b of $$('[data-grupa]')) {
    const g = b.dataset.grupa;
    b.classList.toggle('wybrany', g === 'cale' ? !wyb : !!wyb && GRUPY[g].every((c) => wyb.has(c)));
  }
  $('#stronaLewa').textContent = ust.lustro ? 'lewa strona' : 'prawa strona';
  $('#stronaPrawa').textContent = ust.lustro ? 'prawa strona' : 'lewa strona';
  $('#czesciOpis').textContent = wyb ? 'Zaznaczone: ' + CZESCI.filter((c) => wyb.has(c.id)).map((c) => c.pl.toLowerCase()).join(', ') + '.' : 'Zaznaczone: całe ciało.';
  const soczewka = ust.odslona === 'soczewka';
  $('#wierszCiecia').hidden = ust.odslona === 'calosc' || soczewka;
  $('#wierszSoczewki').hidden = !soczewka;
  $('#wierszGestu').hidden = !soczewka;
  $('#opisSoczewki').hidden = !soczewka;
  $('#daneTekst').hidden = !ust.dane;
  for (const el of $$('[data-dop]')) {
    const k = el.dataset.dop;
    el.value = ust.dop[k];
    const o = el.parentElement.querySelector('output');
    o.textContent = ['x', 'y', 'z'].includes(k) ? (ust.dop[k] / 10).toFixed(1).replace('.', ',') + ' cm' : Math.round(ust.dop[k] * 100) + '%';
  }
}
// wspólna reakcja na każdą zmianę ustawień; odNowa: true (policz klatkę od nowa) albo 'rig' (przelicz samo ustawienie kości)
function zmiana(odNowa = false) {
  odswiezPanel();
  zapisz();
  ozyw();
  if (odNowa === 'rig') st.przeliczRig = true;
  else if (odNowa) {
    st.ciecie = true;
    st.nowaKlatka = true;
  }
}
function przelaczWarstwe(w) {
  ust.warstwy[w] = !ust.warstwy[w];
  zmiana();
}
function podlaczPanel() {
  for (const b of $$('#zakladki [data-zakladka]'))
    b.addEventListener('click', () => {
      // kliknięcie otwartej zakładki chowa panel
      if (ust.panel && ust.zakladka === b.dataset.zakladka) ust.panel = false;
      else {
        ust.zakladka = b.dataset.zakladka;
        ust.panel = true;
      }
      zmiana();
    });
  $('#btnPanel').addEventListener('click', () => {
    ust.panel = !ust.panel;
    zmiana();
  });
  for (const el of $$('[data-warstwa]'))
    el.addEventListener('change', () => {
      ust.warstwy[el.dataset.warstwa] = el.checked;
      zmiana();
    });
  for (const b of $$('[data-zestaw]'))
    b.addEventListener('click', () => {
      for (const w of WARSTWY) ust.warstwy[w] = ZESTAWY[b.dataset.zestaw].includes(w);
      zmiana();
    });
  for (const g of $$('[data-ust]'))
    for (const b of g.querySelectorAll('button'))
      b.addEventListener('click', () => {
        ust[g.dataset.ust] = b.dataset.wart;
        zmiana(OD_NOWA.has(g.dataset.ust));
        if (g.dataset.ust === 'modelSylwetki') {
          st.modelZaWolny = false;
          st.wolneKroki = 0;
          wymienModelSylwetki();
        }
      });
  for (const el of $$('[data-znacznik]'))
    el.addEventListener('change', () => {
      ust[el.dataset.znacznik] = el.checked;
      zmiana();
    });
  for (const [id, klucz] of SUWAKI)
    $('#' + id).addEventListener('input', (e) => {
      ust[klucz] = +e.target.value;
      zmiana();
    });
  // Części ciała. Z całego ciała pierwsze kliknięcie zostawia tylko klikniętą część, następne dodają albo odejmują.
  const kliknijCzesci = (ids) => {
    let wyb = ust.czesci ? new Set(ust.czesci) : null;
    if (!wyb) wyb = new Set(ids);
    else if (ids.every((c) => wyb.has(c))) for (const c of ids) wyb.delete(c);
    else for (const c of ids) wyb.add(c);
    ust.czesci = wyb.size === 0 || wyb.size === CZESCI.length ? null : [...wyb];
    zmiana();
  };
  for (const el of $$('#sylwetka [data-czesc]')) {
    const opis = CZESCI.find((c) => c.id === el.dataset.czesc);
    const tytul = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    tytul.textContent = opis ? opis.pl : '';
    el.appendChild(tytul);
    el.addEventListener('click', () => kliknijCzesci([el.dataset.czesc]));
  }
  for (const b of $$('[data-grupa]'))
    b.addEventListener('click', () => {
      if (b.dataset.grupa === 'cale') {
        ust.czesci = null;
        zmiana();
      } else kliknijCzesci(GRUPY[b.dataset.grupa]);
    });
  for (const el of $$('[data-dop]'))
    el.addEventListener('input', () => {
      ust.dop[el.dataset.dop] = +el.value;
      zmiana('rig');
    });
  $('#zerujDop').addEventListener('click', () => {
    ust.dop = structuredClone(DOMYSLNE.dop);
    zmiana('rig');
  });
  $('#btnReset').addEventListener('click', () => {
    const zakladka = ust.zakladka;
    for (const k of Object.keys(ust)) delete ust[k];
    Object.assign(ust, structuredClone(DOMYSLNE), { zakladka });
    komunikat('Ustawienia wróciły do domyślnych.');
    zmiana(true);
  });
  odswiezPanel();
}
// Model sylwetki. Dokładny (cięższy) nie gubi rąk i nóg w szybkim ruchu, ale liczy klatkę ok. 12 ms dłużej.
// W trybie automatycznym pracuje dokładny, dopóki komputer nadąża; gdy przez 3 sekundy klatka liczy się dłużej,
// niż pozwala płynny obraz, program wraca do szybkiego. Do testów: ?ciezki i ?szybki wymuszają model na czas sesji.
const WYMUSZONY_MODEL = adres.has('ciezki') ? 'dokladny' : adres.has('szybki') ? 'szybki' : null;
const PROG_WOLNEJ_KLATKI = 36; // ms na klatkę, powyżej tego obraz spada poniżej ok. 27 kl./s
function chcianyDokladnyModel() {
  const tryb = WYMUSZONY_MODEL || ust.modelSylwetki;
  if (tryb === 'dokladny') return true;
  if (tryb === 'szybki') return false;
  return !st.modelZaWolny || !!st.eksport;
}
// Wymiana modelu po zmianie w panelu. Wczytanie trwa chwilę, przez ten czas pracuje poprzedni model.
let wymianaModelu = false;
async function wymienModelSylwetki(cicho = false) {
  if (!sledzenie.gotowe || wymianaModelu) return;
  wymianaModelu = true;
  let zmieniony = false;
  try {
    // pętla, bo ustawienie można cofnąć w trakcie wczytywania
    while (sledzenie.ciezki !== chcianyDokladnyModel()) {
      const dokladny = chcianyDokladnyModel();
      if (!cicho) komunikat(dokladny ? 'Wczytuję dokładny model sylwetki.' : 'Wracam do szybkiego modelu sylwetki.', true);
      await sledzenie.ustawCiezkiModel(dokladny);
      zmieniony = true;
    }
    if (zmieniony && !cicho) komunikat(sledzenie.ciezki ? 'Dokładny model sylwetki działa.' : 'Szybki model sylwetki działa.');
  } catch (e) {
    komunikat('Nie udało się wczytać modelu sylwetki: ' + (e?.message || e), true);
  } finally {
    wymianaModelu = false;
  }
  if (zmieniony) zmiana(true);
}
// Tryb automatyczny: co pół sekundy sprawdza, czy komputer nadąża z dokładnym modelem na żywym obrazie.
function pilnujTempaModelu() {
  const naZywo = st.zrodlo && !st.zamrozone && !st.eksport && !st.krokowo && !test && st.kls > 5 && !document.hidden;
  if (!naZywo || !sledzenie.ciezki || (WYMUSZONY_MODEL || ust.modelSylwetki) !== 'auto' || wymianaModelu) {
    st.wolneKroki = 0;
    return;
  }
  st.wolneKroki = st.czasKroku > PROG_WOLNEJ_KLATKI ? (st.wolneKroki || 0) + 1 : 0;
  if (st.wolneKroki >= 6) {
    st.modelZaWolny = true;
    st.wolneKroki = 0;
    wymienModelSylwetki(true).then(() => komunikat('Ten komputer nie nadąża z dokładnym modelem sylwetki, więc pracuje szybki. Możesz to zmienić w zakładce Obraz.'));
  }
}
// Średnia jasność klatki (0 do 255), liczona z miniatury 16×9 i wygładzana. W ciemnym pokoju kamera wydłuża naświetlanie,
// szybkie ruchy wychodzą rozmazane i śledzenie stawia rękę obok prawdziwej. Tego nie da się naprawić po stronie
// programu, więc mówimy o tym wprost.
const plotnoJasnosci = document.createElement('canvas');
plotnoJasnosci.width = 16;
plotnoJasnosci.height = 9;
const ctxJasnosci = plotnoJasnosci.getContext('2d', { willReadFrequently: true });
function zmierzJasnosc() {
  if (!st.zrodlo || plotnoKlatki.width < 2) return;
  ctxJasnosci.drawImage(plotnoKlatki, 0, 0, 16, 9);
  const d = ctxJasnosci.getImageData(0, 0, 16, 9).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const j = s / (d.length / 4);
  st.jasnosc = st.jasnosc == null ? j : st.jasnosc + (j - st.jasnosc) * 0.3;
}
const PROG_CIEMNOSCI = 48;
// pasek stanu na dole i podpowiedź, gdy w kadrze nikogo nie ma albo gdy jest za ciemno na pewne śledzenie
function odswiezStan() {
  const o = st.obs;
  $('#stTwarz').classList.toggle('jest', !!o?.twarz);
  $('#stSylwetka').classList.toggle('jest', !!o?.poza);
  $('#stDlonie').classList.toggle('jest', !!o?.dlonie.length);
  $('#stTempo').textContent = st.zrodlo ? `${st.kls.toFixed(0)} kl./s, ${st.czasKroku.toFixed(0)} ms na klatkę` : '';
  zmierzJasnosc();
  pilnujTempaModelu();
  const czynne = st.zrodlo && !test && !st.zamrozone;
  const pusto = czynne && (st.czasBezOsoby || 0) > 1.5;
  const ciemno = czynne && !pusto && st.zrodlo === 'kamera' && st.jasnosc != null && st.jasnosc < PROG_CIEMNOSCI;
  const el = $('#podpowiedz');
  const tekst = pusto
    ? 'Nie widzę nikogo w kadrze. Stań tak, żeby było widać twarz albo sylwetkę.'
    : ciemno
      ? 'Jest ciemno, więc kamera rozmazuje szybkie ruchy i anatomia odstaje od rąk. Doświetl się od przodu.'
      : '';
  if (tekst && el.textContent !== tekst) el.textContent = tekst;
  el.hidden = !tekst;
}
// nazwa pliku z datą i pobranie go przez przeglądarkę
function nazwaPliku(rozszerzenie) {
  const d = new Date();
  const dwa = (n) => String(n).padStart(2, '0');
  return `lustro-rentgen-${d.getFullYear()}${dwa(d.getMonth() + 1)}${dwa(d.getDate())}-${dwa(d.getHours())}${dwa(d.getMinutes())}${dwa(d.getSeconds())}.${rozszerzenie}`;
}
function pobierz(blob, nazwa) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nazwa;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
// zdjęcie bieżącego obrazu: płótno trzeba odczytać zaraz po narysowaniu, więc robi to rysuj()
function zrobZdjecie() {
  st.zdjecie = true;
  ozyw(300);
}
// stopklatka: obraz z kamery staje na bieżącej klatce (ustawienia dalej działają), przy pliku to zwykła pauza
function stopklatka() {
  if (st.zrodlo === 'plik') {
    if (wideo.paused) wideo.play().catch(() => {});
    else wideo.pause();
    return;
  }
  if (st.zrodlo !== 'kamera') return;
  st.zamrozone = !st.zamrozone;
  if (st.zamrozone) st.dogon = true;
  else {
    st.ciecie = true;
    st.nowaKlatka = true;
  }
  $('#btnStop').textContent = st.zamrozone ? 'Wznów obraz' : 'Stopklatka';
  $('#btnStop').classList.toggle('wybrany', st.zamrozone);
}
function pelnyEkran() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('#ramka').requestFullscreen?.().catch(() => {});
}
const czekaj = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ---------- źródło obrazu ----------
let adresPliku = null;
function zatrzymajZrodlo() {
  st.pokolenie++;
  if (st.strumien) {
    for (const t of st.strumien.getTracks()) {
      t.onended = null;
      t.stop();
    }
  }
  st.strumien = null;
  if (st.atrapa) {
    st.atrapa.pause();
    st.atrapa = null;
  }
  wideo.pause();
  wideo.removeAttribute('src');
  wideo.srcObject = null;
  if (adresPliku) URL.revokeObjectURL(adresPliku);
  adresPliku = null;
  st.zrodlo = null;
  st.obs = null;
  st.zamrozone = false;
  bufor.zeruj();
  toryDloni.zeruj();
  $('#btnStop').hidden = true;
  $('#btnKamera').classList.remove('wybrany');
  $('#btnPlik').classList.remove('wybrany');
  $('#stZrodlo').textContent = 'Brak źródła obrazu';
}
function poStarcieZrodla(rodzaj) {
  st.zrodlo = rodzaj;
  st.ciecie = true;
  st.nowaKlatka = true;
  st.czasWideo = 0;
  st.soczewka = null;
  rig.zeruj(true);
  $('#start').hidden = true;
  $('#start').style.display = 'none';
  $('#sterowaniePliku').hidden = rodzaj !== 'plik';
  $('#btnEksport').hidden = rodzaj !== 'plik';
  $('#btnGraj').textContent = wideo.paused ? 'Odtwórz' : 'Pauza';
  $('#btnStop').hidden = rodzaj !== 'kamera';
  $('#btnStop').textContent = 'Stopklatka';
  $('#btnStop').classList.remove('wybrany');
  $('#btnKamera').classList.toggle('wybrany', rodzaj === 'kamera');
  $('#btnPlik').classList.toggle('wybrany', rodzaj === 'plik');
  $('#stZrodlo').textContent = rodzaj === 'kamera' ? 'Kamera na żywo' : `Nagranie z pliku, ${wideo.videoWidth}×${wideo.videoHeight}`;
  st.czasBezOsoby = 0;
  komunikat('');
  if (MA_RVFC) {
    const pok = st.pokolenie;
    const cb = (teraz, meta) => {
      if (pok !== st.pokolenie) return;
      st.nowaKlatka = true;
      st.meta = meta;
      wideo.requestVideoFrameCallback(cb);
    };
    wideo.requestVideoFrameCallback(cb);
  }
}
const BLEDY_KAMERY = {
  NotAllowedError: 'przeglądarka nie ma zgody na kamerę. Kliknij ikonę kamery albo kłódki w pasku adresu, zezwól na dostęp i spróbuj ponownie.',
  NotFoundError: 'nie znaleziono żadnej kamery.',
  NotReadableError: 'kamera jest zajęta przez inny program albo system jej nie udostępnia.',
  AbortError: 'kamera przestała odpowiadać.',
  SecurityError: 'kamera działa tylko pod adresem localhost albo przez https.',
};
async function uruchomStrumien(strumien) {
  st.strumien = strumien;
  wideo.srcObject = strumien;
  wideo.muted = true;
  await wideo.play();
  ust.lustro = true;
  odswiezPanel();
  poStarcieZrodla('kamera');
  const sciezka = strumien.getVideoTracks()[0];
  if (sciezka) {
    sciezka.onended = () => {
      if (st.strumien !== strumien) return;
      zatrzymajZrodlo();
      komunikat('Kamera została odłączona. Wybierz kamerę jeszcze raz albo wczytaj nagranie.', true);
    };
  }
}
async function odswiezListeKamer() {
  try {
    const urz = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const biez = st.strumien?.getVideoTracks()[0]?.getSettings().deviceId;
    // lista kamer ma sens dopiero przy co najmniej dwóch
    $('#wyborKamery').hidden = urz.length < 2;
    $('#wyborKamery').innerHTML = urz.map((d, i) => `<option value="${d.deviceId}" ${d.deviceId === biez ? 'selected' : ''}>${d.label || 'Kamera ' + (i + 1)}</option>`).join('');
  } catch {
    /* lista kamer niedostępna */
  }
}
async function wlaczKamere(idUrzadzenia) {
  const blad = (tekst) => {
    stanEl.textContent = tekst;
    komunikat(tekst, true);
    if (!st.zrodlo) $('#start').style.display = '';
  };
  if (!navigator.mediaDevices?.getUserMedia) return blad('Nie udało się włączyć kamery: ' + BLEDY_KAMERY.SecurityError);
  zatrzymajZrodlo();
  stanEl.textContent = 'Czekam na zgodę na kamerę.';
  const prosba = (id) =>
    navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, ...(id ? { deviceId: { exact: id } } : {}) },
      audio: false,
    });
  let strumien;
  try {
    try {
      strumien = await prosba(idUrzadzenia);
    } catch (e) {
      // wybrana kamera zniknęła: bierzemy domyślną
      if (idUrzadzenia && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) strumien = await prosba(null);
      else throw e;
    }
    await uruchomStrumien(strumien);
    stanEl.textContent = '';
    odswiezListeKamer();
  } catch (e) {
    if (strumien) for (const t of strumien.getTracks()) t.stop();
    blad('Nie udało się włączyć kamery: ' + (BLEDY_KAMERY[e.name] || e.message || e.name));
  }
}
// Do testów bez kamery: nagranie odtwarzane w tle udaje kamerę (ta sama droga co prawdziwy strumień).
async function kameraZPliku(sciezka) {
  zatrzymajZrodlo();
  const v = document.createElement('video');
  v.src = sciezka;
  v.loop = true;
  v.muted = true;
  v.playsInline = true;
  await v.play();
  await uruchomStrumien(v.captureStream());
  st.atrapa = v;
}
async function wczytajPlik(zrodloPliku) {
  zatrzymajZrodlo();
  const zAdresu = typeof zrodloPliku === 'string';
  if (!zAdresu) adresPliku = URL.createObjectURL(zrodloPliku);
  wideo.src = zAdresu ? zrodloPliku : adresPliku;
  wideo.loop = true;
  wideo.muted = true;
  await new Promise((ok, zle) => {
    wideo.onloadeddata = ok;
    wideo.onerror = () => zle(new Error('przeglądarka nie umie odczytać tego pliku (spróbuj MP4 albo MOV).'));
  });
  wideo.onloadeddata = wideo.onerror = null;
  if (!wideo.videoWidth) throw new Error('w tym pliku nie ma obrazu.');
  const t = adres.get('t');
  if (t !== null && zAdresu) {
    wideo.currentTime = +t;
    await new Promise((ok) => wideo.addEventListener('seeked', ok, { once: true }));
  } else {
    await wideo.play().catch(() => {});
  }
  ust.lustro = false; // nagranie pokazujemy tak, jak zostało nagrane
  odswiezPanel();
  poStarcieZrodla('plik');
}

// ---------- nagrywanie ----------
let nagr = null;
async function przelaczNagrywanie() {
  const btn = $('#btnNagraj');
  if (nagr) {
    nagr.rec.stop();
    return;
  }
  if (!window.MediaRecorder || !plotno.captureStream) return komunikat('Ta przeglądarka nie umie nagrywać obrazu. Użyj Chrome.', true);
  const typ = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!typ) return komunikat('Ta przeglądarka nie ma kodera do nagrywania. Użyj Chrome.', true);
  const strum = plotno.captureStream(30);
  let mikrofon = null;
  let audio = null;
  if (ust.dzwiek) {
    try {
      let sciezka = null;
      if (st.zrodlo === 'kamera') {
        mikrofon = await navigator.mediaDevices.getUserMedia({ audio: true });
        sciezka = mikrofon.getAudioTracks()[0];
      } else if (st.zrodlo === 'plik' && wideo.captureStream) {
        sciezka = wideo.captureStream().getAudioTracks()[0];
      }
      if (sciezka) {
        // obraz wychodzi o kilka klatek później niż przyszedł, więc dźwięk opóźniamy o tyle samo
        audio = new AudioContext();
        const cel = audio.createMediaStreamDestination();
        const opozn = audio.createDelay(1);
        opozn.delayTime.value = opoznienie() / 30;
        audio.createMediaStreamSource(new MediaStream([sciezka])).connect(opozn).connect(cel);
        strum.addTrack(cel.stream.getAudioTracks()[0]);
      }
    } catch {
      komunikat('Nagrywam bez dźwięku: brak dostępu do mikrofonu.');
    }
  }
  let rec;
  try {
    rec = new MediaRecorder(strum, { mimeType: typ, videoBitsPerSecond: 16_000_000 });
  } catch (e) {
    if (mikrofon) for (const t of mikrofon.getTracks()) t.stop();
    audio?.close();
    return komunikat('Nie udało się zacząć nagrywania: ' + (e.message || e), true);
  }
  const kawalki = [];
  const start = performance.now();
  const sprzatnij = () => {
    clearInterval(nagr?.zegar);
    if (mikrofon) for (const t of mikrofon.getTracks()) t.stop();
    audio?.close();
    btn.classList.remove('trwa');
    btn.textContent = 'Nagrywaj';
    nagr = null;
  };
  rec.ondataavailable = (e) => e.data.size && kawalki.push(e.data);
  rec.onerror = (e) => {
    sprzatnij();
    komunikat('Nagrywanie przerwane: ' + (e.error?.message || 'błąd kodera'), true);
  };
  rec.onstop = () => {
    const blob = new Blob(kawalki, { type: typ.split(';')[0] });
    const d = new Date();
    const dwa = (n) => String(n).padStart(2, '0');
    const nazwa = `lustro-rentgen-${d.getFullYear()}${dwa(d.getMonth() + 1)}${dwa(d.getDate())}-${dwa(d.getHours())}${dwa(d.getMinutes())}${dwa(d.getSeconds())}.${typ.includes('mp4') ? 'mp4' : 'webm'}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nazwa;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    sprzatnij();
    $('#czasNagrania').textContent = 'zapisano ' + nazwa;
  };
  if (ust.odliczanie) {
    // odliczanie na obrazie: czas, żeby odejść od komputera
    const el = $('#licznik');
    btn.disabled = true;
    el.hidden = false;
    for (const n of [3, 2, 1]) {
      el.textContent = n;
      await czekaj(1000);
    }
    el.hidden = true;
    btn.disabled = false;
  }
  rec.start(1000);
  btn.classList.add('trwa');
  btn.textContent = 'Zatrzymaj';
  nagr = {
    rec,
    zegar: setInterval(() => {
      const s = Math.floor((performance.now() - start) / 1000);
      $('#czasNagrania').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 250),
  };
}

// ---------- geometria kadru ----------
// Zwraca true, gdy zmienił się kadr albo wymiary obrazu (wtedy punkty z poprzednich klatek nie pasują do nowych).
function ustalWymiary() {
  const krotki = ust.rozdzielczosc === '720' ? 720 : 1080;
  const dlugi = (krotki * 16) / 9;
  st.W = ust.kadr === 'pionowy' ? krotki : dlugi;
  st.H = ust.kadr === 'pionowy' ? dlugi : krotki;
  const vw = plotnoKlatki.width > 1 && st.zrodlo ? plotnoKlatki.width : st.W;
  const vh = plotnoKlatki.height > 1 && st.zrodlo ? plotnoKlatki.height : st.H;
  const k = Math.max(st.W / vw, st.H / vh);
  st.kadr = { k, ox: (st.W - vw * k) / 2, oy: (st.H - vh * k) / 2, vw, vh };
  scena.ustawRozmiar(st.W, st.H);
  etykiety.ustawRozmiar(st.W, st.H);
  const klucz = `${st.W}x${st.H}:${vw}x${vh}`;
  const zmiana = klucz !== st.kluczWymiarow;
  st.kluczWymiarow = klucz;
  return zmiana;
}
const doSceny = (p) => {
  const { k, ox, oy, vw, vh } = st.kadr;
  return [p[0] * vw * k + ox, st.H - (p[1] * vh * k + oy), -p[2] * vw * k];
};
// ogniskowa w pikselach sceny: zakładamy ok. 66 stopni wzdłuż dłuższego boku obrazu, resztę kalibruje twarz
const ogniskowaBazowa = () => (Math.max(st.kadr.vw, st.kadr.vh) * st.kadr.k * 0.77) / ust.perspektywa;

// Kopia bieżącej klatki filmu na płótno (najwyżej 1920 pikseli na dłuższym boku).
function zrobKopieKlatki() {
  const vw = wideo.videoWidth, vh = wideo.videoHeight;
  if (!vw || !vh) return false;
  const sk = Math.min(1, 1920 / Math.max(vw, vh));
  const kw = Math.round(vw * sk), kh = Math.round(vh * sk);
  if (plotnoKlatki.width !== kw || plotnoKlatki.height !== kh) {
    plotnoKlatki.width = kw;
    plotnoKlatki.height = kh;
    scena.ustawZrodlo(plotnoKlatki);
  }
  ctxKlatki.drawImage(wideo, 0, 0, kw, kh);
  return true;
}

// ---------- śledzenie ----------
function wykryjKlatke(dt, krokCiagu = 1) {
  const d = sledzenie.wykryj(plotnoKlatki, st.znacznik);
  const rek = { t: st.czasToru, klatka: st.slotWgrany, poza: null, twarz: null, dlonie: [null, null] };
  if (d.poza) rek.poza = { p: d.poza.p.map(doSceny), w: d.poza.w };
  // do testów: ?bezbioder udaje półzbliżenie (biodra i nogi poza kadrem) na nagraniu całej sylwetki
  if (rek.poza && BEZ_BIODER) for (let i = 23; i < 33; i++) rek.poza.w[i] = 0;
  // twarz „widziana” w torsie, kilka razy większa od głowy sylwetki, nie przechodzi dalej
  const pTwarzy = d.twarz ? d.twarz.p.map(doSceny) : null;
  if (straznik.twarzWiarygodna(rek.poza, pTwarzy, krokCiagu)) {
    const p = pTwarzy;
    rig.persp[0] = st.W / 2;
    rig.persp[1] = st.H / 2;
    const dop = rig.dopasujTwarz(p, ogniskowaBazowa(), dt, true, d.twarz.ksztalty.jawOpen ?? 0);
    if (dop) rek.twarz = { ...dop, usta: d.twarz.ksztalty.jawOpen ?? 0, p };
  }
  const dlonie = d.dlonie.map((x) => ({ p: x.p.map(doSceny), strona: x.strona, pewnosc: x.pewnosc }));
  // sylwetka „widziana” w samej dłoni przed kamerą nie przechodzi dalej
  if (!straznik.sprawdz(rek.poza, rek.twarz?.p || null, dlonie, krokCiagu)) rek.poza = null;
  // klatka, w której model zamienił lewą stronę ciała z prawą, wypełni się z sąsiednich
  else if (!straznikStron.sprawdz(rek.poza)) rek.poza = null;
  rek.dlonie = toryDloni.aktualizuj(dlonie, rek.poza, st.nrKlatki++);
  return rek;
}

// Przetwarza bieżącą klatkę filmu. opcje: ciecie (zacznij od zera), powtorz (ile razy podać tę samą klatkę,
// żeby stojący obraz dogonił opóźnienie), dt (odstęp klatek w sekundach), D (opóźnienie), krokZnacznika (ms).
// bezKopii: licz jeszcze raz tę samą klatkę, która już jest na płótnie (stopklatka).
function przetworz(teraz, { ciecie = false, powtorz = 1, dt = null, D = null, krokZnacznika = null, zachowajStraznika = false, bezKopii = false } = {}) {
  const t0 = performance.now();
  if (bezKopii ? plotnoKlatki.width < 2 : !zrobKopieKlatki()) return null;
  if (ustalWymiary()) ciecie = true;
  st.slotWgrany = scena.wgrajKlatke();
  if (dt === null) {
    dt = ogranicz((teraz - st.czasOstatniej) / 1000, 1 / 120, 0.1);
    if (ciecie || !st.czasOstatniej) dt = 1 / 30;
  }
  st.czasOstatniej = teraz;
  if (ciecie) {
    bufor.zeruj();
    toryDloni.zeruj();
    if (!zachowajStraznika) {
      straznik.zeruj();
      straznikStron.zeruj();
    }
    zanikLinii.zeruj();
    st.liniaPoprz = null;
    st.soczewka = null;
    st.ciecieRigu = true;
  }
  let rek = null;
  for (let j = 0; j < powtorz; j++) {
    st.czasToru += dt;
    st.znacznik = krokZnacznika ? st.znacznik + krokZnacznika : Math.max(st.znacznik + 1, Math.round(teraz) + j);
    // przy stojącym obrazie wykrywamy dwa razy (drugi wynik korzysta już ze śledzenia), resztę powtarzamy
    rek = j < 2 || !rek ? wykryjKlatke(dt, powtorz > 1 ? 4 : 1) : { ...rek };
    rek.t = st.czasToru;
    bufor.dodaj(rek);
  }
  const obs = bufor.odczyt(D ?? opoznienie(), { dlugiBok: Math.max(st.W, st.H) });
  pokaz(obs, dt);
  const krokMs = performance.now() - t0;
  st.czasKroku += (krokMs - st.czasKroku) * 0.1;
  // test kamery: zapis surowej klatki i pomiarów
  if (st.poKlatce) st.poKlatce({ krokMs, obs, ciecie, meta: st.meta, teraz });
  return obs;
}

// Ręka, która prowadzi soczewkę. Wybór jest trwały: ta sama dłoń (ten sam tor śledzenia) prowadzi soczewkę,
// dopóki jest w kadrze, więc druga dłoń może być tym, co się ogląda. Dopiero gdy prowadząca zniknie na ponad
// sekundę, soczewkę przejmuje inna widoczna dłoń. Ustawia st.reka = { tor, strona, jest }.
function wybierzRekeSoczewki(obs, dt) {
  if (ust.odslona !== 'soczewka') {
    st.reka = null;
    return;
  }
  const dlonie = (obs?.dlonie || []).filter((d) => d.strona);
  const r = st.reka || (st.reka = { tor: -1, strona: null, jest: false, brak: 99 });
  const moja = dlonie.find((d) => d.tor === r.tor);
  if (moja) {
    r.strona = moja.strona;
    r.jest = true;
    r.brak = 0;
    return;
  }
  r.jest = false;
  r.brak += dt;
  if (!dlonie.length || (r.tor >= 0 && r.brak <= 1)) return;
  // przejęcie: najbliższa dotychczasowemu położeniu soczewki
  const punkt = (d) => (ust.gest ? srodekOpuszkow(d.p) : d.p[8]);
  let naj = dlonie[0];
  if (st.soczewka) {
    const p = st.soczewka.p;
    for (const d of dlonie) if (Math.hypot(punkt(d)[0] - p[0], punkt(d)[1] - p[1]) < Math.hypot(punkt(naj)[0] - p[0], punkt(naj)[1] - p[1])) naj = d;
  }
  r.tor = naj.tor;
  r.strona = naj.strona;
  r.jest = true;
  r.brak = 0;
}

// Ustawia rig według wyniku z bufora i rysuje klatkę.
function pokaz(obs, dt) {
  st.obs = obs;
  st.slotPokazu = obs ? obs.klatka : st.slotWgrany;
  const ciecie = st.ciecieRigu;
  st.ciecieRigu = false;
  if (ciecie) st.reka = null;
  wybierzRekeSoczewki(obs, dt);
  st.info = rig.aktualizuj({
    kadr: [st.W, st.H],
    poza: obs?.poza || null,
    twarz: obs?.twarz || null,
    dlonie: obs?.dlonie || [],
    wid: obs?.wid,
    dt: obs?.dt ?? dt,
    dopasowanie: ust.dop,
    persp: [st.W / 2, st.H / 2, ogniskowaBazowa()],
    ciecie,
  });
  rig.krokWidocznosci(dt);
  st.czasBezOsoby = obs && (obs.poza || obs.twarz || obs.dlonie.length) ? 0 : (st.czasBezOsoby || 0) + dt;
  rysuj(dt, ciecie);
  licznik++;
}

// ---------- odsłona ----------
// w zbliżeniu cięcie i podział podpisów prowadzi głowa, z daleka tułów; przełączenie ma histerezę
function czyZGlowy(info) {
  st.zGlowy = !!info?.maGlowe && (!info.maTulow || info.skalaGlowy > (st.zGlowy ? 1.1 : 1.3));
  return st.zGlowy;
}
function policzOdslone(info, dt, zGlowy) {
  const o = { rodzaj: ust.odslona === 'calosc' ? 'calosc' : ust.odslona === 'soczewka' ? 'soczewka' : 'linia', linia: null, soczewka: null };
  if (o.rodzaj === 'soczewka') {
    const punkt = (d) => (ust.gest ? d.opuszki : d.wskazujacy);
    // soczewkę prowadzi jedna, stale ta sama dłoń (patrz wybierzRekeSoczewki)
    const dl = (st.reka?.jest && (info?.dlonie || []).find((d) => d.strona === st.reka.strona)) || null;
    // gest: palce zebrane razem zamykają soczewkę, otwarta dłoń otwiera ją do rozmiaru z suwaka
    const celU = dl ? ogranicz((dl.rozstaw - ROZSTAW_MIN) / (ROZSTAW_MAKS - ROZSTAW_MIN), 0, 1) : 0.6;
    if (!st.soczewka) {
      const c = dl ? punkt(dl) : info?.srodekGlowy || [st.W / 2, st.H / 2];
      st.soczewka = { p: [c[0], c[1]], u: celU };
    }
    const s = st.soczewka;
    if (dl) {
      const cel = punkt(dl);
      const a = 1 - Math.exp(-dt / 0.045);
      s.p[0] += (cel[0] - s.p[0]) * a;
      s.p[1] += (cel[1] - s.p[1]) * a;
      if (ust.gest) s.u += (celU - s.u) * (1 - Math.exp(-dt / 0.06));
    }
    const rMaks = ust.zasiegSoczewki * st.H;
    let r = rMaks;
    if (ust.gest) {
      // przy zamkniętej dłoni soczewka znika całkiem (razem z miękką krawędzią)
      const pioro = Math.max(1, ust.pioro * (st.H / 1080));
      r = rMaks * s.u - 2 * pioro * (1 - gladki(0, 0.12, s.u));
    }
    o.soczewka = [s.p[0], s.p[1], r];
  } else if (o.rodzaj === 'linia') {
    const c = zGlowy ? info.srodekGlowy : info?.maTulow ? info.srodekTulowia : [st.W / 2, st.H / 2];
    let a = zGlowy ? info.osGlowy : info?.maTulow ? info.osTulowia : [0, 1, 0];
    const zakres = zGlowy ? info.skalaGlowy * 130 : (info?.g || 1) * 420;
    let stan = [c[0], c[1], a[0], a[1], zakres];
    // przejście między prowadzeniem przez głowę i przez tułów: różnica znika płynnie
    if (st.liniaPoprz && st.liniaPoprz.zGlowy !== zGlowy) zanikLinii.przelacz(st.liniaPoprz.stan, stan);
    zanikLinii.krok(dt);
    stan = zanikLinii.zastosuj(stan);
    st.liniaPoprz = { zGlowy, stan };
    const da = Math.hypot(stan[2], stan[3]) || 1;
    a = [stan[2] / da, stan[3] / da];
    let n;
    if (ust.odslona === 'lewa' || ust.odslona === 'prawa') {
      n = [a[1], -a[0]]; // w prawo sceny
      const lewaNaEkranie = ust.odslona === 'lewa';
      // lewa strona gotowego obrazu to prawa strona sceny, gdy lustro jest włączone
      if (lewaNaEkranie !== ust.lustro) n = [-n[0], -n[1]];
    } else {
      n = ust.odslona === 'gora' ? a : [-a[0], -a[1]];
    }
    const pion = ust.odslona === 'gora' || ust.odslona === 'dol';
    // przesunięcie liczone w kierunku ekranu (w prawo albo w górę), niezależnie od wybranej połowy
    const kier = pion ? a : ust.lustro ? [-a[1], a[0]] : [a[1], -a[0]];
    const px = stan[0] + kier[0] * stan[4] * ust.ciecie;
    const py = stan[1] + kier[1] * stan[4] * ust.ciecie;
    o.linia = [n[0], n[1], -(n[0] * px + n[1] * py)];
  }
  return o;
}

// ---------- rysowanie ----------
let licznik = 0, czasLicznika = performance.now();
function rysuj(dt, ciecie = false) {
  const info = st.info;
  // części ciała: zaznaczone pojawiają się, reszta gaśnie (płynnie, a po cięciu od razu)
  const wybrane = ust.czesci ? new Set(ust.czesci) : null;
  const tempo = ciecie ? 1 : 1 - Math.exp(-dt / 0.12);
  for (let i = 0; i < CZESCI.length; i++) {
    const cel = !wybrane || wybrane.has(CZESCI[i].id) ? 1 : 0;
    scena.czesc[i] += (cel - scena.czesc[i]) * tempo;
  }
  // Ręka, która prowadzi soczewkę, jest prześwietlona jak reszta ciała, ale nie dostaje podpisów: służy do pokazywania.
  for (const s of ['L', 'P']) {
    const cel = st.reka?.strona === s ? 1 : 0;
    for (const id of ['przedramie' + s, 'dlon' + s]) {
      const i = NR_CZESCI[id];
      etykiety.bezPodpisow[i] += (cel - etykiety.bezPodpisow[i]) * tempo;
    }
  }
  const zGlowy = czyZGlowy(info);
  const odslona = policzOdslone(info, dt, zGlowy);
  let odslonieta = null;
  if (odslona.rodzaj === 'linia') odslonieta = (x, y) => odslona.linia[0] * x + odslona.linia[1] * y + odslona.linia[2];
  else if (odslona.rodzaj === 'soczewka') odslonieta = (x, y) => odslona.soczewka[2] - Math.hypot(x - odslona.soczewka[0], y - odslona.soczewka[1]);
  // podział podpisów na lewą i prawą kolumnę: w zbliżeniu względem środka głowy, z daleka względem tułowia
  const c = zGlowy ? info.srodekGlowy : info?.maTulow ? info.srodekTulowia : info?.srodekGlowy;
  let punkty = null;
  if (ust.dane && !st.spoczynek && st.obs) {
    punkty = [];
    if (st.obs.poza) punkty.push(...st.obs.poza.p.filter((p, i) => st.obs.poza.w[i] > 0.5));
    if (st.obs.twarz?.p) punkty.push(...st.obs.twarz.p.filter((p, i) => i % 3 === 0));
    for (const d of st.obs.dlonie) punkty.push(...d.p);
  }
  etykiety.rysuj({
    W: st.W,
    H: st.H,
    dt,
    ciecie,
    pokaz: ust.podpisy,
    warstwy: ust.warstwy,
    lustro: ust.lustro,
    tryb: ust.tryb,
    odslonieta,
    soczewka: odslona.soczewka,
    punkty,
    srodekX: c ? (ust.lustro ? st.W - c[0] : c[0]) : null,
    skalaNapisow: ust.wielkoscPodpisow,
    maksNaKolumne: ust.ilePodpisow,
    poleGora: ust.podpisyGora || 0,
    poleDol: ust.podpisyDol || 0,
    poleBok: ust.podpisyBok || 0,
  });
  const { k, ox, oy, vw, vh } = st.kadr;
  scena.rysuj({
    klatka: st.zrodlo ? st.slotPokazu : -1,
    warstwy: ust.warstwy,
    tryb: ust.tryb,
    jasnosc: ust.jasnosc,
    przenikanie: ust.przenikanie,
    pioro: ust.pioro * (st.H / 1080),
    lustro: ust.lustro,
    odslona,
    kadr: [st.W / (vw * k), st.H / (vh * k), -ox / (vw * k), -oy / (vh * k)],
  });
  if (st.zdjecie) {
    st.zdjecie = false;
    plotno.toBlob((b) => {
      if (!b) return;
      const nazwa = nazwaPliku('png');
      pobierz(b, nazwa);
      $('#czasNagrania').textContent = 'zapisano ' + nazwa;
    }, 'image/png');
  }
  if (st.zrzut) {
    const nazwa = st.zrzut;
    st.zrzut = null;
    plotno.toBlob((b) => fetch('/__zrzut?nazwa=' + nazwa, { method: 'POST', body: b }).then(() => (st.zrzutGotowy = nazwa)), 'image/jpeg', 0.9);
  }
}

// ---------- pętla ----------
function naped(teraz) {
  requestAnimationFrame(naped);
  try {
    obrot(teraz);
  } catch (e) {
    zglosBlad(e);
  }
}
function obrot(teraz) {
  if (st.eksport || st.krokowo) return;
  const dtR = ogranicz((teraz - st.czasRysunku) / 1000, 0.001, 0.1);
  if (st.spoczynek) {
    ustalWymiary();
    const kat = Number.isFinite(st.katSpoczynku) ? (st.katSpoczynku * Math.PI) / 180 : teraz / 2400;
    st.info = rig.spoczynek(st.W, st.H, kat, +(adres.get('zoom') || 1), +(adres.get('sy') || 815));
    st.czasRysunku = teraz;
    rysuj(dtR);
    return;
  }
  let zrobione = false;
  if (st.zrodlo && sledzenie.gotowe && wideo.readyState >= 2) {
    const zamrozone = st.zamrozone && st.zrodlo === 'kamera';
    let nowa = st.nowaKlatka || st.ciecie;
    if (!MA_RVFC) nowa = nowa || st.zrodlo === 'kamera' || wideo.currentTime !== st.czasWideo;
    // stopklatka: liczymy tylko po zmianie kadru albo raz, żeby obraz dogonił opóźnienie wygładzania
    if (zamrozone) nowa = st.ciecie || st.dogon;
    if (nowa) {
      st.nowaKlatka = false;
      st.dogon = false;
      let ciecie = st.ciecie;
      st.ciecie = false;
      // film zapętlił się albo został przewinięty wstecz: obraz zaczyna od zera
      if (st.zrodlo === 'plik' && wideo.currentTime + 0.05 < st.czasWideo) ciecie = true;
      st.czasWideo = wideo.currentTime;
      const stoi = (st.zrodlo === 'plik' && wideo.paused) || zamrozone;
      przetworz(teraz, { ciecie, powtorz: stoi ? opoznienie() + 1 : 1, bezKopii: zamrozone });
      st.czasRysunku = teraz;
      zrobione = true;
    }
  }
  if (!zrobione && teraz < st.ozywienieDo) {
    // obraz stoi, ale coś się zmienia (ustawienia, pojawianie się podpisów): przerysowujemy bez nowego śledzenia
    ustalWymiary();
    st.czasRysunku = teraz;
    if (st.przeliczRig && st.obs) pokaz(st.obs, dtR);
    else {
      rig.krokWidocznosci(dtR);
      rysuj(dtR);
    }
  }
  st.przeliczRig = false;
  // licznik klatek i panel danych
  if (teraz - czasLicznika > 500) {
    st.kls = (licznik * 1000) / (teraz - czasLicznika);
    licznik = 0;
    czasLicznika = teraz;
    if (ust.dane) odswiezDane();
    odswiezStan();
    if (st.zrodlo === 'plik' && wideo.duration) $('#suwakCzasu').value = Math.round((wideo.currentTime / wideo.duration) * 1000);
  }
}
function odswiezDane() {
  const info = st.info;
  const o = st.obs;
  const l = [];
  l.push(`twarz      ${o?.twarz ? 'śledzona' : 'brak'}`);
  l.push(`sylwetka   ${o?.poza ? 'śledzona, widocznych punktów ' + o.poza.w.filter((w) => w > 0.5).length + ' z 33' : 'brak'}`);
  l.push(`dłonie     ${o?.dlonie.length ? o.dlonie.map((d) => (d.strona === 'L' ? 'lewa' : 'prawa')).join(', ') : 'brak'}`);
  if (info) {
    l.push(`skala      ciało ${(info.g || 0).toFixed(2)} px/mm${info.skalaGlowy ? ', głowa ' + info.skalaGlowy.toFixed(2) + ' px/mm' : ''}`);
    if (info.ogniskowa && info.skalaGlowy) l.push(`kamera     ogniskowa ${info.ogniskowa.toFixed(0)} px, odległość ok. ${Math.round(info.ogniskowa / info.skalaGlowy / 10)} cm`);
    if (info.zrodloGlowy) l.push(`głowa z    ${info.zrodloGlowy === 'twarz' ? 'siatki twarzy' : 'punktów sylwetki'}`);
    if (info.katZuchwy !== undefined) l.push(`żuchwa     ${((info.katZuchwy * 180) / Math.PI).toFixed(1)}°`);
    for (const d of info.dlonie) l.push(`dłoń ${d.strona === 'L' ? 'lewa ' : 'prawa'} rozstaw palców ${d.rozstaw.toFixed(2)}`);
  }
  const c = sledzenie.czasy;
  l.push(`czas       sylwetka ${c.poza.toFixed(0)} ms, twarz ${c.twarz.toFixed(0)} ms, dłonie ${c.dlonie.toFixed(0)} ms, cała klatka ${st.czasKroku.toFixed(0)} ms`);
  l.push(`tempo      ${st.kls.toFixed(0)} kl./s, obraz ${st.W}×${st.H}, opóźnienie ${opoznienie()} kl.`);
  l.push(`warstwy    ${WARSTWY.filter((w) => ust.warstwy[w]).join(', ')}`);
  $('#daneTekst').textContent = l.join('\n');
}

// ---------- tryb krokowy: eksport i pomiary ----------
// Film jest podawany klatka po klatce (ktoś z zewnątrz przewija go i woła klatka()), wynik wychodzi z opóźnieniem D klatek.
const krokowo = {
  start(D = OPOZNIENIE_EKSPORTU) {
    st.krokowo = { D, zaczete: false, dociagniete: 0, rozbieg: 0 };
    straznik.zeruj();
    straznikStron.zeruj();
    ustalWymiary(); // płótno od razu w wymiarach bieżącego kadru (eksport czyta je przed pierwszą klatką)
  },
  // Klatka „na sucho” przed właściwym początkiem: rozgrzewa śledzenie i strażnika sylwetki, nic nie rysuje.
  rozbieg(kls = 30) {
    if (!zrobKopieKlatki()) return;
    ustalWymiary();
    st.znacznik += 1000 / kls;
    wykryjKlatke(1 / kls);
    st.krokowo.rozbieg++;
  },
  // Przetwarza bieżącą klatkę filmu. Zwraca true, gdy na płótnie jest kolejna gotowa klatka wyniku.
  klatka(kls = 30) {
    const k = st.krokowo;
    przetworz(performance.now(), { ciecie: !k.zaczete, dt: 1 / kls, D: k.D, krokZnacznika: 1000 / kls, zachowajStraznika: k.rozbieg > 0 });
    k.zaczete = true;
    return bufor.licznik > k.D;
  },
  // Po ostatniej klatce filmu: oddaje po jednej klatce z tych, które czekają w buforze. Zwraca false, gdy nic nie zostało.
  dociag(kls = 30) {
    const k = st.krokowo;
    if (k.dociagniete >= Math.min(k.D, bufor.licznik - 1)) return false;
    k.dociagniete++;
    pokaz(bufor.odczytKoncowy(k.D, k.dociagniete, { dlugiBok: Math.max(st.W, st.H) }), 1 / kls);
    return true;
  },
  koniec() {
    st.krokowo = null;
    st.ciecie = true;
    st.nowaKlatka = true;
  },
};
const przewin = (t) =>
  new Promise((ok) => {
    if (Math.abs(wideo.currentTime - t) < 1e-4 && wideo.readyState >= 2) return ok();
    wideo.addEventListener('seeked', ok, { once: true });
    wideo.currentTime = t;
  });

// Do testów bez widocznego okna: przelicza kilka klatek pod rząd na zatrzymanym obrazie.
function kroki(ile = 12) {
  for (let i = 0; i < ile; i++) przetworz(performance.now(), { dt: 1 / 30, krokZnacznika: 33 });
  return st.info;
}
// Do testów: przewija nagranie, przelicza klatkę i zapisuje obraz do surowe/zrzuty.
async function klatkaTestowa(nazwa, czas = null) {
  st.krokowo = { test: true };
  try {
    if (czas !== null && st.zrodlo === 'plik') {
      wideo.pause();
      await przewin(czas);
    }
    st.zrzutGotowy = null;
    st.zrzut = nazwa;
    przetworz(performance.now(), { ciecie: true, powtorz: opoznienie() + 3, dt: 1 / 30, krokZnacznika: 33 });
    for (let i = 0; i < 100 && st.zrzutGotowy !== nazwa; i++) await new Promise((ok) => setTimeout(ok, 50));
  } finally {
    st.krokowo = null;
  }
  return st.zrzutGotowy === nazwa;
}
// Pomiar stabilności: punkty anatomii i surowe punkty śledzenia tej samej klatki (patrz narzedzia/analiza-pomiaru.py).
// Eksport nagrania ze zmianą ustawień w czasie (do filmów pokazowych). scenariusz: lista { t, ust }, gdzie t to
// sekunda filmu, a ust to ustawienia, które od tej chwili obowiązują (warstwy scalają się z bieżącymi). Plik trafia
// do surowe/zrzuty/<nazwa>.mp4 przez serwer deweloperski. Ustawienia nie są zapisywane w pamięci przeglądarki.
async function eksportScenariusza(nazwa, scenariusz, { przeplywnosc = 30_000_000, opoznienie = OPOZNIENIE_EKSPORTU, odKlatki = 0, doKlatki = null } = {}) {
  if (st.zrodlo !== 'plik') throw new Error('najpierw wczytaj nagranie z pliku');
  const kolejka = [...scenariusz].sort((a, b) => a.t - b.t);
  let nr = 0;
  const zastosuj = (t) => {
    while (nr < kolejka.length && kolejka[nr].t <= t) {
      const u = kolejka[nr++].ust;
      for (const [k, v] of Object.entries(u)) {
        if (k === 'warstwy') Object.assign(ust.warstwy, v);
        else ust[k] = v;
      }
    }
  };
  zastosuj(odKlatki / 30);
  st.eksport = { przerwij: false, postep: 0 };
  try {
    return await eksportujNagranie({
      wideo,
      plotno,
      stan: st.eksport,
      zDzwiekiem: false,
      krokowo,
      opoznienie,
      przeplywnosc,
      odKlatki,
      doKlatki,
      przedKlatka: zastosuj,
      postep: (u, info) => {
        if (st.eksport) st.eksport.postep = u;
        st.eksportInfo = `${Math.round(u * 100)}% ${info || ''}`;
      },
      zapisz: async (blob) => {
        await fetch('/__zrzut?nazwa=' + nazwa + '&typ=mp4', { method: 'POST', body: blob });
      },
    });
  } finally {
    st.eksport = null;
  }
}

// Do pomiarów: trójkąty warstwy rozciągnięte na ekranie ponad `prog` razy względem spoczynku i dłuższe niż `minPx`.
// Liczy to samo co shader wierzchołków (dwie kości, rozjazd, perspektywa). Rozciągnięty widoczny trójkąt skóry to
// ciemna smuga w masce sylwetki, a w innych warstwach płetwa między częściami ciała.
function rozciagnieteTrojkaty(warstwa = 'skora', prog = 3, minPx = 90) {
  const g = scena.anat.geometrie[warstwa];
  const pos = g.attributes.position.array, rg = g.attributes.aRig.array, ind = g.index.array, aCz = g.attributes.aCzesc.array;
  const M = rig.macierze, wid = rig.widok, gl = rig.glebia, pr = rig.persp, cz = scena.czesc;
  const nV = pos.length / 3;
  const X = new Float32Array(nV), Y = new Float32Array(nV), V = new Float32Array(nV), S = new Float32Array(nV);
  const tp = (b, x, y, z) => {
    const o = b * 16;
    return [M[o] * x + M[o + 4] * y + M[o + 8] * z + M[o + 12], M[o + 1] * x + M[o + 5] * y + M[o + 9] * z + M[o + 13], M[o + 2] * x + M[o + 6] * y + M[o + 10] * z + M[o + 14]];
  };
  const sk = (b) => Math.hypot(M[b * 16], M[b * 16 + 1], M[b * 16 + 2]);
  const gladko = (a, b, x) => {
    const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };
  for (let v = 0; v < nV; v++) {
    const i0 = rg[v * 4], i1 = rg[v * 4 + 1], w = rg[v * 4 + 2] / 255;
    const p0 = tp(i0, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]), p1 = tp(i1, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    let px = p1[0] + (p0[0] - p1[0]) * w, py = p1[1] + (p0[1] - p1[1]) * w;
    const pz = p1[2] + (p0[2] - p1[2]) * w;
    const s = Math.max(0.5 * (sk(i0) + sk(i1)), 1e-4);
    const spojny = 1 - gladko(60, 120, (Math.min(w, 1 - w) * Math.hypot(p0[0] - p1[0], p0[1] - p1[1])) / s);
    const g0 = gl[i0 * 2] * w + gl[i1 * 2] * (1 - w), g1 = gl[i0 * 2 + 1] * w + gl[i1 * 2 + 1] * (1 - w);
    const wsp = 1 / Math.max(0.4, 1 - (pz - g0) / pr[2]);
    px += (pr[0] + (px - pr[0]) * wsp - px) * g1;
    py += (pr[1] + (py - pr[1]) * wsp - py) * g1;
    X[v] = px;
    Y[v] = py;
    S[v] = s;
    V[v] = (wid[i0] * w + wid[i1] * (1 - w)) * spojny * cz[aCz[v]];
  }
  const naz = rig.nazwy;
  const opisWierzcholka = (v) => naz[rg[v * 4]] + (rg[v * 4 + 1] !== rg[v * 4] ? '/' + naz[rg[v * 4 + 1]] + ':' + rg[v * 4 + 2] : '');
  const wyn = [];
  for (let t = 0; t < ind.length; t += 3) {
    const a = ind[t], b = ind[t + 1], c = ind[t + 2];
    if (a === b || Math.max(V[a], V[b], V[c]) < 0.35) continue;
    let ekran = 0, spoczynek = 0;
    for (const [p, q] of [[a, b], [b, c], [a, c]]) {
      ekran = Math.max(ekran, Math.hypot(X[p] - X[q], Y[p] - Y[q]));
      spoczynek = Math.max(spoczynek, Math.hypot(pos[p * 3] - pos[q * 3], pos[p * 3 + 1] - pos[q * 3 + 1], pos[p * 3 + 2] - pos[q * 3 + 2]));
    }
    const razy = ekran / Math.max(1e-3, (spoczynek * (S[a] + S[b] + S[c])) / 3);
    if (razy > prog && ekran > minPx) wyn.push({ trojkat: t / 3, razy: +razy.toFixed(1), px: Math.round(ekran), wid: [V[a], V[b], V[c]].map((v) => +v.toFixed(2)), kosci: [a, b, c].map(opisWierzcholka), xy: [a, b, c].map((v) => [Math.round(X[v]), Math.round(Y[v])]) });
  }
  return wyn.sort((p, q) => q.px - p.px);
}
function migawka() {
  const s = rig.s, sur = st.obs?.surowe || {}, info = st.info || {};
  const pkt = (kosc, p0) => {
    const b = rig.nr[kosc];
    const m = rig.macierze.subarray(b * 16, b * 16 + 16);
    const x = p0[0], y = p0[1], z = p0[2];
    const q = rig.zPerspektywa([m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]], b, b, 1);
    return [+q[0].toFixed(1), +q[1].toFixed(1), +rig.widok[b].toFixed(2)];
  };
  const r2 = (p) => (p ? [+p[0].toFixed(1), +p[1].toFixed(1)] : null);
  const odn = {};
  odn.nos = [pkt('glowa', rig.twarz0[1]), r2(sur.twarz?.p?.[1])];
  odn.okoL = [pkt('glowa', rig.twarz0[263]), r2(sur.twarz?.p?.[263])];
  odn.okoP = [pkt('glowa', rig.twarz0[33]), r2(sur.twarz?.p?.[33])];
  odn.czolo = [pkt('glowa', rig.twarz0[10]), r2(sur.twarz?.p?.[10])];
  for (const [st2, a] of [['L', { bark: 11, lokiec: 13, nadg: 15, kolano: 25, kostka: 27 }], ['P', { bark: 12, lokiec: 14, nadg: 16, kolano: 26, kostka: 28 }]]) {
    const pz = sur.poza?.p;
    odn['bark' + st2] = [pkt('klatka', s['bark' + st2]), r2(pz?.[a.bark])];
    odn['lokiec' + st2] = [pkt('ramie' + st2, s['lokiec' + st2]), r2(pz?.[a.lokiec])];
    odn['nadg' + st2] = [pkt('przedramie' + st2, s['nadgarstek' + st2]), r2(pz?.[a.nadg])];
    odn['kolano' + st2] = [pkt('udo' + st2, s['kolano' + st2]), r2(pz?.[a.kolano])];
    odn['kostka' + st2] = [pkt('podudzie' + st2, s['kostka' + st2]), r2(pz?.[a.kostka])];
    const naj = (sur.dlonie || []).find((d) => d && d.strona === st2);
    odn['wsk' + st2] = [pkt('dalszy_wskazujacy' + st2, s['dlon' + st2].palce.wskazujacy.czubek), r2(naj?.p[8])];
    odn['maly' + st2] = [pkt('dalszy_maly' + st2, s['dlon' + st2].palce.maly.czubek), r2(naj?.p[20])];
    odn['dlon' + st2] = [pkt('dlon' + st2, s['dlon' + st2].nadgarstek), r2(naj?.p[0])];
  }
  const pk = [];
  for (const e of etykiety.lista) {
    for (const kt of e.kotwice) {
      const k = etykiety._kotwica(kt);
      pk.push(+k.p[0].toFixed(1), +k.p[1].toFixed(1), +k.wid.toFixed(2));
    }
  }
  const pod = etykiety.lista.filter((e) => e.wybrany).map((e) => [e.i, e.kol, Math.round(e.y)]);
  return {
    t: +(st.obs?.surowe?.czasFilmu ?? wideo.currentTime).toFixed(4), zg: info.zrodloGlowy || '', mt: !!info.maTulow, sg: info.skalaGlowy || 0, g: info.g || 0, ogn: info.ogniskowa || 0,
    dl: (info.dlonie || []).map((d) => d.strona).join(''), roz: (info.dlonie || []).map((d) => +d.rozstaw.toFixed(3)), odn, pk, pod,
    cz: [sledzenie.czasy.poza, sledzenie.czasy.twarz, sledzenie.czasy.dlonie].map((x) => +x.toFixed(1)),
  };
}
async function pomiar(od, ile, kls = 30, D = opoznienie()) {
  wideo.pause();
  const wyn = [];
  krokowo.start(D);
  try {
    for (let i = 0; i < ile; i++) {
      await przewin(od + (i + 0.5) / kls);
      const gotowa = krokowo.klatka(kls);
      bufor.kl[bufor.kl.length - 1].czasFilmu = wideo.currentTime;
      if (gotowa) wyn.push(migawka());
    }
    while (krokowo.dociag(kls)) wyn.push(migawka());
  } finally {
    krokowo.koniec();
  }
  return wyn;
}
// Do testów: zapisuje kolejne klatki wyniku (surowe/zrzuty/<nazwa>-NNN.jpg), przetwarzane jak przy eksporcie.
async function sekwencja(nazwa, od, ile, kls = 30, D = opoznienie()) {
  wideo.pause();
  krokowo.start(D);
  let nr = 0;
  const zapisz = async () => {
    const n = nazwa + '-' + String(nr++).padStart(3, '0');
    for (let i = 0; i < 100 && st.zrzutGotowy !== n; i++) await new Promise((ok) => setTimeout(ok, 20));
  };
  try {
    for (let i = 0; i < ile; i++) {
      await przewin(od + (i + 0.5) / kls);
      st.zrzutGotowy = null;
      st.zrzut = bufor.licznik >= D ? nazwa + '-' + String(nr).padStart(3, '0') : null;
      if (krokowo.klatka(kls)) await zapisz();
    }
    for (;;) {
      st.zrzutGotowy = null;
      st.zrzut = nazwa + '-' + String(nr).padStart(3, '0');
      if (!krokowo.dociag(kls)) break;
      await zapisz();
    }
    st.zrzut = null;
  } finally {
    krokowo.koniec();
  }
  return nr;
}
async function pomiarDoPliku(nazwa, od, ile, kls = 30, D = opoznienie()) {
  st.pomiarStan = 'trwa';
  try {
    const wyn = await pomiar(od, ile, kls, D);
    await fetch('/__zrzut?nazwa=' + nazwa + '&typ=json', { method: 'POST', body: JSON.stringify(wyn) });
    st.pomiarStan = 'gotowe ' + nazwa + ' ' + wyn.length;
  } catch (e) {
    st.pomiarStan = 'blad ' + (e.stack || e);
  }
}
// Pomiar tempa na żywo: przez podany czas zapisuje odstępy między przetworzonymi klatkami i czas ich liczenia.
async function tempo(ms = 5000) {
  const odstepy = [];
  let poprz = st.czasOstatniej, ost = st.nrKlatki;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    await new Promise((ok) => requestAnimationFrame(ok));
    if (st.nrKlatki !== ost) {
      odstepy.push(st.czasOstatniej - poprz);
      poprz = st.czasOstatniej;
      ost = st.nrKlatki;
    }
  }
  odstepy.sort((a, b) => a - b);
  const p = (q) => +(odstepy[Math.min(odstepy.length - 1, Math.floor(q * odstepy.length))] || 0).toFixed(1);
  return { klatek: odstepy.length, kls: +((odstepy.length * 1000) / ms).toFixed(1), odstepMediana: p(0.5), odstepP95: p(0.95), odstepMaks: p(1), czasKroku: +st.czasKroku.toFixed(1), czasy: { ...sledzenie.czasy } };
}

// ---------- test z prawdziwą kamerą ----------
let test = null;
async function uruchomTest({ zPliku = null, szybko = false } = {}) {
  if (test) return;
  if (nagr || st.eksport) return komunikat('Najpierw zakończ nagrywanie albo eksport.');
  try {
    if (zPliku) await kameraZPliku(zPliku);
    else if (st.zrodlo !== 'kamera') await wlaczKamere();
    if (st.zrodlo !== 'kamera') return;
    test = new TestKamery(
      {
        plotnoKlatki,
        ust,
        st,
        sledzenie,
        odswiezPanel,
        kamera: () => {
          const sc = st.strumien?.getVideoTracks()[0];
          return sc ? { nazwa: sc.label, ...sc.getSettings(), deviceId: undefined, groupId: undefined } : null;
        },
      },
      { szybko },
    );
    st.wynikTestu = await test.uruchom();
  } catch (e) {
    komunikat('Test nieudany: ' + (e.message || e), true);
    st.wynikTestu = { ok: false, blad: String(e.message || e) };
  } finally {
    test = null;
  }
}

// ---------- start ----------
async function start() {
  podlaczPanel();
  stanEl.textContent = 'Wczytuję anatomię.';
  anat = await wczytajAnatomie((u) => (stanEl.textContent = `Wczytuję anatomię: ${Math.round(u * 100)}%`));
  rig = new Rig(anat.opis);
  scena = new Scena(plotno, anat, rig);
  etykiety = new Etykiety(anat.opis, rig);
  scena.ustawNapisy(etykiety.canvas);
  etykiety.czesc = scena.czesc;
  ustalWymiary();
  ozyw(1500);
  requestAnimationFrame(naped);
  window.__lr = { eksportScenariusza, rozciagnieteTrojkaty, straznik, straznikStron, ust, st, rig, scena, etykiety, sledzenie, bufor, wideo, odswiezPanel, kroki, klatkaTestowa, pomiar, pomiarDoPliku, sekwencja, migawka, tempo, kameraZPliku, krokowo, uruchomTest, plotnoKlatki, doSceny, przewin };

  plotno.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    komunikat('Karta graficzna przerwała rysowanie. Odśwież stronę.', true);
  });
  window.addEventListener('resize', () => ozyw());
  document.addEventListener('visibilitychange', () => {
    // po powrocie do karty zaczynamy od zera: w tle przeglądarka wstrzymuje rysowanie
    if (!document.hidden && st.zrodlo) {
      st.ciecie = true;
      st.nowaKlatka = true;
      ozyw();
    }
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', odswiezListeKamer);

  for (const id of ['#startTest', '#btnTest']) $(id).addEventListener('click', () => uruchomTest());
  $('#startKamera').addEventListener('click', () => wlaczKamere());
  $('#btnKamera').addEventListener('click', () => wlaczKamere());
  $('#wyborKamery').addEventListener('change', (e) => wlaczKamere(e.target.value));
  const wybierzPlik = () => $('#plik').click();
  $('#startPlik').addEventListener('click', wybierzPlik);
  $('#btnPlik').addEventListener('click', wybierzPlik);
  $('#plik').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      await wczytajPlik(f);
      stanEl.textContent = '';
    } catch (bl) {
      zatrzymajZrodlo();
      $('#start').hidden = false;
      $('#start').style.display = '';
      stanEl.textContent = 'Nie udało się wczytać nagrania: ' + bl.message;
      komunikat(stanEl.textContent, true);
    }
  });
  $('#btnGraj').addEventListener('click', () => {
    if (wideo.paused) wideo.play().catch(() => {});
    else wideo.pause();
  });
  for (const zd of ['play', 'pause']) {
    wideo.addEventListener(zd, () => {
      $('#btnGraj').textContent = wideo.paused ? 'Odtwórz' : 'Pauza';
      // po zatrzymaniu obraz ma dogonić klatkę, na której film stanął
      if (!st.eksport && !st.krokowo) st.nowaKlatka = true;
    });
  }
  $('#suwakCzasu').addEventListener('input', (e) => {
    if (wideo.duration) wideo.currentTime = (e.target.value / 1000) * wideo.duration;
  });
  wideo.addEventListener('seeked', () => {
    if (st.eksport || st.krokowo) return;
    st.ciecie = true;
    st.nowaKlatka = true;
  });
  $('#btnNagraj').addEventListener('click', () => przelaczNagrywanie().catch(zglosBlad));
  $('#btnZdjecie').addEventListener('click', zrobZdjecie);
  $('#btnStop').addEventListener('click', stopklatka);
  $('#btnPelny').addEventListener('click', pelnyEkran);
  // skróty klawiszowe (nie działają, gdy kursor jest w polu wyboru albo na przycisku)
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.tagName === 'SELECT' || t.tagName === 'BUTTON' || (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'range'))) return;
    const k = e.key.toLowerCase();
    if (k === ' ') {
      e.preventDefault();
      stopklatka();
    } else if (k === 's') zrobZdjecie();
    else if (k === 'r') $('#btnNagraj').click();
    else if (k === 'f') pelnyEkran();
    else if (k === 'h') $('#btnPanel').click();
    else if (k === 'p') {
      ust.podpisy = !ust.podpisy;
      zmiana();
    } else if (k >= '1' && k <= '7') przelaczWarstwe(WARSTWY[+k - 1]);
  });
  $('#btnEksport').addEventListener('click', async () => {
    const btn = $('#btnEksport');
    if (st.eksport) {
      st.eksport.przerwij = true;
      return;
    }
    if (st.zrodlo !== 'plik') return;
    if (nagr) return komunikat('Najpierw zatrzymaj nagrywanie.');
    st.eksport = { przerwij: false };
    btn.textContent = 'Przerwij eksport';
    $('#btnNagraj').disabled = true;
    const napis = $('#czasNagrania');
    try {
      // eksport nie musi nadążać za obrazem, więc w trybie automatycznym zawsze liczy dokładnym modelem
      await wymienModelSylwetki(true);
      const wynik = await eksportujNagranie({
        wideo,
        plotno,
        stan: st.eksport,
        zDzwiekiem: ust.dzwiek,
        krokowo,
        opoznienie: Math.max(opoznienie(), OPOZNIENIE_EKSPORTU),
        postep: (u, info) => (napis.textContent = `eksport ${Math.round(u * 100)}%${info ? ', ' + info : ''}`),
      });
      napis.textContent = wynik ? 'zapisano ' + wynik : 'eksport przerwany';
    } catch (e) {
      napis.textContent = 'eksport nieudany: ' + (e.message || e);
      komunikat('Eksport nieudany: ' + (e.message || e), true);
    }
    st.eksport = null;
    wymienModelSylwetki(true);
    btn.textContent = 'Eksportuj całe nagranie';
    $('#btnNagraj').disabled = false;
  });

  if (st.spoczynek) {
    $('#start').style.display = 'none';
    return;
  }
  stanEl.textContent = 'Wczytuję modele śledzenia.';
  try {
    await sledzenie.start({ ciezkiModel: chcianyDokladnyModel() });
    stanEl.textContent = '';
  } catch (e) {
    stanEl.textContent = 'Nie udało się uruchomić śledzenia: ' + (e.message || e) + '. Sprawdź, czy przeglądarka ma włączoną akcelerację grafiki.';
    return;
  }
  try {
    if (adres.get('wideo')) await wczytajPlik(adres.get('wideo'));
    else if (adres.get('kamera')) await kameraZPliku(adres.get('kamera'));
    // sprawdzenie samego testu bez kamery: ?test=/test/plik.mp4 (strumień z pliku, skrócone kroki, bez głosu)
    else if (adres.get('test')) uruchomTest({ zPliku: adres.get('test'), szybko: true });
  } catch (e) {
    stanEl.textContent = 'Nie udało się wczytać nagrania: ' + e.message;
  }
}
start().catch(zglosBlad);
