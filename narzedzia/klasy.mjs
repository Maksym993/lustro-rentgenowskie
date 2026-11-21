// Podział części BodyParts3D na warstwy oraz przypisanie kości do rigu.
// Rig: lista "kości" (odcinków), których macierze aplikacja liczy co klatkę ze śledzenia.

export const KOSCI_RIGU = [
  'glowa', 'zuchwa', 'klatka', 'miednica',
  'ramieL', 'przedramieL', 'promienL', 'dlonL',
  'ramieP', 'przedramieP', 'promienP', 'dlonP',
  'udoL', 'podudzieL', 'stopaL', 'udoP', 'podudzieP', 'stopaP',
];
const PALCE = ['kciuk', 'wskazujacy', 'srodkowy', 'serdeczny', 'maly'];
for (const s of ['L', 'P']) {
  for (const p of PALCE) KOSCI_RIGU.push(`srodrecze_${p}${s}`);
  for (const p of PALCE) {
    KOSCI_RIGU.push(`blizszy_${p}${s}`);
    if (p !== 'kciuk') KOSCI_RIGU.push(`srodkowyp_${p}${s}`);
    KOSCI_RIGU.push(`dalszy_${p}${s}`);
  }
}
export const NR = Object.fromEntries(KOSCI_RIGU.map((n, i) => [n, i]));

const POMIN = /hair|eyebrow|gingiva|labial part of mouth|papillary muscle|valve|anal sphincter|puborectalis|pubococcygeus|iliococcygeus|coccygeus|levator ani|innermost intercostal|internal intercostal|taenia|pancreatic duct|appendix|white matter|internal capsule|interventricular foramen|central canal|interpeduncular|lamina terminalis|tuber cinereum|stria |habenula|commissure|brachium of|geniculate|choroid plexus|septum pellucidum/;
const NACZYNIA = /artery|\bveins?\b|aorta|vena cava|coronary|sinus/;
const NARZADY = /heart|lung|^liver$|stomach|spleen|kidney|adrenal|pancreas|gallbladder|duodenum|jejunum|ileum|colon|rectum|bladder|ureter|esophagus|trachea|bronchus|thymus|penis|testis|epididymis|seminal vesicle|deferent duct|prostate|urethra/;
const MOZG = /gyr|occipital lobe|cerebell|^pons$|medulla|midbrain|thalamus|caudate|putamen|pallidus|amygdala|hippocampus|fornix|corpus callosum|insula|ventricle|colliculus|optic|pineal|pituitary|mammillary|aqueduct|peduncle|precuneus/;
const KOSC = /(\bbone\b|vertebra$|\brib$|sternum$|^manubrium$|xiphoid process$|clavicle$|scapula$|humerus$|radius$|ulna$|femur$|tibia$|fibula$|patella$|^sacrum$|^mandible$|maxilla$|^ethmoid$|^vomer$|tooth$|scaphoid$|lunate$|triquetral$|pisiform$|trapezium$|trapezoid$|capitate$|hamate$|calcaneus$|talus$|^atlas$|^axis$|phalanx of|nasal concha$)/;
const SCIEGNO = /tendon|aponeurosis|ligament|membrane|retinaculum|tract$|linea alba|raphe/;

// kolory bazowe (0..255)
const K = {
  kosc: [236, 228, 208],
  zab: [250, 248, 240],
  chrzastka: [176, 208, 222],
  krazek: [150, 190, 214],
  miesien: [196, 64, 58],
  sciegno: [226, 210, 190],
  skora: [90, 150, 255],
  oko: [240, 240, 235],
  mozg: [232, 150, 170],
  mozdzek: [214, 128, 150],
  pien: [236, 190, 170],
  tetnica: [226, 52, 48],
  zyla: [70, 110, 220],
  serce: [200, 44, 52],
  pluco: [236, 150, 160],
  watroba: [150, 70, 50],
  zoladek: [226, 150, 120],
  sledziona: [130, 60, 90],
  nerka: [170, 80, 60],
  jelito: [228, 170, 140],
  jelitoGrube: [206, 140, 120],
  pecherz: [236, 206, 120],
  tchawica: [190, 214, 226],
  przelyk: [214, 140, 120],
  inne: [220, 170, 150],
};

