// Części ciała do zaznaczania: każdy wierzchołek anatomii i każda kotwica podpisu należy do jednej z 17 części.
// O przynależności decyduje najpierw nazwa struktury (np. żebro to klatka piersiowa, wątroba to brzuch, mięsień
// naramienny to ramię), a dla reszty kość rigu, do której wierzchołek jest przypięty, i jego wysokość w spoczynku.
export const CZESCI = [
  { id: 'glowa', pl: 'Głowa' },
  { id: 'szyja', pl: 'Szyja' },
  { id: 'klatka', pl: 'Klatka piersiowa' },
  { id: 'brzuch', pl: 'Brzuch' },
  { id: 'miednica', pl: 'Miednica' },
  { id: 'ramieL', pl: 'Lewe ramię' },
  { id: 'przedramieL', pl: 'Lewe przedramię' },
  { id: 'dlonL', pl: 'Lewa dłoń' },
  { id: 'ramieP', pl: 'Prawe ramię' },
  { id: 'przedramieP', pl: 'Prawe przedramię' },
  { id: 'dlonP', pl: 'Prawa dłoń' },
  { id: 'udoL', pl: 'Lewe udo' },
  { id: 'golenL', pl: 'Lewa goleń' },
  { id: 'stopaL', pl: 'Lewa stopa' },
  { id: 'udoP', pl: 'Prawe udo' },
  { id: 'golenP', pl: 'Prawa goleń' },
  { id: 'stopaP', pl: 'Prawa stopa' },
];
export const NR_CZESCI = Object.fromEntries(CZESCI.map((c, i) => [c.id, i]));
// zestawy do szybkiego zaznaczania całej kończyny
export const GRUPY = {
  rekaL: ['ramieL', 'przedramieL', 'dlonL'],
  rekaP: ['ramieP', 'przedramieP', 'dlonP'],
  nogaL: ['udoL', 'golenL', 'stopaL'],
  nogaP: ['udoP', 'golenP', 'stopaP'],
  tulow: ['klatka', 'brzuch', 'miednica'],
};

const N = NR_CZESCI;
// struktury, których część wynika z nazwy (angielskie nazwy z BodyParts3D)
const WG_NAZWY = [
  [/deltoid|biceps brachii|triceps brachii|brachialis|coracobrachialis|anconeus/, 'ramie'],
  [/femoris|vastus|sartorius|gracilis|adductor (longus|brevis|magnus)|semitendinosus|semimembranosus|pectineus|tensor fasciae/, 'udo'],
  [/gastrocnemius|soleus|tibialis|fibularis|peroneus|popliteus|plantaris|(extensor|flexor) (digitorum|hallucis) longus/, 'golen'],
  [/pectoralis|serratus anterior|subclavius|intercostal|rhomboid|\bteres\b|infraspinatus|supraspinatus|subscapularis|\brib$|costal cartilage|sternum|manubrium|xiphoid|thoracic vertebra|clavicle|scapula|\blung$|heart|bronch|diaphragm|pulmonary|thymus/, N.klatka],
  [/liver|stomach|spleen|pancreas|kidney|intestine|colon|duodenum|jejunum|ileum|gallbladder|adrenal|suprarenal|lumbar vertebra|rectus abdominis|(external|internal) oblique|transversus abdominis|quadratus lumborum|ureter|appendix|c(a)?ecum/, N.brzuch],
  [/hip bone|sacrum|coccyx|urinary bladder|rectum|penis|testis|epididymis|seminal vesicle|deferent duct|prostate|urethra|glute|piriformis|obturator|gemellus|levator ani/, N.miednica],
  [/cervical vertebra|^atlas$|^axis$|hyoid|thyroid|larynx|cricoid|sternocleidomastoid|scalen|platysma|longus (colli|capitis)|sternothyroid|digastric|pharynx|epiglott/, N.szyja],
];

