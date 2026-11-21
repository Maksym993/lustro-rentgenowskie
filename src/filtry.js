// Filtry czasowe: wygładzają drgania punktów śledzenia.
const alfaZ = (odciecie, dt) => {
  const tau = 1 / (2 * Math.PI * odciecie);
  return 1 / (1 + tau / dt);
};

class Dolnoprzepustowy {
  constructor() {
    this.y = null;
  }
  filtruj(x, alfa) {
    this.y = this.y === null ? x : this.y + alfa * (x - this.y);
    return this.y;
  }
}

// Filtr „One Euro” dla jednej liczby: przy powolnym ruchu wygładza mocno, przy szybkim prawie nie opóźnia.
export class FiltrEuro {
  constructor(minOdciecie = 1.5, beta = 0.01, odciecieD = 1) {
    this.min = minOdciecie;
    this.beta = beta;
    this.dOdc = odciecieD;
    this.fx = new Dolnoprzepustowy();
    this.fd = new Dolnoprzepustowy();
    this.poprz = null;
  }
  filtruj(x, dt) {
    if (!(dt > 0)) dt = 1 / 30;
    const dx = this.poprz === null ? 0 : (x - this.poprz) / dt;
    this.poprz = x;
    const d = this.fd.filtruj(dx, alfaZ(this.dOdc, dt));
    return this.fx.filtruj(x, alfaZ(this.min + this.beta * Math.abs(d), dt));
  }
  zeruj() {
    this.fx.y = null;
    this.fd.y = null;
    this.poprz = null;
  }
}

// Wygładzanie zestawu punktów [x, y, z]. Prędkość każdego punktu przychodzi z zewnątrz: bufor liczy ją z kilku
// klatek wokół wyświetlanej i odejmuje od niej szum samego śledzenia. Dzięki temu filtr otwiera się w chwili,
// w której zaczyna się prawdziwy ruch, a drżenie punktów go nie otwiera. Głębia (z) ma osobne, mocniejsze wygładzanie.
export class FiltrPunktowOdporny {
  constructor({ min = 1.2, beta = 0.05, minZ = 0.5, betaZ = 0.004 } = {}) {
    this.min = min;
    this.beta = beta;
    this.minZ = minZ;
    this.betaZ = betaZ;
    this.y = null;
  }
  filtruj(punkty, predkosc, dt) {
    if (!(dt > 0)) dt = 1 / 30;
    if (!this.y || this.y.length !== punkty.length) {
      this.y = punkty.map((p) => [p[0], p[1], p[2]]);
      return this.y.map((p) => [p[0], p[1], p[2]]);
    }
    const wyn = new Array(punkty.length);
    for (let i = 0; i < punkty.length; i++) {
      const v = predkosc ? predkosc[i] : 0;
      const a = alfaZ(this.min + this.beta * v, dt);
      const az = alfaZ(this.minZ + this.betaZ * v, dt);
      const y = this.y[i];
      const x = punkty[i];
      y[0] += a * (x[0] - y[0]);
      y[1] += a * (x[1] - y[1]);
      y[2] += az * (x[2] - y[2]);
      wyn[i] = [y[0], y[1], y[2]];
    }
    return wyn;
  }
  zeruj() {
    this.y = null;
  }
}

// Różnica, która ma zniknąć płynnie: po nagłej zmianie źródła zapamiętujemy, o ile nowa wartość różni się od starej,
// i tę różnicę wygaszamy w krótkim czasie. Obraz nie przeskakuje, tylko dojeżdża.
export class Zanik {
  constructor(czas = 0.3) {
    this.czas = czas;
    this.roznica = null;
    this.u = 0;
  }
  // wywołać w chwili przełączenia: stara i nowa to tablice liczb tej samej długości
  przelacz(stara, nowa) {
    this.roznica = stara.map((v, i) => v - nowa[i]);
    this.u = 1;
  }
  krok(dt) {
    if (this.u > 0) this.u = Math.max(0, this.u - dt / this.czas);
  }
  zastosuj(nowa) {
    if (!(this.u > 0) || !this.roznica) return nowa;
    const w = this.u * this.u * (3 - 2 * this.u);
    return nowa.map((v, i) => v + this.roznica[i] * w);
  }
  zeruj() {
    this.u = 0;
    this.roznica = null;
  }
}