function kolorNarzadu(en) {
  if (/heart/.test(en)) return K.serce;
  if (/lung/.test(en)) return K.pluco;
  if (/liver/.test(en)) return K.watroba;
  if (/stomach/.test(en)) return K.zoladek;
  if (/spleen/.test(en)) return K.sledziona;
  if (/kidney|adrenal/.test(en)) return K.nerka;
  if (/colon|rectum/.test(en)) return K.jelitoGrube;
  if (/duodenum|jejunum|ileum/.test(en)) return K.jelito;
  if (/bladder|ureter/.test(en)) return /gall/.test(en) ? [110, 160, 70] : K.pecherz;
  if (/trachea|bronchus/.test(en)) return K.tchawica;
  if (/esophagus/.test(en)) return K.przelyk;
  if (/pancreas/.test(en)) return [236, 200, 130];
  if (/thymus/.test(en)) return [230, 180, 190];
  if (/penis|testis|epididymis|seminal vesicle|deferent duct|prostate|urethra/.test(en)) return [226, 168, 150];
  return K.inne;
}

// Zwraca null (pomiń) albo { warstwa, typ, kolor, cel: [udział, min, max] trójkątów }.
export function klasyfikuj(id, en) {
  if (POMIN.test(en)) return null;
  if (en === 'skin') return { warstwa: 'skora', typ: 'skora', kolor: K.skora, cel: [0.06, 1000, 96000] };
  if (en === 'ear') return { warstwa: 'skora', typ: 'skora', kolor: K.skora, cel: [0.25, 400, 3000] };
  if (en === 'set of nasal cartilages') return { warstwa: 'kosci', typ: 'chrzastka', kolor: K.chrzastka, cel: [0.3, 300, 2000] };
  if (en === 'eyeball') return { warstwa: 'oczy', typ: 'oko', kolor: K.oko, cel: [0.3, 500, 5000] };
  if (/intervertebral disk/.test(en)) return { warstwa: 'kosci', typ: 'krazek', kolor: K.krazek, cel: [0.12, 200, 900] };
  if (/cartilage/.test(en)) return { warstwa: 'kosci', typ: 'chrzastka', kolor: K.chrzastka, cel: [0.3, 300, 3000] };
  if (NACZYNIA.test(en)) {
    const zyla = /vein|vena|sinus/.test(en);
    return { warstwa: 'naczynia', typ: zyla ? 'zyla' : 'tetnica', kolor: zyla ? K.zyla : K.tetnica, cel: [0.3, 200, 7000] };
  }
  if (NARZADY.test(en)) return { warstwa: 'narzady', typ: 'narzad', kolor: kolorNarzadu(en), cel: [0.4, 600, 12000] };
  if (KOSC.test(en)) {
    let cel = [0.3, 300, 8000];
    let typ = 'kosc';
    let kolor = K.kosc;
    if (/tooth/.test(en)) { cel = [0.12, 200, 700]; typ = 'zab'; kolor = K.zab; }
    else if (/\brib$/.test(en)) cel = [0.14, 400, 4500];
    else if (/vertebra|atlas|axis/.test(en)) cel = [0.3, 400, 3200];
    else if (/scapula/.test(en)) cel = [0.1, 400, 9000];
    else if (/sacrum|hip bone/.test(en)) cel = [0.5, 400, 9000];
    else if (/frontal|parietal|occipital|temporal|sphenoid|mandible|maxilla/.test(en)) cel = [0.35, 400, 11000];
    else if (/phalanx|metacarpal|metatarsal|scaphoid|lunate|triquetral|pisiform|trapezi|trapezoid|capitate|hamate|cuneiform|cuboid|navicular|sesamoid/.test(en)) cel = [0.5, 160, 1400];
    return { warstwa: 'kosci', typ, kolor, cel };
  }
  if (MOZG.test(en)) {
    let kolor = K.mozg;
    if (/cerebell/.test(en)) kolor = K.mozdzek;
    else if (/pons|medulla|midbrain|peduncle/.test(en)) kolor = K.pien;
    else if (/optic/.test(en)) kolor = [240, 220, 150];
    const glebokie = /thalamus|caudate|putamen|pallidus|amygdala|hippocampus|fornix|corpus callosum|ventricle|colliculus|pineal|pituitary|mammillary|aqueduct|insula/.test(en);
    return { warstwa: 'mozg', typ: glebokie ? 'mozgGleboki' : 'mozg', kolor, cel: glebokie ? [0.1, 150, 2000] : [0.2, 300, 6000] };
  }
  if (SCIEGNO.test(en)) return { warstwa: 'miesnie', typ: 'sciegno', kolor: K.sciegno, cel: [0.03, 200, 5000] };
  return { warstwa: 'miesnie', typ: 'miesien', kolor: K.miesien, cel: [0.035, 200, 5500] };
}

