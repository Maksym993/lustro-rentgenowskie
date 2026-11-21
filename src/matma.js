// Matematyka wspólna dla skryptu budującego anatomię (Node) i dla aplikacji (przeglądarka).
// Bez zależności: wektory to zwykłe tablice [x, y, z], macierze 4x4 to Float32Array(16) kolumnami.

export const dodaj = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const odejmij = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const razy = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const iloczyn = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const wektorowy = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dlugosc = (a) => Math.hypot(a[0], a[1], a[2]);
export const odleglosc = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const mieszaj = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export function jednostkowy(a, zapas = [1, 0, 0]) {
  const d = dlugosc(a);
  return d > 1e-9 ? [a[0] / d, a[1] / d, a[2] / d] : zapas.slice();
}
// część wektora a prostopadła do jednostkowego n
export const prostopadly = (a, n) => odejmij(a, razy(n, iloczyn(a, n)));
export const ogranicz = (v, a, b) => Math.min(b, Math.max(a, v));
export function gladki(a, b, x) {
  const t = ogranicz((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// Wartości i wektory własne macierzy symetrycznej n x n metodą Jacobiego.
function jacobi(A, n) {
  const V = [];
  for (let i = 0; i < n; i++) {
    V.push(new Array(n).fill(0));
    V[i][i] = 1;
  }
  for (let obieg = 0; obieg < 60; obieg++) {
    let poza = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) poza += A[i][j] * A[i][j];
    if (poza < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p];
          const akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k];
          const aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p];
          const vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { wartosci: A.map((w, i) => w[i]), wektory: V };
}

// Osie główne chmury punktów (Float32Array xyz albo tablica wektorów): środek i trzy osie od najdłuższej.
export function osieGlowne(poz) {
  const n = poz.length / 3;
  const c = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    c[0] += poz[i * 3];
    c[1] += poz[i * 3 + 1];
    c[2] += poz[i * 3 + 2];
  }
  c[0] /= n;
  c[1] /= n;
  c[2] /= n;
  const C = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < n; i++) {
    const d = [poz[i * 3] - c[0], poz[i * 3 + 1] - c[1], poz[i * 3 + 2] - c[2]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += d[a] * d[b];
  }
  const { wartosci, wektory } = jacobi(C, 3);
  const kol = [0, 1, 2].sort((a, b) => wartosci[b] - wartosci[a]);
  const osie = kol.map((k) => [wektory[0][k], wektory[1][k], wektory[2][k]]);
  return { srodek: c, osie, wariancje: kol.map((k) => wartosci[k] / n) };
}

