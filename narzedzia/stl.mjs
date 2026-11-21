// Czytanie plików STL z BodyParts3D i zamiana na siatkę z indeksami.
// Układ spoczynkowy aplikacji: X = lewa strona człowieka, Y = góra, Z = przód (mm).
// BodyParts3D ma x = lewa strona, y = tył, z = góra, więc (X, Y, Z) = (x, z, -y).
import fs from 'node:fs';

export function wczytajStl(sciezka) {
  const buf = fs.readFileSync(sciezka);
  const n = buf.readUInt32LE(80);
  if (84 + n * 50 !== buf.length) throw new Error('To nie jest binarny STL: ' + sciezka);
  const mapa = new Map();
  const poz = [];
  const ind = new Uint32Array(n * 3);
  let off = 84;
  let ileTr = 0;
  for (let t = 0; t < n; t++) {
    off += 12;
    const tr = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const x = buf.readFloatLE(off);
      const y = buf.readFloatLE(off + 4);
      const z = buf.readFloatLE(off + 8);
      // klucz z bitów trzech liczb: wierzchołki wspólne są w STL identyczne co do bitu
      const klucz = buf.toString('latin1', off, off + 12);
      off += 12;
      let i = mapa.get(klucz);
      if (i === undefined) {
        i = poz.length / 3;
        mapa.set(klucz, i);
        poz.push(x, z, -y);
      }
      tr[k] = i;
    }
    off += 2;
    if (tr[0] === tr[1] || tr[1] === tr[2] || tr[0] === tr[2]) continue;
    ind[ileTr * 3] = tr[0];
    ind[ileTr * 3 + 1] = tr[1];
    ind[ileTr * 3 + 2] = tr[2];
    ileTr++;
  }
  return { poz: new Float32Array(poz), ind: ind.slice(0, ileTr * 3) };
}

export function ramka(poz) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  const sr = [0, 0, 0];
  const n = poz.length / 3;
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = poz[i * 3 + k];
      if (v < mn[k]) mn[k] = v;
      if (v > mx[k]) mx[k] = v;
      sr[k] += v;
    }
  }
  return { mn, mx, sr: sr.map((v) => v / n), n };
}