// przygotowanie: numery kości rigu i poziomy graniczne tułowia z opisu anatomii
export function przygotujCzesci(opis) {
  const nr = Object.fromEntries(opis.kosciRigu.map((n, i) => [n, i]));
  const s = opis.stawy;
  const koscNaCzesc = new Int8Array(opis.kosciRigu.length).fill(-1);
  opis.kosciRigu.forEach((n, i) => {
    const st = n.endsWith('L') ? 'L' : n.endsWith('P') ? 'P' : '';
    if (/^ramie/.test(n)) koscNaCzesc[i] = N['ramie' + st];
    else if (/^(przedramie|promien)/.test(n)) koscNaCzesc[i] = N['przedramie' + st];
    else if (/^(dlon|srodrecze|blizszy|srodkowyp|dalszy)/.test(n)) koscNaCzesc[i] = N['dlon' + st];
    else if (/^udo/.test(n)) koscNaCzesc[i] = N['udo' + st];
    else if (/^podudzie/.test(n)) koscNaCzesc[i] = N['golen' + st];
    else if (/^stopa/.test(n)) koscNaCzesc[i] = N['stopa' + st];
  });
  return {
    koscNaCzesc,
    glowa: nr.glowa,
    zuchwa: nr.zuchwa,
    klatka: nr.klatka,
    miednica: nr.miednica,
    ySzyi: s.yC7, // powyżej: szyja
    yPrzepony: s.yT10 - 45, // powyżej: klatka piersiowa
    yPasa: s.yS1 + 70, // powyżej: brzuch, poniżej: miednica
  };
}

// część wynikająca z nazwy struktury albo -1
export function czescZNazwy(en) {
  const strona = /\bleft\b/.test(en) ? 'L' : /\bright\b/.test(en) ? 'P' : '';
  for (const [wzor, cel] of WG_NAZWY) {
    if (!wzor.test(en)) continue;
    if (typeof cel === 'number') return cel;
    if (strona) return N[cel + strona];
  }
  return -1;
}

// część z kości rigu (b0, b1, waga pierwszej 0..255) i wysokości w spoczynku
export function czescZKosci(k, b0, b1, w, y) {
  const b = w >= 128 ? b0 : b1;
  const zKosci = k.koscNaCzesc[b];
  if (zKosci >= 0) return zKosci;
  const glowa0 = b0 === k.glowa || b0 === k.zuchwa;
  const glowa1 = b1 === k.glowa || b1 === k.zuchwa;
  // wierzchołek rozpięty między głową a klatką to szyja
  if (glowa0 !== glowa1 && Math.min(w, 255 - w) > 15) return N.szyja;
  if (b === k.glowa || b === k.zuchwa) return N.glowa;
  if (y > k.ySzyi) return N.szyja;
  if (y > k.yPrzepony) return N.klatka;
  if (y > k.yPasa) return N.brzuch;
  return N.miednica;
}

// Atrybut „część ciała” dla każdego wierzchołka każdej warstwy. bin: cały plik cialo.bin jako Uint8Array.
export function policzCzesciWierzcholkow(opis, bin) {
  const k = przygotujCzesci(opis);
  const wyn = {};
  for (const [w, W] of Object.entries(opis.warstwy)) {
    wyn[w] = new Uint8Array(W.wierzcholki);
  }
  for (const c of opis.czesci) {
    const W = opis.warstwy[c.w];
    const poz = new Float32Array(bin.buffer, W.poz, W.wierzcholki * 3);
    const rig = new Uint8Array(bin.buffer, W.rig, W.wierzcholki * 4);
    const cel = wyn[c.w];
    const zNazwy = czescZNazwy(c.en);
    for (let v = c.wOd; v < c.wOd + c.wIle; v++) {
      cel[v] = zNazwy >= 0 ? zNazwy : czescZKosci(k, rig[v * 4], rig[v * 4 + 1], rig[v * 4 + 2], poz[v * 3 + 1]);
    }
  }
  return wyn;
}

// Część ciała dla kotwic podpisów: taka sama jak najbliższego wierzchołka tej samej warstwy.
export function przypiszCzesciKotwicom(opis, bin, czesciWierzcholkow) {
  for (const e of opis.etykiety) {
    const W = opis.warstwy[e.w];
    if (!W) continue;
    const poz = new Float32Array(bin.buffer, W.poz, W.wierzcholki * 3);
    const cz = czesciWierzcholkow[e.w];
    for (const kt of e.kotwice) {
      let naj = 0, najD = Infinity;
      const [x, y, z] = kt.p;
      for (let v = 0, o = 0; v < W.wierzcholki; v++, o += 3) {
        const dx = poz[o] - x, dy = poz[o + 1] - y, dz = poz[o + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < najD) {
          najD = d;
          naj = v;
        }
      }
      kt.czesc = cz[naj];
    }
  }
}

