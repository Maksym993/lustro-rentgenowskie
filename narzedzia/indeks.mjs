// Indeks wszystkich części: nazwa, liczba trójkątów, ramka i środek w układzie spoczynkowym.
import fs from 'node:fs';
import path from 'node:path';
import { wczytajStl, ramka } from './stl.mjs';
const kat = 'surowe/bp3d-3.0';
const nazwy = {};
for (const l of fs.readFileSync(path.join(kat, 'parts_list_e.txt'), 'latin1').split('\n')) {
  const p = l.trim().split('\t');
  if (p.length >= 2) nazwy[p[0]] = p[1];
}
const wyn = {};
const pliki = fs.readdirSync(kat).filter((f) => f.endsWith('.stl')).sort();
let i = 0;
for (const f of pliki) {
  const id = f.slice(0, -4);
  const m = wczytajStl(path.join(kat, f));
  const r = ramka(m.poz);
  wyn[id] = { en: nazwy[id] || '?', tr: m.ind.length / 3, w: r.n, mn: r.mn.map((v) => +v.toFixed(1)), mx: r.mx.map((v) => +v.toFixed(1)), sr: r.sr.map((v) => +v.toFixed(1)) };
  if (++i % 100 === 0) console.log(i, '/', pliki.length);
}
fs.writeFileSync('surowe/indeks-3.0.json', JSON.stringify(wyn));
let suma = 0; for (const k in wyn) suma += wyn[k].tr;
console.log('części', Object.keys(wyn).length, 'trójkątów razem', suma);