const strona = (en) => (/\bleft\b/.test(en) ? 'L' : /\bright\b/.test(en) ? 'P' : null);
const NAZWY_PALCOW = { thumb: 'kciuk', 'index finger': 'wskazujacy', 'middle finger': 'srodkowy', 'ring finger': 'serdeczny', 'little finger': 'maly' };
const NUMERY = { first: 'kciuk', second: 'wskazujacy', third: 'srodkowy', fourth: 'serdeczny', fifth: 'maly' };

// Przypisanie kości (i chrząstek) do rigu po nazwie. Zwraca nazwę kości rigu,
// albo 'szyja' / 'ledzwie' (mieszanie po wysokości), albo null, gdy część ma dostać wagi jak tkanka miękka.
export function kostRigu(en) {
  const s = strona(en);
  if (/mandible|lower .*tooth/.test(en)) return 'zuchwa';
  if (/tooth|frontal bone|parietal bone|occipital bone|temporal bone|sphenoid|ethmoid|maxilla|zygomatic|nasal bone|lacrimal|palatine|vomer|nasal concha|nasal cartilages/.test(en)) return 'glowa';
  if (/hyoid|thyroid cartilage/.test(en)) return 'szyja';
  if (/cervical vertebra|^atlas$|^axis$|disk of axis/.test(en)) return 'szyja';
  if (/lumbar vertebra|(eleventh|twelfth) thoracic vertebra/.test(en)) return 'ledzwie';
  if (/thoracic vertebra|\brib$|costal cartilage|sternum|manubrium|xiphoid|clavicle|scapula/.test(en)) return 'klatka';
  if (/sacrum|hip bone/.test(en)) return 'miednica';
  if (/humerus/.test(en)) return 'ramie' + s;
  if (/radius$/.test(en)) return 'promien' + s;
  if (/ulna$/.test(en)) return 'przedramie' + s;
  if (/scaphoid|lunate|triquetral|pisiform|trapezium|trapezoid|capitate|hamate/.test(en)) return 'dlon' + s;
  let m = en.match(/(first|second|third|fourth|fifth) metacarpal/);
  if (m) return `srodrecze_${NUMERY[m[1]]}${s}`;
  m = en.match(/(proximal|middle|distal) phalanx of (left |right )?(thumb|index finger|middle finger|ring finger|little finger)/);
  if (m) {
    const czlon = { proximal: 'blizszy', middle: 'srodkowyp', distal: 'dalszy' }[m[1]];
    return `${czlon}_${NAZWY_PALCOW[m[3]]}${s}`;
  }
  if (/femur/.test(en)) return 'udo' + s;
  if (/tibia$|fibula$|patella/.test(en)) return 'podudzie' + s;
  if (/calcaneus|talus|navicular|cuboid|cuneiform|metatarsal|toe|sesamoid bone of (left|right) foot/.test(en)) return 'stopa' + s;
  return null;
}