// Skóra biodra, uda i boku tułowia przypięta do kości ręki. W pozycji spoczynkowej ręka wisi przy ciele, więc dla
// części skóry biodra najbliższą kością jest kość przedramienia albo palca i tam trafiła jej waga. Taki płat jedzie
// potem za ręką: przy uniesionej dłoni widać go jako ciemny pas obok przedramienia (maska sylwetki), długi jak
// odcinek od nadgarstka do połowy małego palca.
// Jak go poznać: skóra ręki to rura wokół kości, która sięga na zewnętrzną (boczną) stronę kości. Obcy płat
// leży cały po stronie ciała i nie należy do tej rury: albo nie ma z nią wspólnych krawędzi, albo styka się z nią
// zrostem po upraszczaniu siatki, na którym normalne sąsiednich wierzchołków są przeciwne. Po odcięciu takich
// krawędzi zostaje osobnym kawałkiem. Jego wierzchołki dostają kości sąsiedniej skóry tułowia i nogi.
// Zwraca liczbę przepiętych wierzchołków.
function oddajSkoreTulowiowi(opis, bin) {
  const S = opis.warstwy.skora, K = opis.warstwy.kosci;
  if (!S || !K) return 0;
  const nazwy = opis.kosciRigu;
  const grupaKosci = new Uint8Array(nazwy.length); // 1: ręka lewa, 2: ręka prawa, 0: reszta
  nazwy.forEach((x, i) => {
    if (/^(ramie|przedramie|promien|dlon|srodrecze|blizszy|srodkowyp|dalszy)/.test(x)) grupaKosci[i] = x.endsWith('L') ? 1 : 2;
  });
  const glowna = (rig, v) => (rig[v * 4 + 2] >= 128 ? rig[v * 4] : rig[v * 4 + 1]);
  // środek kości ręki w osi X na każdej wysokości (przedziały co 10 mm)
  const kPoz = new Float32Array(bin.buffer, K.poz, K.wierzcholki * 3);
  const kRig = new Uint8Array(bin.buffer, K.rig, K.wierzcholki * 4);
  const BIN = 10, Y0 = -100, ILE = 220;
  const sumaX = [null, new Float64Array(ILE), new Float64Array(ILE)];
  const ileX = [null, new Uint32Array(ILE), new Uint32Array(ILE)];
  for (let v = 0; v < K.wierzcholki; v++) {
    const g = grupaKosci[glowna(kRig, v)];
    if (!g) continue;
    const b = Math.floor((kPoz[v * 3 + 1] - Y0) / BIN);
    if (b < 0 || b >= ILE) continue;
    sumaX[g][b] += kPoz[v * 3];
    ileX[g][b]++;
  }
  const srodekX = (g, y) => {
    const b = Math.floor((y - Y0) / BIN);
    for (let o = 0; o <= 3; o++) {
      for (const k of [b - o, b + o]) if (k >= 0 && k < ILE && ileX[g][k]) return sumaX[g][k] / ileX[g][k];
    }
    return null;
  };
  const poz = new Float32Array(bin.buffer, S.poz, S.wierzcholki * 3);
  const nor = new Int8Array(bin.buffer, S.nor, S.wierzcholki * 4);
  const rig = new Uint8Array(bin.buffer, S.rig, S.wierzcholki * 4);
  const ind = new Uint32Array(bin.buffer, S.ind, S.trojkaty * 3);
  const n = S.wierzcholki;
  const grupa = new Uint8Array(n);
  for (let v = 0; v < n; v++) grupa[v] = grupaKosci[glowna(rig, v)];
  // spójne kawałki skóry ręki po odcięciu zrostów (krawędzi o przeciwnych normalnych)
  const ojciec = new Int32Array(n);
  for (let v = 0; v < n; v++) ojciec[v] = v;
  const korzen = (a) => {
    while (ojciec[a] !== a) {
      ojciec[a] = ojciec[ojciec[a]];
      a = ojciec[a];
    }
    return a;
  };
  const zgodne = (a, b) => nor[a * 4] * nor[b * 4] + nor[a * 4 + 1] * nor[b * 4 + 1] + nor[a * 4 + 2] * nor[b * 4 + 2] > 0;
  for (let t = 0; t < ind.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = ind[t + k], b = ind[t + ((k + 1) % 3)];
      if (a === b || !grupa[a] || grupa[a] !== grupa[b] || !zgodne(a, b)) continue;
      ojciec[korzen(a)] = korzen(b);
    }
  }
  // kawałek jest skórą ręki, gdy choć jeden jego wierzchołek leży po zewnętrznej stronie kości
  const maBok = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    const g = grupa[v];
    if (!g) continue;
    const sx = srodekX(g, poz[v * 3 + 1]);
    if (sx === null) continue;
    if (g === 1 ? poz[v * 3] > sx : poz[v * 3] < sx) maBok[korzen(v)] = 1;
  }
  const obcy = new Uint8Array(n);
  let ileObcych = 0;
  for (let v = 0; v < n; v++) {
    if (grupa[v] && !maBok[korzen(v)]) {
      obcy[v] = 1;
      ileObcych++;
    }
  }
  if (!ileObcych) return 0;
  // obce wierzchołki przejmują kości od sąsiedniej skóry tułowia i nogi, warstwa po warstwie od brzegu płata
  let przepiete = 0;
  for (let runda = 0; runda < 40; runda++) {
    const zmiany = [];
    for (let t = 0; t < ind.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = ind[t + k], b = ind[t + ((k + 1) % 3)];
        if (a === b) continue;
        if (obcy[a] && !obcy[b] && !grupa[b]) zmiany.push(a, b);
        else if (obcy[b] && !obcy[a] && !grupa[a]) zmiany.push(b, a);
      }
    }
    if (!zmiany.length) break;
    for (let i = 0; i < zmiany.length; i += 2) {
      const v = zmiany[i], wzor = zmiany[i + 1];
      if (!obcy[v]) continue;
      rig[v * 4] = rig[wzor * 4];
      rig[v * 4 + 1] = rig[wzor * 4 + 1];
      rig[v * 4 + 2] = rig[wzor * 4 + 2];
      obcy[v] = 0;
      grupa[v] = 0;
      przepiete++;
    }
  }
  return przepiete;
}