// Dopasowanie podobieństwa (obrót, jedna skala, przesunięcie) metodą Horna:
// szuka s, R, t takich, że cel ≈ s * R * zrodlo + t. Punkty to tablice wektorów, wagi opcjonalne.
// Zwraca kwaternion q = [x, y, z, w], skalę i przesunięcie.
export function dopasujPodobienstwo(zrodlo, cel, wagi = null, zeSkala = true) {
  const n = zrodlo.length;
  let sw = 0;
  const cs = [0, 0, 0];
  const cc = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const w = wagi ? wagi[i] : 1;
    sw += w;
    for (let k = 0; k < 3; k++) {
      cs[k] += zrodlo[i][k] * w;
      cc[k] += cel[i][k] * w;
    }
  }
  for (let k = 0; k < 3; k++) {
    cs[k] /= sw;
    cc[k] /= sw;
  }
  const M = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  let sumaZr = 0;
  for (let i = 0; i < n; i++) {
    const w = wagi ? wagi[i] : 1;
    const a = [zrodlo[i][0] - cs[0], zrodlo[i][1] - cs[1], zrodlo[i][2] - cs[2]];
    const b = [cel[i][0] - cc[0], cel[i][1] - cc[1], cel[i][2] - cc[2]];
    sumaZr += w * (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) M[r][c] += w * a[r] * b[c];
  }
  const [Sxx, Sxy, Sxz] = M[0];
  const [Syx, Syy, Syz] = M[1];
  const [Szx, Szy, Szz] = M[2];
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const { wartosci, wektory } = jacobi(N, 4);
  let naj = 0;
  for (let i = 1; i < 4; i++) if (wartosci[i] > wartosci[naj]) naj = i;
  let q = [wektory[1][naj], wektory[2][naj], wektory[3][naj], wektory[0][naj]];
  const dq = Math.hypot(q[0], q[1], q[2], q[3]);
  q = q.map((v) => v / dq);
  if (q[3] < 0) q = q.map((v) => -v);
  const R = obrotZKwaternionu(q);
  let skala = 1;
  if (zeSkala) {
    let licz = 0;
    for (let i = 0; i < n; i++) {
      const w = wagi ? wagi[i] : 1;
      const a = [zrodlo[i][0] - cs[0], zrodlo[i][1] - cs[1], zrodlo[i][2] - cs[2]];
      const b = [cel[i][0] - cc[0], cel[i][1] - cc[1], cel[i][2] - cc[2]];
      const ra = mnozR(R, a);
      licz += w * (ra[0] * b[0] + ra[1] * b[1] + ra[2] * b[2]);
    }
    skala = licz / Math.max(sumaZr, 1e-12);
  }
  const rcs = mnozR(R, cs);
  const t = [cc[0] - skala * rcs[0], cc[1] - skala * rcs[1], cc[2] - skala * rcs[2]];
  return { q, skala, t, R };
}

// macierz obrotu 3x3 (wierszami) z kwaternionu [x, y, z, w]
export function obrotZKwaternionu(q) {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}
export const mnozR = (R, v) => [
  R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
  R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
  R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
];

// kwaternion z trzech osi układu (kolumny macierzy obrotu)
export function kwaternionZOsi(x, y, z) {
  const m00 = x[0], m10 = x[1], m20 = x[2];
  const m01 = y[0], m11 = y[1], m21 = y[2];
  const m02 = z[0], m12 = z[1], m22 = z[2];
  const slad = m00 + m11 + m22;
  let q;
  if (slad > 0) {
    const s = 0.5 / Math.sqrt(slad + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return q;
}

export function slerp(a, b, t) {
  let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (cos < 0) {
    cos = -cos;
    bb = b.map((v) => -v);
  }
  if (cos > 0.9995) {
    const q = [0, 1, 2, 3].map((i) => a[i] + (bb[i] - a[i]) * t);
    const d = Math.hypot(...q);
    return q.map((v) => v / d);
  }
  const kat = Math.acos(cos);
  const s = Math.sin(kat);
  const wa = Math.sin((1 - t) * kat) / s;
  const wb = Math.sin(t * kat) / s;
  return [0, 1, 2, 3].map((i) => a[i] * wa + bb[i] * wb);
}

// obrót o kąt wokół jednostkowej osi, jako macierz 3x3 wierszami
export function obrotWokolOsi(os, kat) {
  const [x, y, z] = os;
  const c = Math.cos(kat);
  const s = Math.sin(kat);
  const t = 1 - c;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

// --- macierze 4x4 (kolumnami, jak w WebGL) ---
export function m4Jednostkowa(out = new Float32Array(16)) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}
// M = T(t) * L, gdzie L to macierz 3x3 podana wierszami
export function m4ZLiniowej(L, t, out = new Float32Array(16)) {
  out[0] = L[0][0]; out[1] = L[1][0]; out[2] = L[2][0]; out[3] = 0;
  out[4] = L[0][1]; out[5] = L[1][1]; out[6] = L[2][1]; out[7] = 0;
  out[8] = L[0][2]; out[9] = L[1][2]; out[10] = L[2][2]; out[11] = 0;
  out[12] = t[0]; out[13] = t[1]; out[14] = t[2]; out[15] = 1;
  return out;
}
export function m4Mnoz(a, b, out = new Float32Array(16)) {
  const w = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      w[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  out.set(w);
  return out;
}
export function m4Punkt(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}
export function m4Kierunek(m, p) {
  return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2], m[1] * p[0] + m[5] * p[1] + m[9] * p[2], m[2] * p[0] + m[6] * p[1] + m[10] * p[2]];
}
// iloczyn macierzy 3x3 podanych wierszami
export function m3Mnoz(A, B) {
  const C = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] = A[r][0] * B[0][c] + A[r][1] * B[1][c] + A[r][2] * B[2][c];
  return C;
}
export const m3Transp = (A) => [
  [A[0][0], A[1][0], A[2][0]],
  [A[0][1], A[1][1], A[2][1]],
  [A[0][2], A[1][2], A[2][2]],
];
// macierz 3x3 (wierszami) z trzech kolumn
export const m3ZKolumn = (x, y, z) => [
  [x[0], y[0], z[0]],
  [x[1], y[1], z[1]],
  [x[2], y[2], z[2]],
];