// Naprawa przypięć tkanek miękkich. Wagi skóry, mięśni i naczyń powstały z odległości do najbliższych kości
// w pozycji spoczynkowej, a w niej dłonie wiszą przy udach i uda leżą obok siebie. Część wierzchołków dostała
// więc drugą kość z innej kończyny (dłoń i udo, lewe i prawe udo, przedramię i miednica). Przy uniesionej ręce
// taka skóra rozciągała się w ciemny klin od dłoni do biodra. Wierzchołek może być rozpięty tylko między kośćmi,
// które sąsiadują w szkielecie; w innym razie zostaje przy kości o większej wadze.
export function naprawPrzypiecia(opis, bin) {
  const nazwy = opis.kosciRigu;
  const n = nazwy.length;
  const nr = Object.fromEntries(nazwy.map((x, i) => [x, i]));
  const sasiad = new Uint8Array(n * n);
  const lacz = (a, b) => {
    if (nr[a] === undefined || nr[b] === undefined) return;
    sasiad[nr[a] * n + nr[b]] = 1;
    sasiad[nr[b] * n + nr[a]] = 1;
  };
  lacz('glowa', 'zuchwa');
  lacz('glowa', 'klatka');
  lacz('zuchwa', 'klatka');
  lacz('klatka', 'miednica');
  for (const st of ['L', 'P']) {
    lacz('klatka', 'ramie' + st);
    lacz('ramie' + st, 'przedramie' + st);
    lacz('ramie' + st, 'promien' + st);
    lacz('przedramie' + st, 'promien' + st);
    // wszystkie kości jednej dłoni sąsiadują ze sobą i z kośćmi przedramienia
    const dlon = nazwy.filter((x) => x.endsWith(st) && /^(dlon|srodrecze|blizszy|srodkowyp|dalszy)/.test(x));
    for (const a of dlon) {
      lacz(a, 'przedramie' + st);
      lacz(a, 'promien' + st);
      for (const b of dlon) if (a !== b) lacz(a, b);
    }
    lacz('miednica', 'udo' + st);
    lacz('udo' + st, 'podudzie' + st);
    lacz('podudzie' + st, 'stopa' + st);
  }
  let poprawione = 0;
  for (const W of Object.values(opis.warstwy)) {
    const rig = new Uint8Array(bin.buffer, W.rig, W.wierzcholki * 4);
    for (let v = 0; v < W.wierzcholki; v++) {
      const b0 = rig[v * 4], b1 = rig[v * 4 + 1], w = rig[v * 4 + 2];
      if (b0 === b1 || sasiad[b0 * n + b1]) continue;
      const glowna = w >= 128 ? b0 : b1;
      rig[v * 4] = glowna;
      rig[v * 4 + 1] = glowna;
      rig[v * 4 + 2] = 255;
      poprawione++;
    }
  }
  // skóra biodra i uda przypięta do kości ręki wraca do tułowia i nogi (przed zwijaniem zrośniętych trójkątów)
  opis.skoraPrzepieta = oddajSkoreTulowiowi(opis, bin);
  // Trójkąty zrośnięte między kończynami. W spoczynku dłoń dotyka uda, a uda siebie nawzajem, więc po uproszczeniu
  // siatki skóry część trójkątów ma wierzchołki na dwóch różnych kończynach. Przy uniesionej ręce taki trójkąt
  // rozciąga się w płetwę od dłoni do biodra. Zwijamy go do punktu (zerowa powierzchnia, nie rysuje się).
  const TULOW = 0;
  const grupa = new Uint8Array(n);
  const blizsza = new Uint8Array(n); // kość kończyny przyrośnięta do tułowia (ramię, udo)
  nazwy.forEach((x, i) => {
    const st = x.endsWith('L') ? 1 : x.endsWith('P') ? 2 : 0;
    if (/^(ramie|przedramie|promien|dlon|srodrecze|blizszy|srodkowyp|dalszy)/.test(x)) grupa[i] = st;
    else if (/^(udo|podudzie|stopa)/.test(x)) grupa[i] = 2 + st;
    if (/^(ramie|udo)/.test(x)) blizsza[i] = 1;
  });
  const razem = (a, b) => {
    if (grupa[a] === grupa[b]) return true;
    if (grupa[a] !== TULOW && grupa[b] !== TULOW) return false; // dwie różne kończyny
    const konczyna = grupa[a] === TULOW ? b : a;
    const tulow = grupa[a] === TULOW ? a : b;
    if (!blizsza[konczyna]) return false; // przedramię, dłoń, goleń albo stopa zrośnięte z tułowiem
    // ramię łączy się z klatką, udo z miednicą albo klatką (pachwina), nic z głową
    return /^ramie/.test(nazwy[konczyna]) ? tulow === nr.klatka : tulow === nr.miednica || tulow === nr.klatka;
  };
  let zwiniete = 0;
  for (const W of Object.values(opis.warstwy)) {
    const rig = new Uint8Array(bin.buffer, W.rig, W.wierzcholki * 4);
    const ind = new Uint32Array(bin.buffer, W.ind, W.trojkaty * 3);
    const kosc = (v) => (rig[v * 4 + 2] >= 128 ? rig[v * 4] : rig[v * 4 + 1]);
    for (let t = 0; t < ind.length; t += 3) {
      const a = kosc(ind[t]), b = kosc(ind[t + 1]), c = kosc(ind[t + 2]);
      if (a === b && b === c) continue;
      if (razem(a, b) && razem(b, c) && razem(a, c)) continue;
      ind[t + 1] = ind[t];
      ind[t + 2] = ind[t];
      zwiniete++;
    }
  }
  opis.zwinieteTrojkaty = zwiniete;
  // to samo dla kotwic podpisów (waga zapisana jako 0..1)
  for (const e of opis.etykiety) {
    for (const kt of e.kotwice) {
      const [b0, b1, w] = kt.rig;
      if (b0 === b1 || sasiad[b0 * n + b1]) continue;
      const glowna = w >= 0.5 ? b0 : b1;
      kt.rig = [glowna, glowna, 1];
    }
  }
  return poprawione;
}