// Przekształcenie odcinka: układ spoczynkowy (początek a0, osie B0 jako kolumny x, y, z) przechodzi
// w układ bieżący (początek a, osie B), ze skalami wzdłuż trzech osi własnych. Wynik to macierz 4x4.
export function m4Odcinka(a0, B0, a, B, skale, out = new Float32Array(16)) {
  const S = [
    [skale[0], 0, 0],
    [0, skale[1], 0],
    [0, 0, skale[2]],
  ];
  const L = m3Mnoz(m3Mnoz(m3ZKolumn(B[0], B[1], B[2]), S), m3Transp(m3ZKolumn(B0[0], B0[1], B0[2])));
  const La0 = mnozR(L, a0);
  return m4ZLiniowej(L, [a[0] - La0[0], a[1] - La0[1], a[2] - La0[2]], out);
}

// układ osi z kierunku głównego (oś y) i wektora odniesienia (przybliżona oś x)
export function ukladZOsi(y, odniesienieX) {
  const yy = jednostkowy(y, [0, 1, 0]);
  let xx = prostopadly(odniesienieX, yy);
  if (dlugosc(xx) < 1e-6) xx = prostopadly(Math.abs(yy[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1], yy);
  xx = jednostkowy(xx);
  const zz = wektorowy(xx, yy);
  return [xx, yy, zz];
}

// --- kwaterniony [x, y, z, w] ---
// złożenie obrotów: R(qMnoz(a, b)) = R(a) * R(b)
export function qMnoz(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
export const qSprzezony = (q) => [-q[0], -q[1], -q[2], q[3]];
// iloczyn transpozycji macierzy obrotu (wierszami) przez wektor
export const mnozRT = (R, v) => [
  R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2],
  R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2],
  R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2],
];

// odwrotność macierzy 4x4 przekształcenia afinicznego (ostatni wiersz 0 0 0 1); null, gdy macierz jest osobliwa
export function m4OdwrotnaAfiniczna(m, out = new Float32Array(16)) {
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const wyzn = a * A + b * B + c * C;
  if (!(Math.abs(wyzn) > 1e-12)) return null;
  const s = 1 / wyzn;
  const o00 = A * s, o01 = (c * h - b * i) * s, o02 = (b * f - c * e) * s;
  const o10 = B * s, o11 = (a * i - c * g) * s, o12 = (c * d - a * f) * s;
  const o20 = C * s, o21 = (b * g - a * h) * s, o22 = (a * e - b * d) * s;
  const tx = m[12], ty = m[13], tz = m[14];
  out[0] = o00; out[1] = o10; out[2] = o20; out[3] = 0;
  out[4] = o01; out[5] = o11; out[6] = o21; out[7] = 0;
  out[8] = o02; out[9] = o12; out[10] = o22; out[11] = 0;
  out[12] = -(o00 * tx + o01 * ty + o02 * tz);
  out[13] = -(o10 * tx + o11 * ty + o12 * tz);
  out[14] = -(o20 * tx + o21 * ty + o22 * tz);
  out[15] = 1;
  return out;
}
